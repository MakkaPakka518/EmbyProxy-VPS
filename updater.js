'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DEFAULT_ALLOW = ['server.js', 'panel.html', 'tg-persona.js', 'updater.js', 'install.sh', 'README.md', 'VERSION'];
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_EXTRACTED = 256 * 1024 * 1024;

function validVersion(value) {
  const v = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(v)) throw new Error('VERSION 格式无效');
  return v;
}

function versionTuple(value) {
  const base = String(value || '').split(/[-+]/, 1)[0];
  const out = base.split('.').slice(0, 3).map(x => Number.parseInt(x, 10) || 0);
  while (out.length < 3) out.push(0);
  return out;
}

function newer(a, b) {
  const x = versionTuple(a), y = versionTuple(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function safeName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  if (!n || n.startsWith('/') || n.includes('\0')) return false;
  return !n.split('/').some(part => part === '..');
}

function walkSafe(root) {
  let total = 0;
  const visit = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw new Error('压缩包包含不安全文件: ' + ent.name);
      if (st.isFile()) {
        total += st.size;
        if (total > MAX_EXTRACTED) throw new Error('解压内容过大');
      } else visit(full);
    }
  };
  visit(root);
  return total;
}

async function responseBuffer(response, limit) {
  if (!response || !response.ok) throw new Error('下载失败: HTTP ' + (response ? response.status : 0));
  const len = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
  if (len > limit) throw new Error('下载内容过大');
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > limit) throw new Error('下载内容过大');
    return buf;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      try { await reader.cancel(); } catch (_) {}
      throw new Error('下载内容过大');
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks, size);
}

