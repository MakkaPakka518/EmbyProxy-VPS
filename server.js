#!/usr/bin/env node
/**
 * Emby 反代管理面板 (VPS 版)
 * 零依赖 Node.js 服务：反代引擎 + 管理面板 API + JSON 文件存储
 * 默认端口 3333，不占用 80/443
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const dns = require('dns');

const PORT = parseInt(process.env.PORT || '3333', 10);
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ROUTES_FILE = path.join(DATA_DIR, 'routes.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const PANEL_FILE = path.join(__dirname, 'panel.html');

/* ==========================================================
 * 数据层（JSON 文件存储）
 * ========================================================== */
function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      adminToken: 'changeme_please',
      adminPass: null,
      subscribers: [],
      frontendDomain: '',
      backendDomain: '',
      networkPreference: 'auto',
    }, null, 2));
  }
  if (!fs.existsSync(ROUTES_FILE)) fs.writeFileSync(ROUTES_FILE, JSON.stringify([], null, 2));
  if (!fs.existsSync(STATS_FILE)) fs.writeFileSync(STATS_FILE, JSON.stringify({}, null, 2));
}

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('保存失败', file, e.message); }
}

ensureData();
let config = loadJSON(CONFIG_FILE, {});
let routes = loadJSON(ROUTES_FILE, []);
let stats = loadJSON(STATS_FILE, {});

const persistConfig = () => saveJSON(CONFIG_FILE, config);
const persistRoutes = () => saveJSON(ROUTES_FILE, routes);
const persistStats = () => saveJSON(STATS_FILE, stats);

/* 全局 IPv6/IPv4 优先：调整系统 DNS 解析顺序（Node 17+ 支持 ipv6first，Node 18+ 支持 ipv4first），
   auto=跟随系统默认、v6=优先 IPv6、v4=优先 IPv4；目标缺少对应地址族时自动回退 */
function applyIpv6Policy() {
  try {
    const order = config.networkPreference === 'v6' ? 'ipv6first'
      : config.networkPreference === 'v4' ? 'ipv4first' : 'verbatim';
    dns.setDefaultResultOrder(order);
  } catch (e) { /* 低版本 Node 不支持则忽略 */ }
}
applyIpv6Policy();

/* ==========================================================
 * 认证（三档：adminToken > 网页密码 > 订阅者）
 * ========================================================== */
function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[2].trim()) : null;
}

function getRole(req) {
  const token = getCookie(req, 'admin_token');
  if (!token) return null;
  if (config.adminToken && token === config.adminToken) return 'admin';
  if (config.adminPass && token === config.adminPass) return 'admin';
  if (Array.isArray(config.subscribers) && config.subscribers.includes(token)) return 'sub';
  return null;
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; Max-Age=0');
}

/* ==========================================================
 * 工具函数
 * ========================================================== */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'Unknown';
}

function nowStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').split('.')[0];
}

/* ==========================================================
 * 反代引擎
 * ========================================================== */
const MEDIA_PATH_RE = /(\/videos\/|\/stream\/|\/audio\/|\/subtitles\/|\.m3u8|\.ts(\?|$)|\.mp4(\?|$)|\.mkv(\?|$)|\.flv(\?|$))/i;

function isStaticPath(p) {
  return /\.(jpg|jpeg|gif|png|svg|ico|webp|js|css|woff2?|ttf|otf|map|webmanifest|srt|ass|vtt|sub)$/i.test(p)
    || /(\/Images\/|\/Icons\/|\/Branding\/|emby\/covers\/|\/img\/)/i.test(p);
}

function hasAuthLikeState(headers, targetUrl) {
  const authQueryKeys = ['api_key', 'x-emby-token', 'x-mediabrowser-token', 'access_token', 'token'];
  const hasQuery = Array.from(targetUrl.searchParams.keys()).some(k => authQueryKeys.includes(k.toLowerCase()));
  return headers.has('Authorization') || headers.has('X-Emby-Token')
    || headers.has('X-MediaBrowser-Token') || headers.has('X-Emby-Authorization')
    || headers.has('Cookie') || hasQuery;
}

