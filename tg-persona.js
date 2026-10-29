/* ================= TG Persona 模块（零依赖 Node） =================
 * VERSION: 1.0.0
 * 由 server.js 动态加载（文件不存在则跳过，不影响原有功能）。
 * 复用 server.js 的 MTProto 内核（TGKIT）与 TG 签到账号体系（tg.json），
 * 提供 TG-Persona 全量能力：关键词自动回复/点表情、群保号定时发言、
 * 签到（点按钮/连点/判定）、抢注监控、抢红包、自定义多步任务、
 * 自动水群、通知推送、时区、拟人化、日志、会话守护。
 *
 * 数据文件：data/persona.json（600 权限）
 */
'use strict';
module.exports = { mount };

function mount(ctx) {
  const fs = ctx.fs, path = ctx.path, crypto = ctx.crypto;
  const { MTProtoClient, TLWriter, TLReader } = ctx;
  const tg = ctx.tg; // 共享 TG 签到状态（账号在此）

  /* ================= 持久化 ================= */
  const P_FILE = path.join(ctx.dataDir, 'persona.json');
  const P_DEF = {
    settings: {
      enabled: true,
      accountId: '',
      tz: 'Asia/Shanghai',
      watcherSec: 4,
      delayMin: 1000, delayMax: 3000,
      coolSec: 20,
      keepLogDays: 30, maxLogs: 3000,
      water: { enabled: false, windowMin: 5, count: 5, replies: '确实||哈哈||有道理' },
      notify: { bark: '', tgBot: '', okOn: false, failOn: true },
      ocr: { base: '', key: '', model: '' },
      sessionGuard: true
    },
    rules: [],
    keepalive: [],
    tasks: [],
    chats: [],   // { id, title, kind, peer(b64 inputPeer), monitored, lastMinId }
    logs: [],
    guard: { warned: false, lastPing: 0 },
    updatedAt: 0
  };
  function loadP() {
    let p = null;
    try { p = JSON.parse(fs.readFileSync(P_FILE, 'utf8')); } catch (e) { p = JSON.parse(JSON.stringify(P_DEF)); }
    const d = P_DEF;
    p.settings = Object.assign({}, d.settings, p.settings || {});
    p.settings.water = Object.assign({}, d.settings.water, (p.settings && p.settings.water) || {});
    p.settings.notify = Object.assign({}, d.settings.notify, (p.settings && p.settings.notify) || {});
    p.settings.ocr = Object.assign({}, d.settings.ocr, (p.settings && p.settings.ocr) || {});
    for (const k of ['rules', 'keepalive', 'tasks', 'chats', 'logs']) p[k] = Array.isArray(p[k]) ? p[k] : [];
    p.guard = Object.assign({ warned: false, lastPing: 0 }, p.guard || {});
    return p;
  }
  let P = loadP();
  function persistP() {
    P.updatedAt = Date.now();
    try { fs.writeFileSync(P_FILE, JSON.stringify(P, null, 1)); fs.chmodSync(P_FILE, 0o600); } catch (e) { try { fs.writeFileSync(P_FILE, JSON.stringify(P)); } catch (e2) {} }
  }

  /* ================= 基础工具 ================= */
  const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  function uid(pre) { return (pre || 'p') + '_' + crypto.randomBytes(5).toString('hex'); }
  function nowInTz(tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
      const g = (t) => { const v = parts.find(x => x.type === t); return v ? v.value : '0'; };
      return { y: +g('year'), m: +g('month'), d: +g('day'), h: +g('hour'), mi: +g('minute'), s: +g('second'), dow: new Date().getDay() };
    } catch (e) { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), dow: d.getDay() }; }
  }
  function dateKeyOf(n) { const p = (v) => String(v).padStart(2, '0'); return p(n.m) + '-' + p(n.d); }
  function renderPlaceholders(s, extra) {
    extra = extra || {};
    return String(s || '')
      .replace(/\{num:(\d+)\}/g, (m, n) => { let r = ''; for (let i = 0; i < +n; i++) r += randInt(0, 9); return r; })
      .replace(/\{word:(\d+)\}/g, (m, n) => { const A = 'abcdefghijklmnopqrstuvwxyz'; let r = ''; for (let i = 0; i < +n; i++) r += A[randInt(0, 25)]; return r; })
      .replace(/\{alpha:(\d+)\}/g, (m, n) => { const A = 'abcdefghijklmnopqrstuvwxyz0123456789'; let r = ''; for (let i = 0; i < +n; i++) r += A[randInt(0, 35)]; return r; })
      .replace(/\{uuid\}/g, () => { const g = (s) => Math.floor(s * 0x10000).toString(16).padStart(4, '0'); const b = crypto.randomBytes(16); return g(b[0] * 256 + b[1]) + g(b[2] * 256 + b[3]) + '-' + g(b[4] * 256 + b[5]) + '-4' + g(b[6] % 16 * 16 + (b[7] >> 4)).slice(0, 3) + '-' + g(b[8] * 256 + b[9]).slice(0, 4) + '-' + g(b[10] * 256 + b[11]) + g(b[12] * 256 + b[13]) + g(b[14] * 256 + b[15]); })
      .replace(/\{code\}/g, () => extra.code || '')
      .replace(/\{time\}/g, () => { const n = nowInTz(P.settings.tz); return String(n.h).padStart(2, '0') + ':' + String(n.mi).padStart(2, '0'); })
      .replace(/\{date\}/g, () => dateKeyOf(nowInTz(P.settings.tz)));
  }
  function randReplies(text) {
    if (!text) return '';
    return pick(String(text).split('||').map(s => s.trim()).filter(Boolean));
  }
  /* 通知：Bark / Telegram Bot（Node 内置 http/https） */
  const http = require('http'), https = require('https');
  function httpPostJson(url, json, timeoutMs) {
    return new Promise((resolve, reject) => {
      let u; try { u = new URL(url); } catch (e) { return reject(e); }
      const mod = u.protocol === 'http:' ? http : https;
      const data = Buffer.from(JSON.stringify(json), 'utf8');
      const req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); });
      req.on('error', reject); req.setTimeout(timeoutMs || 8000, () => req.destroy(new Error('timeout')));
      req.write(data); req.end();
    });
  }
  async function notify(kind, title, text) {
    const n = P.settings.notify;
    if (!n.bark && !n.tgBot) return false;
    const res = [];
    if (n.bark) {
      try {
        await httpPostJson('https://api.day.app/' + encodeURIComponent(n.bark.trim()), { title: '[' + kind + '] ' + title, body: text }, 8000);
        res.push('bark');
      } catch (e) { res.push('bark 失败:' + (e && e.message || e)); }
    }
    if (n.tgBot) {
      const tok = n.tgBot.trim();
      const i = tok.indexOf(':');
      if (i > 0) {
        const chatId = tok.slice(0, i), botToken = tok.slice(i + 1);
        try {
          await httpPostJson('https://api.telegram.org/bot' + botToken + '/sendMessage', { chat_id: chatId, text: '[' + kind + '] ' + title + '\n' + text }, 8000);
          res.push('tgbot');
        } catch (e) { res.push('tgbot 失败:' + (e && e.message || e)); }
      }
    }
    return res;
  }

  /* ================= 日志 ================= */
  function addLog(type, chat, content, ok, detail) {
    P.logs.push({ ts: Date.now(), type, chat: chat || '', content: String(content || '').slice(0, 500), ok: ok === undefined ? true : !!ok, detail: detail || '' });
    if (P.logs.length > P.settings.maxLogs) P.logs.splice(0, P.logs.length - P.settings.maxLogs);
    const keep = (P.settings.keepLogDays || 0) * 86400000;
    if (keep > 0) { const cut = Date.now() - keep; P.logs = P.logs.filter(l => l.ts >= cut); }
  }
  function cleanLogs(mode) {
    if (mode === 'all') { P.logs = []; persistP(); return 0; }
    const keep = (P.settings.keepLogDays || 0) * 86400000;
    const cut = Date.now() - keep;
    const before = P.logs.length; P.logs = P.logs.filter(l => l.ts >= cut);
    persistP(); return before - P.logs.length;
  }

  /* ================= TL 扩展（不改 server.js 内核区，persona 自带） =================
   * 全部复用 ctx.TLWriter / 已验证的 inputPeer 构造。
   */
  function b64(ip) { return Buffer.from(ip).toString('base64'); }
  function unb64(s) { return Buffer.from(String(s || ''), 'base64'); }
  // messages.sendReaction#d1d915f5 flags:# big:flags.1?true add_to_recent:flags.2?true peer:InputPeer msg_id:int reaction:flags.0?Vector<Reaction>
  async function sendReaction(client, inputPeer, msgId, emoji) {
    const req = new TLWriter().writeUInt32(3520665077).writeInt32(1).writeRaw(inputPeer).writeInt32(msgId)
      .writeUInt32(481674261).writeInt32(1).writeUInt32(453215929).writeString(String(emoji || '👍')).toBytes();
    await client.invoke(req);
    return true;
  }
  // messages.deleteMessages#e58e95d2 flags:# revoke:flags.0?true id:Vector<int>
  async function deleteMessages(client, msgIds) {
    const ids = Array.isArray(msgIds) ? msgIds : [msgIds];
    if (!ids.length) return;
    const w = new TLWriter().writeUInt32(3851326930).writeInt32(0).writeUInt32(481674261).writeInt32(ids.length);
    for (const id of ids) w.writeInt32(id);
    await client.invoke(w.toBytes());
  }

  /* ================= 账号 / client 管理 ================= */
  function workAcc() {
    const id = P.settings.accountId;
    return tg.accounts.find(a => a.id === id) || tg.accounts.find(a => a.enabled !== false) || null;
  }
  const clientState = { client: null, accId: '', lastInvoke: 0, connecting: false };
  async function personaClient(force) {
    const acc = workAcc();
    if (!acc) return null;
    if (clientState.client && clientState.accId === acc.id && !force) return clientState.client;
    if (clientState.client) { try { await clientState.client.disconnect(); } catch (e) {} }
    const client = new MTProtoClient(tgOpen(acc.session), ctx.tgEnvOf(acc));
    await client.connect();
    clientState.client = client; clientState.accId = acc.id; clientState.lastInvoke = Date.now();
    return client;
  }
  async function withClient(fn) {
    const acc = workAcc();
    if (!acc) return { ok: false, error: '未配置工作账号（先去 TG 签到里登录一个账号，再到 TG Persona 设置选择）' };
    let c = null;
    try { c = await personaClient(); if (!c) return { ok: false, error: '账号不可用' }; const r = await fn(c, acc); clientState.lastInvoke = Date.now(); return { ok: true, data: r }; }
    catch (e) { const msg = ctx.tgErrText ? ctx.tgErrText(e) : String((e && e.message) || e); try { if (c) await c.disconnect(); } catch (e2) {} clientState.client = null; return { ok: false, error: msg }; }
  }

  /* ================= 群管理 ================= */
  function chatFind(id) { return P.chats.find(c => c.id === id); }
  function chatB64(peer) { const c = P.chats.find(x => x.peer === peer); return c; }
  async function addChatByRef(ref, monitored) {
    // ref: @username 或标题；复用内核 resolvePeer（支持 user/chat/channel）
    return withClient(async (c) => {
      const target = String(ref || '').trim();
      if (!target) throw new Error('群引用不能为空（填 @群username）');
      const r = await c.resolvePeer(target); // 内核 resolvePeer 已处理 @ 前缀
      const peerB64 = b64(r.inputPeer);
      let rec = P.chats.find(x => x.peer === peerB64);
      if (!rec) { rec = { id: uid('chat'), title: r.title || target, kind: r.kind, peer: peerB64, monitored: monitored !== false, lastMinId: 0, addedAt: Date.now() }; P.chats.push(rec); }
      else { rec.title = r.title || rec.title; rec.monitored = monitored !== false; }
      persistP();
      return { id: rec.id, title: rec.title, kind: rec.kind, monitored: rec.monitored };
    });
  }
  function listChats() { return P.chats.map(c => ({ id: c.id, title: c.title, kind: c.kind, monitored: c.monitored })); }
  function setChatMonitor(id, on) {
    const c = chatFind(id); if (!c) return false;
    c.monitored = !!on; persistP(); return true;
  }
  function removeChat(id) { const i = P.chats.findIndex(c => c.id === id); if (i < 0) return false; P.chats.splice(i, 1); persistP(); return true; }

  /* ================= 规则引擎 ================= */
  function matchKeywords(kws, regex, text) {
    const t = String(text || '');
    if (regex) { try { return new RegExp(kws, 'i').test(t); } catch (e) { return false; } }
    const list = String(kws || '').split(',').map(s => s.trim()).filter(Boolean);
    return list.some(k => t.indexOf(k) >= 0);
  }
  const coolMap = Object.create(null);
  function cooled(key, sec) {
    const now = Date.now();
    if (coolMap[key] && now - coolMap[key] < (sec || P.settings.coolSec) * 1000) return true;
    coolMap[key] = now; return false;
  }
  async function humanDelay() { const ms = randInt(P.settings.delayMin, P.settings.delayMax); if (ms > 0) await sleep(ms); }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function chatMonitored(chat) { return !!(chat && chat.monitored); }
  async function executeRule(c, rule, chat, msg, peer) {
    const inChat = rule.chats && rule.chats.length ? rule.chats.includes(chat.id) : true;
    if (!inChat) return null;
    const key = rule.id + ':' + chat.id;
    if (cooled(key, rule.coolSec || P.settings.coolSec)) return null;
    await humanDelay();
    let acted = [];
    try {
      if (rule.action === 'react' || rule.action === 'both') {
        await sendReaction(c, peer, msg.id, rule.emoji || '👍');
        acted.push('表情');
        addLog('reply', chat.title, rule.name + '：点表情 ' + (rule.emoji || '👍') + '（原消息：' + String(msg.text).slice(0, 60) + '）', true);
      }
      if (rule.action === 'reply' || rule.action === 'both') {
        const text = randReplies(rule.replies);
        if (text) { await c.sendText(peer, renderPlaceholders(text)); acted.push('回复'); addLog('reply', chat.title, rule.name + '：回复 "' + text + '"', true); }
      }
    } catch (e) { addLog('reply', chat.title, rule.name + ' 执行失败：' + String((e && e.message) || e), false); }
    return acted.length ? acted : null;
  }

  /* ================= 红包 / 抢注（消息监听内） ================= */
  const redTask = () => P.tasks.find(t => t.kind === 'redpack' && t.enabled !== false);
  function findBtn(buttons, btnText, btnEmoji) {
    if (!buttons || !buttons.length) return null;
    for (const row of buttons) for (const b of row) {
      if (!b || !b.data) continue;
      if (btnText && b.text && b.text.indexOf(btnText) >= 0) return b;
      if (btnEmoji && b.text && b.text.indexOf(btnEmoji) >= 0) return b;
    }
    return null;
  }
  async function tryRedpack(c, chat, msg, peer) {
    const t = redTask();
    if (!t) return false;
    const chats = t.chats && t.chats.length ? t.chats : [];
    if (chats.length && !chats.includes(chat.id)) return false;
    const btn = findBtn(msg.buttons, t.btnText || '', t.btnEmoji || '🧧');
    if (!btn) return false;
    if (cooled('red:' + chat.id, t.coolSec || 3)) return false;
    try { await c.clickButton(peer, msg.id, btn.data); addLog('redpack', chat.title, '点击红包/礼物按钮「' + (btn.text || '') + '」', true); return true; }
    catch (e) { addLog('redpack', chat.title, '点红包失败：' + String((e && e.message) || e), false); return false; }
  }
  function extractCode(text, regex) {
    if (regex) { try { const m = String(text || '').match(new RegExp(regex, 'i')); return m ? m[1] || m[0] : ''; } catch (e) {} }
    const m = String(text || '').match(/\b([A-Z0-9]{6,16})\b/g);
    return m ? m[0] : '';
  }
  async function tryGrab(c, chat, msg, peer) {
    const t = P.tasks.find(x => x.kind === 'grab' && x.enabled !== false);
    if (!t) return false;
    const chats = t.chats && t.chats.length ? t.chats : [];
    if (chats.length && !chats.includes(chat.id)) return false;
    if (!matchKeywords(t.keywords, t.regex, msg.text)) return false;
    if (cooled('grab:' + chat.id, t.coolSec || 10)) return false;
    await humanDelay();
    const code = extractCode(msg.text, t.extractRegex);
    try {
      if (t.action === 'reply' || t.action === 'both') { const text = randReplies(t.replyText); if (text) await c.sendText(peer, renderPlaceholders(text, { code })); addLog('grab', chat.title, '抢注命中：' + String(msg.text).slice(0, 60) + (code ? ' 提取码 ' + code : ''), true); }
      if (t.action === 'send' || t.action === 'both') {
        const text = renderPlaceholders(t.registerText || '注册 {code}', { code });
        if (text) { await c.sendText(peer, text); addLog('grab', chat.title, '群内发送注册：' + text, true); }
      }
      notify('抢注', '命中 ' + (chat.title || ''), String(msg.text).slice(0, 100));
    } catch (e) { addLog('grab', chat.title, '抢注执行失败：' + String((e && e.message) || e), false); }
    return true;
  }

  /* ================= 自动水群 ================= */
  const waterWin = { key: '', list: [], ts: 0 };
  function waterCheck(chat, msg) {
    const w = P.settings.water;
    if (!w.enabled || !chat || chat.monitored === false) return null;
    const t = String(msg.text || '').trim();
    if (!t || t.indexOf('/') === 0) return null;
    const key = chat.id + '|' + t;
    const now = Date.now();
    if (waterWin.key === key && now - waterWin.ts < (w.windowMin || 5) * 60000) {
      waterWin.list.push(now);
      if (waterWin.list.length >= (w.count || 5)) {
        if (cooled('water:' + chat.id, 60)) return null;
        waterWin.key = ''; waterWin.list = []; waterWin.ts = 0;
        return randReplies(w.replies);
      }
    } else { waterWin.key = key; waterWin.list = [now]; waterWin.ts = now; }
    return null;
  }

  /* ================= 监听轮询 ================= */
  let watcherTimer = null, watcherBusy = false;
  async function watchLoop() {
    if (watcherBusy) return; watcherBusy = true;
    try {
      if (!P.settings.enabled) return;
      const acc = workAcc();
      if (!acc || !P.chats.some(c => c.monitored)) return;
      const c = await personaClient();
      if (!c) return;
      for (const chat of P.chats) {
        if (!chat.monitored) continue;
        try {
          const peer = unb64(chat.peer);
          const msgs = await c.recentMessages(peer, 4, chat.lastMinId || 0);
          if (!msgs || !msgs.length) continue;
          const maxId = Math.max(...msgs.map(m => m.id));
          if (maxId > chat.lastMinId) chat.lastMinId = maxId;
          // 只处理非自己发的消息（out=false），按时间从旧到新
          const seen = msgs.filter(m => !m.out).reverse();
          for (const m of seen) {
            // 规则（多条同时命中）
            for (const rule of P.rules) {
              if (rule.enabled === false) continue;
              if (!matchKeywords(rule.keywords, rule.regex, m.text)) continue;
              await executeRule(c, rule, chat, m, peer);
            }
            await tryRedpack(c, chat, m, peer);
            await tryGrab(c, chat, m, peer);
            const wText = waterCheck(chat, m);
            if (wText) { try { await sleep(randInt(P.settings.delayMin, P.settings.delayMax)); await c.sendText(peer, wText); addLog('water', chat.title, '水群跟发：' + wText, true); } catch (e) {} }
          }
        } catch (e) { /* 单群失败不影响其它群 */ }
      }
    } catch (e) {
      // 连接级错误：下一轮自动重连
    } finally { watcherBusy = false; }
  }

  /* ================= 保号（定时发言） ================= */
  let keepTimer = null;
  async function runKeepaliveOne(k, reason) {
    const acc = workAcc(); if (!acc) return { ok: false, error: '无工作账号' };
    return withClient(async (c) => {
      if (!k.chats || !k.chats.length) throw new Error('保号任务没有配置群');
      for (const gc of k.chats) {
        const peer = unb64(gc.peer);
        const text = renderPlaceholders(randReplies(k.content));
        const r = await c.sendText(peer, text);
        addLog('keepalive', gc.title, reason + '：' + text, true);
        if (k.deleteAfterSec > 0 && r && r.msgId) { setTimeout(async () => { try { await deleteMessages(c, r.msgId); } catch (e) {} }, k.deleteAfterSec * 1000); }
      }
      k.lastTs = Date.now(); k.lastOk = true; persistP();
      return true;
    });
  }
  function keepaliveDue(k) {
    const n = nowInTz(P.settings.tz);
    const min = (h, mi) => h * 60 + mi;
    const now = min(n.h, n.mi);
    if (k.windowStart && k.windowEnd) {
      const s = min(...String(k.windowStart).split(':').map(Number)), e = min(...String(k.windowEnd).split(':').map(Number));
      if (now < s || now > e) return false;
      // 窗口内随机时刻：今天在此窗口随机选一个分钟，执行一次
      const dayKey = dateKeyOf(n) + k.id;
      if (k._windowMin === undefined || k._windowDay !== dayKey) {
        k._windowDay = dayKey; k._windowMin = randInt(s, e);
        persistP();
      }
      return now === k._windowMin;
    }
    const iv = (k.intervalMin || 60) * 60000;
    return !k.lastTs || Date.now() - k.lastTs >= iv;
  }
  async function keepaliveLoop() {
    if (!P.settings.enabled) return;
    for (const k of P.keepalive) {
      if (k.enabled === false) continue;
      try { if (keepaliveDue(k)) { const r = await runKeepaliveOne(k, '保号'); if (!r.ok) addLog('keepalive', k.name, '执行失败：' + r.error, false); } } catch (e) {}
    }
  }

  /* ================= 自动化任务 ================= */
  const doneOn = Object.create(null); // taskId -> 'MM-DD'
  function taskDue(t) {
    if (!t.windowStart || !t.windowEnd) return !t.lastTs || Date.now() - t.lastTs >= (t.intervalMin || 1440) * 60000;
    const n = nowInTz(P.settings.tz);
    const min = (h, mi) => h * 60 + mi;
    const now = min(n.h, n.mi);
    const s = min(...String(t.windowStart).split(':').map(Number)), e = min(...String(t.windowEnd).split(':').map(Number));
    if (now < s || now > e) return false;
    const day = dateKeyOf(n);
    if (doneOn[t.id] === day) return false;
    // 窗口内随机一次
    const target = (t._m = t._m === undefined || t._day !== day ? (t._day = day, randInt(s, e)) : t._m);
    return now === target;
  }
  /* 签到：发命令 → 找 bot 回复 → 判定 → 点按钮（文本/表情）→ 连点 */
  async function runSignin(t, c, acc) {
    const target = t.target || '';
    const peer = await c.resolvePeer(target);
    const before = await c.recentMessages(peer, 1, 0);
    const lastId = before.length ? before[0].id : 0;
    await c.sendText(peer.inputPeer, renderPlaceholders(t.command || '/checkin'));
    await sleep(randInt(1200, 2500));
    const msgs = await c.recentMessages(peer, 5, lastId);
    const reply = msgs.find(m => m.id > lastId) || (msgs.length ? msgs[0] : null);
    const text = reply ? reply.text : '';
    let ok = true, msgParts = [];
    if (t.okWords && text && !new RegExp(String(t.okWords).replace(/,/g, '|'), 'i').test(text)) ok = false;
    if (t.failWords && text && new RegExp(String(t.failWords).replace(/,/g, '|'), 'i').test(text)) ok = false;
    let points = '';
    if (t.pointsRegex && text) { const m = text.match(new RegExp(t.pointsRegex, 'i')); if (m) points = m[1] || m[0]; }
    msgParts.push('命令 ' + (t.command || '/checkin') + (ok ? ' 判定成功' : ' 判定失败'));
    if (reply && reply.text) msgParts.push('机器人回复：' + reply.text.slice(0, 80));
    // 点按钮（文本或表情，可连点）
    let clicked = 0;
    if (reply && reply.buttons) {
      const btn = findBtn(reply.buttons, t.btnText || '', t.btnEmoji || '');
      if (btn) {
        const times = Math.max(1, t.clickTimes || 1);
        for (let i = 0; i < times; i++) {
          try { await c.clickButton(peer.inputPeer, reply.id, btn.data); clicked++; msgParts.push('点按钮「' + (btn.text || '') + '」第 ' + (i + 1) + ' 次'); if (i < times - 1) await sleep(t.clickIntervalMs || 300); }
          catch (e) { msgParts.push('点按钮失败：' + String((e && e.message) || e)); break; }
        }
      } else if (t.btnText || t.btnEmoji) { msgParts.push('未找到目标按钮'); ok = false; }
    }
    if (points) msgParts.push('积分提取：' + points);
    const summary = msgParts.join(' | ');
    addLog('signin', t.name, summary, ok);
    if (t.sendResultToChats && t.sendResultToChats.length) {
      for (const gc of t.sendResultToChats) { try { await c.sendText(unb64(gc.peer), (ok ? '✅ ' : '❌ ') + summary); } catch (e) {} }
    }
    const nt = P.settings.notify;
    if ((ok && nt.okOn) || (!ok && nt.failOn)) notify('签到', t.name, summary);
    return { ok, summary };
  }
  /* 抢注轮询模式：定时发探测命令，命中开注关键词则注册 */
  async function runGrabPoll(t, c) {
    if (!t.pollMode || !t.pollMode.enabled) return { ok: true, skip: true };
    const target = t.pollMode.bot || t.target || '';
    if (!target) return { ok: false, error: '抢注轮询缺少 bot 目标' };
    const peer = await c.resolvePeer(target);
    await c.sendText(peer.inputPeer, renderPlaceholders(t.pollMode.command || '注'));
    await sleep(randInt(800, 1500));
    const msgs = await c.recentMessages(peer, 4, 0);
    const hit = msgs.find(m => !m.out && matchKeywords(t.keywords, t.regex, m.text));
    if (!hit) return { ok: true, skipped: true };
    const code = extractCode(hit.text, t.extractRegex);
    const regText = renderPlaceholders(t.pollMode.registerText || '注册 {code}', { code });
    await c.sendText(peer.inputPeer, regText);
    addLog('grab', t.name, '轮询命中注册：' + regText, true);
    notify('抢注', t.name, regText);
    return { ok: true, regText };
  }
  /* 自定义多步任务 */
  async function runCustom(t, c) {
    if (!Array.isArray(t.steps) || !t.steps.length) throw new Error('自定义任务没有步骤');
    const lastIds = Object.create(null);
    const retries = Math.max(0, t.retries || 0);
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        for (const st of t.steps) {
          if (st.action === 'send') {
            const peer = st.chat ? unb64(st.chat) : await resolveChatPeer(c, t.chats || []);
            if (!peer) throw new Error('send 步骤缺少目标群');
            await c.sendText(peer, renderPlaceholders(st.text));
          } else if (st.action === 'wait') { await sleep(Math.max(0, (st.sec || 1)) * 1000); }
          else if (st.action === 'click' || st.action === 'clickAny') {
            const peer = st.chat ? unb64(st.chat) : await resolveChatPeer(c, t.chats || []);
            if (!peer) throw new Error('click 步骤缺少目标群');
            const since = lastIds[peer.toString('base64')] || 0;
            const msgs = await c.recentMessages(peer, 6, since);
            if (msgs.length) lastIds[peer.toString('base64')] = Math.max(...msgs.map(m => m.id));
            let hit = null;
            for (const m of msgs) { const b = findBtn(m.buttons, st.btnText, st.btnEmoji); if (b) { hit = { m, b }; break; } }
            if (!hit && st.action === 'click') throw new Error('未找到按钮：' + (st.btnText || st.btnEmoji || ''));
            if (!hit) throw new Error('未找到可点按钮');
            await c.clickButton(peer, hit.m.id, hit.b.data);
          } else if (st.action === 'captcha') {
            // 验证码：需要 OpenAI 兼容视觉 API（配置在设置-OCR）；按钮/图片识别
            const peer = st.chat ? unb64(st.chat) : await resolveChatPeer(c, t.chats || []);
            if (!peer) throw new Error('captcha 步骤缺少目标群');
            const ocr = P.settings.ocr;
            if (!ocr.base || !ocr.key) throw new Error('captcha 步骤需要先在设置里配置 OpenAI 兼容视觉 API（base/key/model）');
            const msgs = await c.recentMessages(peer, 4, 0);
            let imgUrl = null;
            for (const m of msgs) for (const row of (m.buttons || [])) for (const b of row) { if (b.url && /\.(png|jpe?g|webp)(\?|$)/i.test(b.url)) { imgUrl = b.url; break; } }
            if (!imgUrl) throw new Error('captcha 步骤未找到验证码图片按钮');
            const code = await ocrImage(imgUrl, ocr);
            await c.sendText(peer, String(code || '').trim());
          } else if (st.action === 'awaitReply') {
            const peer = st.chat ? unb64(st.chat) : await resolveChatPeer(c, t.chats || []);
            if (!peer) throw new Error('awaitReply 步骤缺少目标群');
            const deadline = Date.now() + Math.max(1, (st.timeoutSec || 20)) * 1000;
            let got = false;
            while (Date.now() < deadline) {
              const msgs = await c.recentMessages(peer, 3, lastIds[peer.toString('base64')] || 0);
              for (const m of msgs) { lastIds[peer.toString('base64')] = Math.max(lastIds[peer.toString('base64')] || 0, m.id); if (!m.out && matchKeywords(st.match, false, m.text)) { got = true; break; } }
              if (got) break; await sleep(1500);
            }
            if (!got) throw new Error('等待回复超时：' + (st.match || ''));
          } else { throw new Error('未知步骤 action：' + st.action); }
        }
        addLog('custom', t.name, '自定义任务执行成功', true);
        const nt = P.settings.notify; if (nt.okOn) notify('自定义', t.name, '执行成功');
        return { ok: true };
      } catch (e) { lastErr = e; if (attempt < retries) await sleep(randInt(1500, 3000)); }
    }
    const msg = String((lastErr && lastErr.message) || lastErr);
    addLog('custom', t.name, '自定义任务失败：' + msg, false);
    const nt = P.settings.notify; if (nt.failOn) notify('自定义', t.name, '失败：' + msg);
    return { ok: false, error: msg };
  }
  async function resolveChatPeer(c, chatRefs) {
    if (!chatRefs || !chatRefs.length) return null;
    const ref = chatRefs[0];
    if (typeof ref === 'string') { const r = await c.resolvePeer(ref); return r.inputPeer; }
    if (ref && ref.peer) return unb64(ref.peer);
    if (ref && ref.id) { const ch = chatFind(ref.id); if (ch) return unb64(ch.peer); }
    return null;
  }
  function ocrImage(url, ocr) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => { const b = []; res.on('data', c => b.push(c)); res.on('end', () => {
        const base64 = Buffer.concat(b).toString('base64');
        httpPostJson(String(ocr.base).replace(/\/+$/, '') + '/chat/completions', { model: ocr.model || 'gpt-4o-mini', messages: [{ role: 'user', content: [{ type: 'text', text: '识别这张验证码图片，只输出验证码文本' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + base64 } }] }], max_tokens: 20 }, 15000).then((txt) => { try { const j = JSON.parse(txt); resolve(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || ''); } catch (e) { reject(new Error('OCR 响应解析失败')); } }).catch(reject);
      }); }).on('error', reject);
    });
  }
  async function runTask(t) {
    if (t.enabled === false) return { ok: false, error: '任务已停用' };
    const acc = workAcc(); if (!acc) return { ok: false, error: '无工作账号' };
    return withClient(async (c) => {
      let r;
      if (t.kind === 'signin') r = await runSignin(t, c, acc);
      else if (t.kind === 'grab') r = await runGrabPoll(t, c);
      else if (t.kind === 'custom') r = await runCustom(t, c);
      else throw new Error('未知任务类型：' + t.kind);
      t.lastTs = Date.now(); t.lastOk = !!r.ok; t.lastMsg = r.summary || r.error || (r.skipped ? '轮询未命中' : '完成');
      doneOn[t.id] = dateKeyOf(nowInTz(P.settings.tz));
      persistP();
      return r;
    });
  }
  async function taskLoop() {
    if (!P.settings.enabled) return;
    for (const t of P.tasks) {
      if (t.enabled === false) continue;
      if (t.kind === 'redpack') continue; // 红包在监听内
      try { if (taskDue(t)) { const r = await runTask(t); if (!r.ok && r.error) addLog('task', t.name, r.error, false); } } catch (e) {}
    }
  }

  /* ================= 会话守护 ================= */
  let guardTimer = null;
  async function guardLoop() {
    if (!P.settings.sessionGuard) return;
    const acc = workAcc(); if (!acc) return;
    try {
      const c = await personaClient(true); // 强制重建一次以验证 session
      if (c) { if (P.guard.warned) { P.guard.warned = false; persistP(); addLog('guard', acc.name, '会话已恢复', true); } return; }
    } catch (e) {
      clientState.client = null;
      if (!P.guard.warned) { P.guard.warned = true; persistP(); addLog('guard', acc.name, 'TG 会话掉线：' + ctx.tgErrText ? ctx.tgErrText(e) : String((e && e.message) || e), false); notify('守护', 'TG 会话掉线', String((e && e.message) || e)); }
    }
  }

  /* ================= 调度 ================= */
  let timers = [];
  function every(ms, fn) { const id = setInterval(fn, ms); timers.push(id); return id; }
  function start() {
    if (timers.length) return;
    every(Math.max(2, P.settings.watcherSec || 4) * 1000, () => { watchLoop().catch(() => {}); });
    every(30000, () => { keepaliveLoop().catch(() => {}); });
    every(30000, () => { taskLoop().catch(() => {}); });
    every(60000, () => { guardLoop().catch(() => {}); });
    addLog('guard', '-', 'TG Persona 模块启动（v1.0.0）', true);
  }
  function stop() { for (const id of timers) clearInterval(id); timers = []; try { if (clientState.client) clientState.client.disconnect(); } catch (e) {} clientState.client = null; }

  /* ================= API ================= */
  async function apiHandler(req, res, url, role) {
    if (role !== 'admin') return ctx.sendJSON(res, 403, { success: false, error: 'Forbidden' });
    const p = url.pathname;
    const method = req.method;
    const body = await ctx.readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } }).catch(() => ({}));
    const send = (obj) => ctx.sendJSON(res, 200, Object.assign({ success: true }, obj));
    try {
      if (p === '/api/tg-persona/state' && method === 'GET') {
        const acc = workAcc();
        return send({
          version: '1.0.0', enabled: P.settings.enabled,
          account: acc ? { id: acc.id, name: acc.name, phone: acc.phone } : null,
          settings: P.settings,
          stats: { rules: P.rules.length, keepalive: P.keepalive.length, tasks: P.tasks.length, chats: P.chats.length, logs: P.logs.length },
          chats: listChats(), guard: P.guard
        });
      }
      if (p === '/api/tg-persona/enable' && method === 'POST') { P.settings.enabled = !!body.enabled; persistP(); return send({ enabled: P.settings.enabled }); }
      if (p === '/api/tg-persona/settings' && method === 'POST') {
        P.settings = Object.assign({}, P.settings, body);
        P.settings.water = Object.assign({}, P_DEF.settings.water, body.water || P.settings.water || {});
        P.settings.notify = Object.assign({}, P_DEF.settings.notify, body.notify || P.settings.notify || {});
        P.settings.ocr = Object.assign({}, P_DEF.settings.ocr, body.ocr || P.settings.ocr || {});
        persistP(); return send({ settings: P.settings });
      }
      if (p === '/api/tg-persona/account' && method === 'POST') {
        const acc = tg.accounts.find(a => a.id === body.accountId);
        if (!acc) return send({ success: false, error: '账号不存在（先去 TG 签到登录/导入）' });
        P.settings.accountId = acc.id; persistP(); return send({ account: { id: acc.id, name: acc.name } });
      }
      /* 群 */
      if (p === '/api/tg-persona/chats' && method === 'POST') { const r = await addChatByRef(body.ref, body.monitored); return send({ chat: r }); }
      if (p === '/api/tg-persona/chats/monitor' && method === 'POST') { setChatMonitor(body.id, !!body.on); return send({ ok: true }); }
      if (p === '/api/tg-persona/chats' && method === 'DELETE') { removeChat(body.id); return send({ ok: true }); }
      /* 规则 */
      if (p === '/api/tg-persona/rules' && method === 'POST') {
        const r = Object.assign({ id: uid('rule'), enabled: true, keywords: '', regex: false, action: 'reply', replies: '', emoji: '👍', chats: [], coolSec: P.settings.coolSec, name: '' }, body);
        if (!r.keywords) return send({ success: false, error: '关键词不能为空' });
        P.rules.push(r); persistP(); return send({ rule: r });
      }
      if (p === '/api/tg-persona/rules' && method === 'PUT') {
        const r = P.rules.find(x => x.id === body.id); if (!r) return send({ success: false, error: '规则不存在' });
        Object.assign(r, body); persistP(); return send({ rule: r });
      }
      if (p === '/api/tg-persona/rules' && method === 'DELETE') { P.rules = P.rules.filter(x => x.id !== body.id); persistP(); return send({ ok: true }); }
      /* 保号 */
      if (p === '/api/tg-persona/keepalive' && method === 'POST') {
        const k = Object.assign({ id: uid('keep'), name: '', chats: [], windowStart: '', windowEnd: '', intervalMin: 60, content: '', deleteAfterSec: 0, enabled: true }, body);
        if (!k.content) return send({ success: false, error: '发言内容不能为空' });
        P.keepalive.push(k); persistP(); return send({ keepalive: k });
      }
      if (p === '/api/tg-persona/keepalive' && method === 'PUT') { const k = P.keepalive.find(x => x.id === body.id); if (!k) return send({ success: false, error: '任务不存在' }); Object.assign(k, body); persistP(); return send({ keepalive: k }); }
      if (p === '/api/tg-persona/keepalive' && method === 'DELETE') { P.keepalive = P.keepalive.filter(x => x.id !== body.id); persistP(); return send({ ok: true }); }
      if (p === '/api/tg-persona/keepalive/run' && method === 'POST') { const k = P.keepalive.find(x => x.id === body.id); if (!k) return send({ success: false, error: '任务不存在' }); const r = await runKeepaliveOne(k, '手动执行'); return send({ ok: r.ok, error: r.error || '' }); }
      /* 自动化任务 */
      if (p === '/api/tg-persona/tasks' && method === 'POST') {
        const t = Object.assign({ id: uid('task'), kind: 'signin', name: '', target: '', command: '/checkin', windowStart: '', windowEnd: '', intervalMin: 1440, enabled: true, okWords: '', failWords: '', pointsRegex: '', btnText: '', btnEmoji: '', clickTimes: 1, clickIntervalMs: 300, retries: 0, chats: [], sendResultToChats: [], keywords: '', regex: false, replyText: '', registerText: '', extractRegex: '', action: 'reply', pollMode: null, steps: [] }, body);
        if (!t.name) t.name = t.kind;
        P.tasks.push(t); persistP(); return send({ task: t });
      }
      if (p === '/api/tg-persona/tasks' && method === 'PUT') { const t = P.tasks.find(x => x.id === body.id); if (!t) return send({ success: false, error: '任务不存在' }); Object.assign(t, body); persistP(); return send({ task: t }); }
      if (p === '/api/tg-persona/tasks' && method === 'DELETE') { P.tasks = P.tasks.filter(x => x.id !== body.id); persistP(); return send({ ok: true }); }
      if (p === '/api/tg-persona/tasks/run' && method === 'POST') { const t = P.tasks.find(x => x.id === body.id); if (!t) return send({ success: false, error: '任务不存在' }); const r = await runTask(t); return send({ ok: r.ok, result: r.summary || r.error || r.skipped ? '轮询未命中' : '完成' }); }
      /* 日志 */
      if (p === '/api/tg-persona/logs' && method === 'GET') {
        const q = new URLSearchParams(url.search);
        const type = q.get('type') || ''; const search = q.get('q') || ''; const limit = Math.min(500, +(q.get('limit') || 200));
        let out = P.logs;
        if (type) out = out.filter(l => l.type === type);
        if (search) out = out.filter(l => (l.chat + l.content + l.detail).toLowerCase().indexOf(search.toLowerCase()) >= 0);
        return send({ logs: out.slice(-limit).reverse() });
      }
      if (p === '/api/tg-persona/logs/clear' && method === 'POST') { const n = cleanLogs(body.mode || 'all'); return send({ removed: n }); }
      return send({ success: false, error: '未知接口 ' + p });
    } catch (e) {
      return send({ success: false, error: String((e && e.message) || e) });
    }
  }

  return { apiHandler, start, stop, state: () => ({ enabled: P.settings.enabled, account: workAcc() ? workAcc().name : null }) };
}