function createUpdater(options) {
  const baseDir = path.resolve(options.baseDir);
  const dataDir = path.resolve(options.dataDir);
  const repo = options.repo;
  const branch = options.branch || 'main';
  const service = options.service || 'emby-proxy';
  const fetchFn = options.fetchFn || global.fetch;
  const allow = options.allowlist || DEFAULT_ALLOW;
  const stateFile = path.join(dataDir, 'update-state.json');
  const lockFile = path.join(dataDir, 'update.lock');
  const current = () => {
    try { return validVersion(fs.readFileSync(path.join(baseDir, 'VERSION'), 'utf8')); }
    catch (_) { return validVersion(options.currentVersion || '0.0.0'); }
  };
  let state = {
    running: false, ok: null, current: current(), latest: null, latestCommit: null,
    available: false, phase: '', log: [], checkedAt: 0, startedAt: 0,
    restartNeeded: false, restartIssued: false
  };
  try {
    const old = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    state = Object.assign(state, old, { running: false, current: current() });
  } catch (_) {}
  let runPromise = null;

  const save = fields => {
    state = Object.assign(state, fields || {});
    atomicJSON(stateFile, state);
  };
  const log = message => {
    state.log = (state.log || []).concat(new Date().toISOString().slice(11, 19) + '  ' + message).slice(-120);
    save();
  };
  const snapshot = () => JSON.parse(JSON.stringify(Object.assign({}, state, { current: current() })));

  async function getText(url, limit = 1024 * 1024) {
    const response = await fetchFn(url, { headers: { 'User-Agent': 'emby-proxy-updater' }, cache: 'no-store' });
    return (await responseBuffer(response, limit)).toString('utf8');
  }

  async function resolveCommit() {
    const api = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`;
    try {
      const info = JSON.parse(await getText(api));
      const commit = String(info.sha || '');
      if (/^[0-9a-f]{40}$/.test(commit)) return commit;
    } catch (_) {
      // GitHub API 未登录额度很低；失败后改读公开 Atom，不影响固定 commit 校验。
    }
    const atom = await getText(`https://github.com/${repo}/commits/${encodeURIComponent(branch)}.atom`, 2 * 1024 * 1024);
    const match = atom.match(/Grit::Commit\/([0-9a-f]{40})/i);
    if (!match) throw new Error('GitHub 返回的 commit 无效');
    return match[1].toLowerCase();
  }

  async function check() {
    if (state.running) return snapshot();
    const commit = await resolveCommit();
    const version = validVersion(await getText(`https://raw.githubusercontent.com/${repo}/${commit}/VERSION`, 4096));
    save({ current: current(), latest: version, latestCommit: commit, available: newer(version, current()), checkedAt: Date.now(), ok: null });
    return snapshot();
  }

  function acquireLock() {
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = true;
      try {
        const pid = Number(fs.readFileSync(lockFile, 'utf8'));
        if (pid > 1) { process.kill(pid, 0); stale = false; }
      } catch (e) { if (e.code === 'EPERM') stale = false; }
      if (!stale) throw new Error('更新正在运行');
      try { fs.unlinkSync(lockFile); } catch (_) {}
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      return fd;
    }
  }

  function releaseLock(fd) {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockFile); } catch (_) {}
  }

  function validateArchiveList(archive) {
    const result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('压缩包校验失败: ' + String(result.stderr || '').trim());
    const names = result.stdout.split('\n').filter(Boolean);
    if (!names.length || names.length > 20000) throw new Error('压缩包文件列表异常');
    for (const name of names) if (!safeName(name)) throw new Error('压缩包路径不安全: ' + name);
    return names;
  }

  async function runUpdate(force) {
    let lockFd = null;
    let tempDir = null;
    let backupDir = null;
    const existed = new Set();
    try {
      lockFd = acquireLock();
      save({ running: true, ok: null, phase: '检查版本', startedAt: Date.now(), restartNeeded: false, restartIssued: false, log: [] });
      log('固定 GitHub main 提交并检查版本');
      await checkDuringRun();
      if (!state.available && !force) {
        log('当前已经是最新版');
        save({ running: false, ok: true, phase: '已是最新版' });
        return;
      }

      save({ phase: '下载代码' });
      const commit = state.latestCommit;
      const archiveUrl = `https://codeload.github.com/${repo}/tar.gz/${commit}`;
      const response = await fetchFn(archiveUrl, { headers: { 'User-Agent': 'emby-proxy-updater' }, cache: 'no-store' });
      const blob = await responseBuffer(response, MAX_ARCHIVE);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-proxy-update-'));
      const archive = path.join(tempDir, 'source.tar.gz');
      fs.writeFileSync(archive, blob, { mode: 0o600 });
      validateArchiveList(archive);

      save({ phase: '校验代码' });
      const extractDir = path.join(tempDir, 'extract');
      fs.mkdirSync(extractDir, { mode: 0o700 });
      const result = spawnSync('tar', ['-xzf', archive, '-C', extractDir, '--no-same-owner', '--no-same-permissions'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (result.status !== 0) throw new Error('解压失败: ' + String(result.stderr || '').trim());
      walkSafe(extractDir);
      const roots = fs.readdirSync(extractDir, { withFileTypes: true }).filter(x => x.isDirectory());
      if (roots.length !== 1) throw new Error('压缩包根目录异常');
      const sourceRoot = path.join(extractDir, roots[0].name);
      const remoteVersion = validVersion(fs.readFileSync(path.join(sourceRoot, 'VERSION'), 'utf8'));
      if (remoteVersion !== state.latest) throw new Error('固定 commit 的 VERSION 与检查结果不一致');
      for (const name of ['server.js', 'panel.html', 'updater.js', 'VERSION']) {
        const st = fs.lstatSync(path.join(sourceRoot, name));
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('缺少必要文件: ' + name);
      }

      save({ phase: '备份当前版本' });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      backupDir = path.join(dataDir, 'update-backup-' + stamp);
      fs.mkdirSync(backupDir, { recursive: false, mode: 0o700 });
      for (const name of allow) {
        const src = path.join(baseDir, name);
        if (!fs.existsSync(src)) continue;
        const st = fs.lstatSync(src);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('本地文件不安全: ' + name);
        existed.add(name);
        fs.copyFileSync(src, path.join(backupDir, name));
      }

      save({ phase: '替换文件' });
      const replaced = [];
      try {
        for (const name of allow) {
          const src = path.join(sourceRoot, name);
          if (!fs.existsSync(src)) continue;
          const st = fs.lstatSync(src);
          if (!st.isFile() || st.isSymbolicLink()) throw new Error('更新文件不安全: ' + name);
          const tmp = path.join(baseDir, '.' + name + '.update-' + process.pid);
          fs.copyFileSync(src, tmp);
          fs.chmodSync(tmp, name === 'install.sh' ? 0o755 : 0o644);
          fs.renameSync(tmp, path.join(baseDir, name));
          replaced.push(name);
        }
      } catch (error) {
        for (const name of replaced.reverse()) {
          const dst = path.join(baseDir, name);
          const backup = path.join(backupDir, name);
          if (existed.has(name)) fs.copyFileSync(backup, dst);
          else try { fs.unlinkSync(dst); } catch (_) {}
        }
        throw error;
      }

      log(`已更新到 ${remoteVersion}，备份：${path.basename(backupDir)}`);
      save({ running: false, ok: true, current: remoteVersion, available: false, phase: '更新完成', restartNeeded: true });
      if (typeof options.onUpdated === 'function') {
        try {
          const issued = await options.onUpdated(snapshot());
          save({ restartIssued: issued !== false });
        } catch (error) {
          log('自动重启未执行，请手动重启服务: ' + error.message);
        }
      }
    } catch (error) {
      log('更新失败: ' + (error && error.message ? error.message : String(error)));
      save({ running: false, ok: false, phase: '更新失败', restartNeeded: false });
    } finally {
      if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      if (lockFd !== null) releaseLock(lockFd);
      runPromise = null;
    }
  }

  async function checkDuringRun() {
    const commit = await resolveCommit();
    const version = validVersion(await getText(`https://raw.githubusercontent.com/${repo}/${commit}/VERSION`, 4096));
    save({ current: current(), latest: version, latestCommit: commit, available: newer(version, current()), checkedAt: Date.now() });
  }

  function start(force) {
    if (state.running || runPromise) throw new Error('更新正在运行');
    runPromise = Promise.resolve().then(() => runUpdate(Boolean(force)));
    return Object.assign(snapshot(), { accepted: true });
  }

  return { snapshot, check, start, _wait: () => runPromise, _validateArchiveList: validateArchiveList };
}

module.exports = { createUpdater, validVersion, newer, safeName };