/** 收集源站 origin（含 http/https 互换 + 裸 host 变体） */
function getTargetOrigins(targets, extra) {
  const origins = [];
  const seen = new Set();
  const push = (o) => { if (o && !seen.has(o)) { seen.add(o); origins.push(o); } };
  const pushAll = (raw) => {
    try {
      const u = new URL(raw);
      push(u.origin);
      push(u.origin.replace(/^https:\/\//i, 'http://'));
      push(u.origin.replace(/^http:\/\//i, 'https://'));
      push(u.host);
      push(u.host.replace(/^https:/i, 'http:'));
    } catch (e) {}
  };
  (targets || []).forEach(pushAll);
  (extra || []).forEach(pushAll);
  return origins;
}

/** 文本 URL 重写：源站地址 → 面板地址
 *  已知源站（target/前后端域名）→ 形式A：/前缀/路径（同源简洁）
 *  自动识别的未知媒体源站 → 形式B：/前缀/完整源站URL（前后端分离自动反代回源） */
function rewriteUrlsInText(text, knownOrigins, mediaOrigins, proxyOrigin, prefix) {
  if (!text) return text;
  // 先替换自动识别的未知媒体源站（形式B），避免被形式A 误伤
  for (const m of mediaOrigins || []) {
    if (!m || !m.origin) continue;
    const ref = `${proxyOrigin}/${prefix}/${m.origin}`;
    text = text.split(m.origin).join(ref);
  }
  for (const origin of knownOrigins || []) {
    if (!origin) continue;
    const panelRef = `${proxyOrigin}/${prefix}`;
    text = text.split(origin).join(panelRef);
  }
  return text;
}

/** 从 JSON 文本中提取媒体 host（自动识别后端推流） */
function extractMediaOrigins(text, knownOrigins) {
  const found = [];
  const re = /https?:\/\/[^\s"'<>;,)}\]\\]+/g;
  let m;
  const known = new Set(knownOrigins);
  while ((m = re.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    try {
      const u = new URL(url);
      if (known.has(u.origin) || known.has(u.host)) continue;
      if (MEDIA_PATH_RE.test(u.pathname)) {
        const key = u.origin;
        if (!found.some(f => f.origin === key)) found.push({ origin: key, host: u.host });
      }
    } catch (e) {}
  }
  return found;
}

/* ---------- 上游请求 ---------- */
async function buildUpstreamCandidates(target, remainingPath, search) {
  const candidates = [];
  let base = target.replace(/\/+$/, '');
  let p = remainingPath || '/';
  if (!p.startsWith('/')) p = '/' + p;
  // 原始拼接
  candidates.push(base + p + search);
  // /emby 前缀回退：若裸路径看起来不像 emby 结构，尝试加 /emby
  if (!/^\/emby(\/|$)/i.test(p)) {
    candidates.push(base + '/emby' + p + search);
  }
  return candidates;
}

async function proxyOnce(targetUrlStr, req, mode, realIp, originHost) {
  const targetUrl = new URL(targetUrlStr);
  const headers = new Headers();

  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (['host', 'cookie', 'connection', 'content-length', 'transfer-encoding',
         'upgrade', 'http2-settings', 'proxy-connection', 'keep-alive'].includes(k)) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, String(v));
  }

  // 去掉面板自身 cookie
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(c => !c.toLowerCase().startsWith('admin_token='));
  if (cookies.length) headers.set('Cookie', cookies.join('; '));

  // Host 头保留原始域名（节点级 IPv6/IPv4 强制时连接地址被换成 IP，必须保留原域名）
  headers.set('Host', originHost || targetUrl.host);
  headers.set('X-Forwarded-Proto', targetUrl.protocol.replace(':', ''));
  headers.set('X-Forwarded-Host', req.headers.host || '');

  if (mode === 'strict' || mode === 'dual') {
    headers.set('Origin', targetUrl.origin);
    headers.set('Referer', targetUrl.origin + '/');
  }
  if (mode === 'dual' || mode === 'realip_only') {
    headers.set('X-Real-IP', realIp);
    headers.set('X-Forwarded-For', realIp);
  }

  const init = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.__bodyBuffer || undefined;
    if (init.body) init.duplex = 'half';
  }

  return fetch(targetUrl, init);
}

/* 节点级 IPv6/IPv4 强制：
   - 仅对 http:// 目标有效（https 涉及 SNI/证书校验，无法替换连接 IP，保持原样）
   - 域名预解析为指定地址族地址，用 IP 直连，Host 头仍保留原域名
   - 返回 { url: 实际请求地址, originHost: 原域名:端口 }；未命中/不支持时原样返回 */
async function resolveV4V6(urlStr, family) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:') return { url: urlStr, originHost: null };
    const host = u.hostname;
    if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return { url: urlStr, originHost: null };
    const lookup = family === 'v6' ? dns.promises.resolve6 : dns.promises.resolve4;
    const addrs = await lookup(host).catch(() => []);
    if (!addrs.length) return { url: urlStr, originHost: null };
    const originHost = u.host;
    const ip = family === 'v6' ? `[${addrs[0]}]` : addrs[0];
    u.hostname = ip;
    return { url: u.toString(), originHost };
  } catch (e) {
    return { url: urlStr, originHost: null };
  }
}

/* ---------- 缓存 ---------- */
const cacheStore = new Map(); // url -> { buf, headers, expires }

function getCache(url) {
  const item = cacheStore.get(url);
  if (!item) return null;
  if (Date.now() > item.expires) { cacheStore.delete(url); return null; }
  return item;
}

function putCache(url, buf, headers, ttlSec = 86400) {
  if (cacheStore.size > 2000) {
    const now = Date.now();
    for (const [k, v] of cacheStore) if (now > v.expires) cacheStore.delete(k);
  }
  cacheStore.set(url, { buf, headers, expires: Date.now() + ttlSec * 1000 });
}

/* ---------- 反代主入口 ---------- */
async function handleProxy(req, res, pathname, search) {
  const decodedPath = decodeURIComponent(pathname);
  let targetUrls = [];
  let remainingPath = '';
  let matchedPrefix = null;
  let mode = 'off';
  let enableCache = true;
  let ipv6Mode = 'auto';
  const proxyOrigin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;

  if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
    targetUrls = [decodedPath.substring(1)];
    remainingPath = '';
  } else {
    const parts = decodedPath.split('/');
    const prefix = parts[1];
    if (!prefix) return sendText(res, 404, 'Not Found');
    const route = routes.find(r => r.prefix === prefix);
    if (!route) return sendText(res, 404, 'Not Found');
    matchedPrefix = prefix;
    mode = route.mode || 'off';
    enableCache = route.cache_img !== 'off';
    ipv6Mode = route.v6 || 'auto';
    remainingPath = '/' + parts.slice(2).join('/');
    targetUrls = (route.target || '').split(',').map(s => s.trim()).filter(Boolean);
    if (remainingPath.startsWith('/http://') || remainingPath.startsWith('/https://')) {
      targetUrls = [remainingPath.substring(1)];
      remainingPath = '';
    }
  }

  if (targetUrls.length === 0) return sendText(res, 404, 'Not Found');

  // 播放统计：仅 PlaybackInfo 点火计数
  if (matchedPrefix && /\/PlaybackInfo/i.test(decodedPath)) {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().split('T')[0];
    if (!stats[today]) stats[today] = {};
    const p = stats[today][matchedPrefix] || { count: 0, lastPlay: '', ips: {} };
    p.count += 1;
    p.lastPlay = nowStr();
    const ip = getClientIp(req);
    p.ips[ip] = (p.ips[ip] || 0) + 1;
    stats[today][matchedPrefix] = p;
    persistStats();
  }

  // 需要重放 body 的请求预读
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try { req.__bodyBuffer = await readBody(req); }
    catch (e) { return sendText(res, 400, 'Bad Request'); }
  }

  const realIp = getClientIp(req);
  const baseOrigins = getTargetOrigins(targetUrls, [config.frontendDomain, config.backendDomain]);

  let lastError = null;

  for (const target of targetUrls) {
    const candidates = await buildUpstreamCandidates(target, remainingPath, search);

    for (let j = 0; j < candidates.length; j++) {
      const candidateUrl = candidates[j];
      let upstreamRes = null;
      let targetUrlObj = null;

      try {
        // 静态缓存命中
        const isStatic = isStaticPath(candidateUrl);
        const targetUrl = new URL(candidateUrl);
        const tempHeaders = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined || ['host','connection','content-length','transfer-encoding','upgrade','http2-settings'].includes(k)) continue;
          tempHeaders.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }
        const authLike = hasAuthLikeState(tempHeaders, targetUrl);

        if (isStatic && enableCache && !authLike && req.method === 'GET') {
          const cacheUrl = candidateUrl;
          const hit = getCache(cacheUrl);
          if (hit) {
            res.writeHead(200, { ...hit.headers, 'X-Proxy-Cache': 'HIT' });
            res.end(hit.buf);
            return;
          }
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
          // 节点级 v6/v4 强制：预解析替换连接地址（Host 头保留原域名），失败自动回退原始地址
          let requestUrl = candidateUrl;
          let originHost = null;
          if (ipv6Mode !== 'auto') {
            const r = await resolveV4V6(candidateUrl, ipv6Mode);
            requestUrl = r.url;
            originHost = r.originHost;
          }
          try {
            upstreamRes = await proxyOnce(requestUrl, req, mode, realIp, originHost);
          } catch (e) {
            if (requestUrl !== candidateUrl) {
              upstreamRes = await proxyOnce(candidateUrl, req, mode, realIp);
            } else {
              throw e;
            }
          }
        } finally {
          clearTimeout(timer);
        }
        targetUrlObj = targetUrl;

        const status = upstreamRes.status;
        // 上游失败回退
        if ([404, 502, 503, 504].includes(status) && j < candidates.length - 1) {
          if (upstreamRes.body) await upstreamRes.body.cancel();
          continue;
        }

        const upstreamHeaders = Object.fromEntries(upstreamRes.headers.entries());

        // redirect 改写
        if (status >= 300 && status < 400) {
          const loc = upstreamRes.headers.get('location');
          const rewrittenLoc = loc
            ? rewriteUrlsInText(loc, baseOrigins, [], proxyOrigin, matchedPrefix || '')
            : undefined;
          const body = await upstreamRes.arrayBuffer();
          const headersOut = { ...upstreamHeaders, 'Content-Type': upstreamRes.headers.get('content-type') || 'text/html; charset=utf-8' };
          if (rewrittenLoc) headersOut['Location'] = rewrittenLoc;
          delete headersOut['content-length'];
          headersOut['Content-Length'] = String(body.byteLength);
          headersOut['Cache-Control'] = 'no-store';
          res.writeHead(status, headersOut);
          res.end(Buffer.from(body));
          return;
        }

        // 文本类响应：URL 重写（含自动识别后端推流）
        const ct = upstreamRes.headers.get('content-type') || '';
        if (/json|javascript|xml|text/i.test(ct)) {
          const buf = Buffer.from(await upstreamRes.arrayBuffer());
          let text = buf.toString('utf8');

          // 自动识别：未配置 backendDomain 时，从媒体响应里学习源站
          const mediaFound = extractMediaOrigins(text, baseOrigins.map(o => o));
          const rewritten = rewriteUrlsInText(text, baseOrigins, mediaFound, proxyOrigin, matchedPrefix || '');

          const headersOut = { ...upstreamHeaders };
          delete headersOut['content-length'];
          headersOut['Content-Length'] = String(Buffer.byteLength(rewritten));
          headersOut['Cache-Control'] = 'no-store';
          delete headersOut['content-encoding'];
          delete headersOut['transfer-encoding'];
          res.writeHead(status, headersOut);
          res.end(rewritten);
          return;
        }

        // 静态资源缓存（非鉴权）
        if (isStatic && enableCache && !authLike && req.method === 'GET' && status === 200) {
          const buf = Buffer.from(await upstreamRes.arrayBuffer());
          const headersOut = { ...upstreamHeaders, 'Cache-Control': 'public, max-age=86400' };
          delete headersOut['content-length'];
          headersOut['Content-Length'] = String(buf.length);
          putCache(candidateUrl, buf, headersOut);
          res.writeHead(status, headersOut);
          res.end(buf);
          return;
        }

        // 其他（媒体流等）：流式透传
        res.writeHead(status, upstreamHeaders);
        if (upstreamRes.body) {
          for await (const chunk of upstreamRes.body) {
            res.write(Buffer.from(chunk));
          }
        }
        res.end();
        return;
      } catch (e) {
        lastError = e;
        if (e.name === 'AbortError') lastError = new Error('上游超时: ' + candidateUrl);
        // 继续尝试下一个候选
        continue;
      }
    }
  }

  if (lastError) sendText(res, 502, 'Bad Gateway: ' + lastError.message);
  else sendText(res, 502, 'Bad Gateway');
}

function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/* ==========================================================
 * 管理 API
 * ========================================================== */
async function handleApi(req, res, url) {
  const role = getRole(req);
  const needAdmin = (pathname) => {
    if (role !== 'admin') { sendJSON(res, 403, { success: false, error: 'Forbidden' }); return false; }
    return true;
  };

  // 登录（无需认证）
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const token = String(body.token || '').trim();
    if (!token) return sendJSON(res, 400, { success: false, error: '请输入密钥' });
    if (config.adminToken && token === config.adminToken) {
      setAuthCookie(res, token);
      return sendJSON(res, 200, { success: true, role: 'admin' });
    }
    if (config.adminPass && token === config.adminPass) {
      setAuthCookie(res, token);
      return sendJSON(res, 200, { success: true, role: 'admin' });
    }
    if (Array.isArray(config.subscribers) && config.subscribers.includes(token)) {
      setAuthCookie(res, token);
      return sendJSON(res, 200, { success: true, role: 'sub' });
    }
    return sendJSON(res, 401, { success: false, error: '密钥错误' });
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    clearAuthCookie(res);
    return sendJSON(res, 200, { success: true });
  }

  if (!role) return sendJSON(res, 401, { success: false, error: 'Unauthorized' });

  if (url.pathname === '/api/me' && req.method === 'GET') {
    return sendJSON(res, 200, { success: true, role });
  }

  if (url.pathname === '/api/account' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const pw = String(body.password || '').trim();
    if (pw.length < 4) return sendJSON(res, 400, { success: false, error: '密码至少 4 位' });
    config.adminPass = pw;
    persistConfig();
    return sendJSON(res, 200, { success: true });
  }

  /* ---- 节点路由 CRUD ---- */
  if (url.pathname === '/api/routes' && req.method === 'GET') {
    const list = routes.map(r => ({ ...r })).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    // 订阅者不可见源站地址（防泄露）
    if (role !== 'admin') {
      for (const r of list) r.target = '***';
    }
    return sendJSON(res, 200, { success: true, routes: list });
  }

  if (url.pathname === '/api/routes' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const prefix = String(body.prefix || '').trim().replace(/^\/+|\/+$/g, '');
    const target = String(body.target || '').trim();
    if (!prefix || !target) return sendJSON(res, 400, { success: false, error: '前缀和目标不能为空' });
    if (!/^https?:\/\//i.test(target)) return sendJSON(res, 400, { success: false, error: '目标必须是 http(s) 地址' });

    const existing = routes.find(r => r.prefix === prefix);
    if (existing) {
      existing.target = target;
      existing.mode = body.mode || existing.mode || 'off';
      existing.cache_img = body.cache_img !== undefined ? body.cache_img : existing.cache_img;
      if (body.v6 !== undefined) existing.v6 = body.v6;
      if (body.icon !== undefined) existing.icon = body.icon;
    } else {
      routes.push({
        prefix,
        target,
        mode: body.mode || 'off',
        cache_img: body.cache_img !== undefined ? body.cache_img : true,
        v6: body.v6 || 'auto',
        icon: body.icon || '',
        sort_order: routes.length + 1,
        createdAt: nowStr(),
      });
    }
    persistRoutes();
    return sendJSON(res, 200, { success: true });
  }

  if (url.pathname === '/api/routes' && req.method === 'DELETE') {
    if (!needAdmin(url.pathname)) return;
    const prefix = url.searchParams.get('prefix');
    routes = routes.filter(r => r.prefix !== prefix);
    persistRoutes();
    return sendJSON(res, 200, { success: true });
  }

  if (url.pathname === '/api/routes/reorder' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const items = Array.isArray(body.items) ? body.items : [];
    for (const it of items) {
      const r = routes.find(x => x.prefix === it.prefix);
      if (r) r.sort_order = it.sort_order;
    }
    persistRoutes();
    return sendJSON(res, 200, { success: true });
  }

  if (url.pathname === '/api/routes/export' && req.method === 'GET') {
    const json = JSON.stringify({ routes, config: { frontendDomain: config.frontendDomain, backendDomain: config.backendDomain, networkPreference: config.networkPreference || 'auto' } }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="emby_proxy_backup.json"' });
    res.end(json);
    return;
  }

  if (url.pathname === '/api/routes/import' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return null; } });
    if (!body || !Array.isArray(body.routes)) return sendJSON(res, 400, { success: false, error: '备份格式错误' });
    routes = body.routes.map(r => ({
      prefix: String(r.prefix || '').trim().replace(/^\/+|\/+$/g, ''),
      target: String(r.target || '').trim(),
      mode: r.mode || 'off',
      cache_img: r.cache_img !== undefined ? r.cache_img : true,
      v6: r.v6 || 'auto',
      icon: r.icon || '',
      sort_order: r.sort_order || 1,
      createdAt: r.createdAt || nowStr(),
    })).filter(r => r.prefix && r.target);
    if (body.config) {
      config.frontendDomain = body.config.frontendDomain || '';
      config.backendDomain = body.config.backendDomain || '';
      if (body.config.networkPreference !== undefined) config.networkPreference = ['auto', 'v6', 'v4'].includes(body.config.networkPreference) ? body.config.networkPreference : 'auto';
      persistConfig();
      applyIpv6Policy();
    }
    persistRoutes();
    return sendJSON(res, 200, { success: true, count: routes.length });
  }

  /* ---- 订阅者 ---- */
  if (url.pathname === '/api/subscribers' && req.method === 'GET') {
    return sendJSON(res, 200, { success: true, subscribers: config.subscribers || [] });
  }

  if (url.pathname === '/api/subscribers' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const action = body.action;
    const pw = String(body.password || '').trim();
    if (!Array.isArray(config.subscribers)) config.subscribers = [];
    if (action === 'add') {
      if (pw.length < 3) return sendJSON(res, 400, { success: false, error: '订阅密码至少 3 位' });
      if (!config.subscribers.includes(pw)) config.subscribers.push(pw);
    } else if (action === 'del') {
      config.subscribers = config.subscribers.filter(s => s !== pw);
    }
    persistConfig();
    return sendJSON(res, 200, { success: true, subscribers: config.subscribers });
  }

  /* ---- 前后端分离配置 ---- */
  if (url.pathname === '/api/config' && req.method === 'GET') {
    if (!needAdmin(url.pathname)) return;
    return sendJSON(res, 200, { success: true, frontendDomain: config.frontendDomain || '', backendDomain: config.backendDomain || '', networkPreference: config.networkPreference || 'auto' });
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    config.frontendDomain = String(body.frontendDomain || '').trim();
    config.backendDomain = String(body.backendDomain || '').trim();
    if (body.networkPreference !== undefined) {
      config.networkPreference = ['auto', 'v6', 'v4'].includes(body.networkPreference) ? body.networkPreference : 'auto';
      applyIpv6Policy();
    }
    persistConfig();
    return sendJSON(res, 200, { success: true });
  }

  /* ---- 统计 ---- */
  if (url.pathname === '/api/analytics' && req.method === 'GET') {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().split('T')[0];
    const dayStats = stats[today] || {};
    const byPrefix = {};
    for (const [prefix, p] of Object.entries(dayStats)) {
      byPrefix[prefix] = { count: p.count, lastPlay: p.lastPlay, ipCount: Object.keys(p.ips || {}).length };
    }
    // 过去 7 天全站播放趋势
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() + 8 * 3600000 - i * 86400000);
      const ds = d.toISOString().split('T')[0];
      const day = stats[ds] || {};
      let count = 0;
      for (const k of Object.keys(day)) count += (day[k].count || 0);
      trend.push({ date: ds, count });
    }
    return sendJSON(res, 200, { success: true, today, stats: byPrefix, trend, raw: stats });
  }

  /* ---- 测速（仅管理员：订阅者不可探测源站） ---- */
  if (url.pathname === '/api/ping-node' && req.method === 'GET') {
    if (!needAdmin(url.pathname)) return;
    const target = url.searchParams.get('url');
    if (!target) return sendJSON(res, 400, { success: false, error: '缺少 url' });
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(target, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 EmbyProxyPing' } });
      clearTimeout(timer);
      return sendJSON(res, 200, { success: true, latency: Date.now() - start, status: r.status });
    } catch (e) {
      return sendJSON(res, 200, { success: false, error: e.message, latency: Date.now() - start });
    }
  }

  if (url.pathname === '/api/purge-cache' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const n = cacheStore.size;
    cacheStore.clear();
    return sendJSON(res, 200, { success: true, cleared: n });
  }

  return sendJSON(res, 404, { success: false, error: 'Not Found' });
}

/* ==========================================================
 * HTTP 服务
 * ========================================================== */
let panelHtml = null;
function getPanelHtml() {
  if (panelHtml) return panelHtml;
  try { panelHtml = fs.readFileSync(PANEL_FILE, 'utf8'); }
  catch (e) { panelHtml = '<h1>panel.html 缺失</h1>'; }
  return panelHtml;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // API
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    // 管理面板
    if (url.pathname === '/' || url.pathname === '/panel') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(getPanelHtml());
      return;
    }

    // 其他路径 → 反代
    return await handleProxy(req, res, url.pathname, url.search);
  } catch (e) {
    try { sendText(res, 500, 'Internal Error: ' + e.message); } catch (_) {}
  }
});

/* WebSocket upgrade 透传 */
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const decodedPath = decodeURIComponent(url.pathname);
  let targetUrls = [];
  let remainingPath = '';

  if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
    targetUrls = [decodedPath.substring(1)];
  } else {
    const parts = decodedPath.split('/');
    const prefix = parts[1];
    const route = routes.find(r => r.prefix === prefix);
    if (!route) { socket.destroy(); return; }
    remainingPath = '/' + parts.slice(2).join('/');
    targetUrls = (route.target || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  if (targetUrls.length === 0) { socket.destroy(); return; }

  const target = targetUrls[0];
  let targetUrl;
  try { targetUrl = new URL(target); } catch (e) { socket.destroy(); return; }

  const connectPath = (remainingPath || '/') + url.search;
  const useTls = targetUrl.protocol === 'https:';
  const port = targetUrl.port || (useTls ? 443 : 80);

  const proxyHeaders = { ...req.headers };
  delete proxyHeaders['host'];
  delete proxyHeaders['cookie'];
  proxyHeaders['host'] = targetUrl.host;

  const onConnect = (upstreamSocket) => {
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.write([
      `GET ${connectPath} HTTP/1.1`,
      `Host: ${targetUrl.host}`,
      ...Object.entries(proxyHeaders).filter(([k]) => !['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'].includes(k.toLowerCase())).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`),
      'Connection: Upgrade',
      'Upgrade: websocket',
      ...(head ? [`Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`, `Sec-WebSocket-Version: ${req.headers['sec-websocket-version'] || '13'}`] : []),
      '\r\n'
    ].join('\r\n'));
    if (head && head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  };

  if (useTls) {
    const tlsSock = tls.connect({ host: targetUrl.hostname, port, rejectUnauthorized: false }, () => onConnect(tlsSock));
  } else {
    const netSock = net.connect(port, targetUrl.hostname, () => onConnect(netSock));
  }
});

// 不指定 host：监听系统全部地址（IPv6 双栈，IPv4 自动映射），纯 IPv4 / 纯 IPv6 / 双栈机器均可访问
server.listen(PORT, () => {
  console.log(`Emby 反代管理面板已启动: http://0.0.0.0:${PORT} （IPv4 + IPv6）`);
  console.log(`管理员密钥: ${config.adminToken}`);
  console.log(`节点数: ${routes.length}`);
});
