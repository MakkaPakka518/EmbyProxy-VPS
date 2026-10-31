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
const { spawnSync } = require('child_process');

// VERSION: 2.3.0（媒体 302 默认经 VPS 中转；节点可切换客户端直连；修复形式 B 路径和响应头）
const PORT = parseInt(process.env.PORT || '3333', 10);
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ROUTES_FILE = path.join(DATA_DIR, 'routes.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const PANEL_FILE = path.join(__dirname, 'panel.html');
const VERSION_FILE = path.join(__dirname, 'VERSION');
const APP_VERSION = (() => {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() || '2.3.0'; }
  catch (_) { return '2.3.0'; }
})();

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
      ipguard: { mode: 'off', ips: [], countries: [], redirect: '' },
      ipguardTrusted: [],
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
if (!config.ipguard || typeof config.ipguard !== 'object') config.ipguard = { mode: 'off', ips: [], countries: [], redirect: '' };
if (!Array.isArray(config.ipguardTrusted)) config.ipguardTrusted = [];

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
 * 版本检查与在线更新
 * ========================================================== */
let updateCtl = null;
try {
  const { createUpdater } = require(path.join(__dirname, 'updater.js'));
  updateCtl = createUpdater({
    baseDir: __dirname,
    dataDir: DATA_DIR,
    repo: 'MakkaPakka518/EmbyProxy-VPS',
    branch: 'main',
    service: 'emby-proxy',
    currentVersion: APP_VERSION,
    onUpdated: async () => {
      // install.sh 创建的 systemd 服务会带 INVOCATION_ID；手动 node 启动时不擅自退出。
      if (!process.env.INVOCATION_ID) return false;
      const result = spawnSync('systemctl', ['restart', '--no-block', 'emby-proxy'], {
        stdio: 'ignore', timeout: 5000
      });
      return result.status === 0;
    }
  });
} catch (error) {
  console.error('[更新器] 加载失败:', error.message);
}

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


/* ==========================================================
 * IP 访问控制（白名单/黑名单 + 国家封锁 + /entry 逃生）
 * 与 CF Worker 版行为一致：trusted 最高白名单放行 / 保留后缀永不拦截
 * ========================================================== */
function getClientCountry(req) {
  const c = (req.headers['cf-ipcountry'] || req.headers['x-country'] || '').trim().toUpperCase();
  return c || '';
}
const IPG_BYPASS_PREFIX = ['/api/', '/entry', '/catch', '/favicon.ico', '/__client_rtt__', '/speedtest'];
function isIpGuardBypass(p) {
  return IPG_BYPASS_PREFIX.some(pre => p === pre || p.startsWith(pre));
}
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  let v = 0;
  for (const seg of parts) {
    if (!/^\d{1,3}$/.test(seg)) return -1;
    const n = parseInt(seg, 10);
    if (n > 255) return -1;
    v = v * 256 + n;
  }
  return v >>> 0;
}
function ipv6ToBytes(ip) {
  try {
    let s = ip;
    if (s.indexOf('::') >= 0) {
      const t = s.split('::');
      const left = t[0] ? t[0].split(':') : [], right = t[1] ? t[1].split(':') : [];
      const pad = 8 - left.length - right.length;
      if (pad < 0) return null;
      s = left.concat(Array(pad).fill('0'), right).join(':');
    }
    const parts = s.split(':');
    if (parts.length !== 8) return null;
    const bytes = [];
    for (const part of parts) {
      const n = parseInt(part, 16);
      if (isNaN(n)) return null;
      bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
  } catch (e) { return null; }
}
function ipInCidr(ip, cidr) {
  const idx = cidr.indexOf('/');
  if (idx <= 0) return false;
  const net = cidr.slice(0, idx).trim();
  const bits = parseInt(cidr.slice(idx + 1), 10);
  if (isNaN(bits)) return false;
  if (net.indexOf('.') >= 0) {
    if (bits < 0 || bits > 32) return false;
    const a = ipv4ToInt(ip), b = ipv4ToInt(net);
    if (a < 0 || b < 0) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) === (b & mask);
  }
  if (net.indexOf(':') >= 0) {
    if (bits < 0 || bits > 128) return false;
    const a = ipv6ToBytes(ip), b = ipv6ToBytes(net);
    if (!a || !b) return false;
    const full = bits >> 3, rem = bits & 7;
    for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false;
    if (rem) { const m = 0xff << (8 - rem); if ((a[full] & m) !== (b[full] & m)) return false; }
    return true;
  }
  return false;
}
function ipMatchAny(ip, list) {
  if (!ip || !Array.isArray(list) || !list.length) return false;
  for (const raw of list) {
    const t = String(raw).trim();
    if (!t) continue;
    if (t === ip) return true;
    if (t.indexOf('/') >= 0 && ipInCidr(ip, t)) return true;
  }
  return false;
}

// ============ IP 被封提示页(未设置跳转网址时显示) ============
const IP_BLOCKED_UI = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>访问已被禁止</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#e8eaed;padding:20px}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:36px;width:100%;max-width:400px;text-align:center}
h1{font-size:22px;margin-bottom:12px}
.sub{font-size:14px;color:#aab4c0;margin-bottom:20px;line-height:1.7;word-break:break-all}
.badge{display:inline-block;background:rgba(255,107,107,.15);border:1px solid rgba(255,107,107,.35);color:#ff6b6b;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:600;margin-bottom:16px}
.tip{font-size:12px;color:#8b96a3;line-height:1.7}
</style>
</head>
<body>
<div class="card">
<span class="badge">&#128683; 访问已被禁止</span>
<h1>你的 IP 已被禁用</h1>
<div class="sub">当前 IP: <b style="color:#fff;">__IP__</b><br>地区: __COUNTRY__<br>该 IP 不在允许访问范围内</div>
<div class="tip">如有疑问请联系管理员</div>
</div>
</body>
</html>`;

// ============ 管理员逃生入口 /entry(只认 adminToken,不受 IP 封锁影响) ============
const ENTRY_UI = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>管理员逃生入口</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;background:linear-gradient(135deg,#0f2027,#203a43,#2c5364);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#e8eaed;padding:20px}
.card{background:rgba(255,255,255,.06);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:32px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.4);margin-bottom:16px}
h1{font-size:19px;margin-bottom:8px;text-align:center}
.sub{font-size:13px;color:#aab4c0;text-align:center;margin-bottom:18px;line-height:1.6}
input[type=password],input[type=text],textarea{width:100%;padding:12px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.07);color:#fff;font-size:14px;outline:none;margin-bottom:12px;box-sizing:border-box}
input:focus,textarea:focus{border-color:#4da3ff}
textarea{resize:vertical;min-height:80px}
button{width:100%;padding:13px;border:none;border-radius:10px;background:#4da3ff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
button:active{opacity:.85}
button.ghost{background:transparent;border:1px solid rgba(255,255,255,.3);margin-top:8px}
.row{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:13px;margin-bottom:12px}
.row label{display:flex;align-items:center;gap:5px;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;text-align:center;margin-top:10px;min-height:18px}
.ok{color:#34c759;font-size:13px;text-align:center;margin-top:10px;min-height:18px}
.tip{margin-top:16px;font-size:12px;color:#8b96a3;text-align:center;line-height:1.7}
</style>
</head>
<body>
<div class="card" id="loginCard">
<h1>&#128274; 管理员逃生入口</h1>
<div class="sub">当前 IP 被访问控制拦截时,<br>输入管理员密钥即可解锁并管理</div>
<input type="password" id="pass" placeholder="管理员密钥" autocomplete="off">
<button onclick="go()">解锁</button>
<div class="err" id="err"></div>
</div>
<div class="card" id="manageCard" style="display:none; max-width:460px;">
<h1>&#9881; IP 访问控制</h1>
<div class="sub">你的 IP <b id="myIp" style="color:#fff;">-</b> 已加入最高白名单,<br>任何模式都可访问面板与节点</div>
<div class="row">
<label><input type="radio" name="m" value="off" style="accent-color:#4da3ff;"> 关闭</label>
<label><input type="radio" name="m" value="whitelist" style="accent-color:#4da3ff;"> 白名单</label>
<label><input type="radio" name="m" value="blacklist" style="accent-color:#4da3ff;"> 黑名单</label>
</div>
<textarea id="ips" placeholder="IP / 网段,每行一个,支持 CIDR&#10;如: 1.2.3.4&#10;5.6.7.0/24"></textarea>
<input type="text" id="countries" placeholder="国家/地区码,每行一个 ISO 两位码,如 US、RU、CN">
<input type="text" id="redirect" placeholder="跳转网址(被拦截时 302 跳转)">
<div style="margin-bottom:12px; border-top:1px solid rgba(255,255,255,.12); padding-top:12px;">
<div style="font-size:13px; font-weight:600; margin-bottom:6px;">最高白名单</div>
<div style="font-size:12px; color:#8b96a3; margin-bottom:8px; line-height:1.6;">你的 IP 已自动加入。共享节点的其他 IP 可在此删除,修改后点保存生效。</div>
<div id="tList" style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px;"></div>
<div style="display:flex; gap:8px;">
<input type="text" id="tAdd" placeholder="输入要添加的 IP" style="flex:1; margin-bottom:0;">
<button onclick="tAddOne()" style="width:auto; padding:12px 14px; font-size:13px; background:rgba(255,255,255,.12);">添加</button>
</div>
</div>
<button onclick="save()">保存设置</button>
<div class="ok" id="sOk"></div>
<div class="err" id="sErr"></div>
<button class="ghost" onclick="goPanel()">进入面板 &rarr;</button>
<div class="tip">最高白名单在登录时自动加入;<br>此入口不受 IP 封锁影响</div>
</div>
<script>
function $(id){return document.getElementById(id);}
async function go(){
  var p=$('pass').value.trim();
  var err=$('err');
  if(!p){err.textContent='请输入密钥';return;}
  try{
    var r=await fetch('/api/entry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:p})});
    var d=await r.json();
    if(d.success){
      err.textContent='';
      $('loginCard').style.display='none';
      $('manageCard').style.display='block';
      $('myIp').textContent=d.currentIp||'-';
      loadCfg();
    }else{err.textContent=d.error||'解锁失败';}
  }catch(e){err.textContent='请求失败: '+e.message;}
}
var ENTRY_TRUSTED=[];
function escHtmlE(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function renderTList(){
  var box=$('tList');
  if(!box)return;
  if(!ENTRY_TRUSTED.length){box.innerHTML='<div style="font-size:12px;color:#8b96a3;">暂无信任 IP</div>';return;}
  box.innerHTML=ENTRY_TRUSTED.map(function(ip){return '<div style="display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:5px 8px;background:rgba(255,255,255,.06);border-radius:6px;gap:8px;"><span style="word-break:break-all;">'+escHtmlE(ip)+'</span><button onclick="tDel(this)" data-ip="'+escHtmlE(ip)+'" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:13px;flex-shrink:0;">✕</button></div>';}).join('');
}
function tDel(btn){var ip=btn.getAttribute('data-ip');if(!ip)return;ENTRY_TRUSTED=ENTRY_TRUSTED.filter(function(x){return x!==ip;});renderTList();}
function tAddOne(){var v=$('tAdd').value.trim();if(!v)return;if(ENTRY_TRUSTED.indexOf(v)<0)ENTRY_TRUSTED.push(v);$('tAdd').value='';renderTList();}
async function loadCfg(){
  try{
    var r=await fetch('/api/ipguard');
    var d=await r.json();
    if(!d.success)return;
    var radios=document.querySelectorAll('input[name=m]');
    for(var i=0;i<radios.length;i++){radios[i].checked=(radios[i].value===d.mode);}
    $('ips').value=(d.ips||[]).join('\\n');
    $('countries').value=(d.countries||[]).join('\\n');
    $('redirect').value=d.redirect||'';
    ENTRY_TRUSTED=(d.trusted||[]).slice();
    renderTList();
  }catch(e){}
}
async function save(){
  var mode='off';
  var radios=document.querySelectorAll('input[name=m]');
  for(var i=0;i<radios.length;i++){if(radios[i].checked)mode=radios[i].value;}
  var ips=$('ips').value.split('\\n').map(function(x){return x.trim();}).filter(Boolean);
  var countries=$('countries').value.split('\\n').map(function(x){return x.trim().toUpperCase();}).filter(Boolean);
  var redirect=$('redirect').value.trim();
  $('sOk').textContent='';
  $('sErr').textContent='';
  try{
    var r=await fetch('/api/ipguard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:mode,ips:ips,countries:countries,redirect:redirect,trusted:ENTRY_TRUSTED})});
    var d=await r.json();
    if(d.success){$('sOk').textContent='设置已保存';}else{$('sErr').textContent='保存失败: '+(d.error||'');}
  }catch(e){$('sErr').textContent='保存失败: '+e.message;}
}
function goPanel(){location.href='/';}
$('pass').addEventListener('keydown',function(e){if(e.key==='Enter'){go();}});
</script>
</body>
</html>`;

function nowStr() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').split('.')[0];
}

/* ==========================================================
 * 反代引擎
 * ========================================================== */
const MEDIA_PATH_RE = /(\/videos\/|\/stream\/|\/audio\/|\/subtitles\/|\.m3u8|\.ts(\?|$)|\.mp4(\?|$)|\.mkv(\?|$)|\.flv(\?|$))/i;
const RELAY_ORIGIN_TTL = 6 * 60 * 60 * 1000;
const RELAY_ORIGIN_LIMIT = 32;
const STREAM_STALL_MS = Math.max(1000, Number(process.env.STREAM_STALL_MS) || 5 * 60 * 1000);
const relayOriginsByRoute = new Map();

function originMatches(origins, url) {
  return (origins || []).includes(url.origin) || (origins || []).includes(url.host);
}

function rememberRelayOrigins(routeKey, origins) {
  if (!routeKey || !Array.isArray(origins) || !origins.length) return;
  const now = Date.now();
  let bucket = relayOriginsByRoute.get(routeKey);
  if (!bucket) {
    bucket = new Map();
    relayOriginsByRoute.set(routeKey, bucket);
  }
  for (const [origin, ts] of bucket) if (now - ts > RELAY_ORIGIN_TTL) bucket.delete(origin);
  for (const item of origins) {
    if (!item || !item.origin) continue;
    bucket.delete(item.origin);
    bucket.set(item.origin, now);
  }
  while (bucket.size > RELAY_ORIGIN_LIMIT) bucket.delete(bucket.keys().next().value);
  while (relayOriginsByRoute.size > 256) relayOriginsByRoute.delete(relayOriginsByRoute.keys().next().value);
}

function isRememberedRelayOrigin(routeKey, origin) {
  const bucket = relayOriginsByRoute.get(routeKey);
  if (!bucket) return false;
  const ts = bucket.get(origin);
  if (!ts || Date.now() - ts > RELAY_ORIGIN_TTL) {
    if (ts) bucket.delete(origin);
    return false;
  }
  return true;
}

function isRelayStreamUrl(raw, baseUrl, frontOrigins, backendOrigins, selfHost, routeKey) {
  try {
    const u = new URL(raw, baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    if (selfHost && u.host === selfHost) return null;
    const external = !originMatches(frontOrigins, u);
    const mediaLike = MEDIA_PATH_RE.test(u.pathname) || MEDIA_PATH_RE.test(u.href)
      || originMatches(backendOrigins, u) || isRememberedRelayOrigin(routeKey, u.origin);
    return external && mediaLike ? u : null;
  } catch (_) {
    return null;
  }
}

function sanitizeUpstreamHeaders(headers) {
  const out = Object.fromEntries(headers.entries());
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade']) delete out[name];
  return out;
}

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

function getMediaOriginEntries(values) {
  const found = [];
  const push = (origin) => {
    try {
      const u = new URL(origin);
      if (!found.some(x => x.origin === u.origin)) found.push({ origin: u.origin, host: u.host });
    } catch (_) {}
  };
  for (const raw of values || []) {
    try {
      const u = new URL(raw);
      push(u.origin);
      push(u.origin.replace(/^https:\/\//i, 'http://'));
      push(u.origin.replace(/^http:\/\//i, 'https://'));
    } catch (_) {}
  }
  return found;
}

/** 文本 URL 重写：源站地址 → 面板地址
 *  已知源站（target/前后端域名）→ 形式A：/前缀/路径（同源简洁）
 *  自动识别的未知媒体源站 → 形式B：/前缀/完整源站URL（前后端分离自动反代回源） */
function rewriteUrlsInText(text, knownOrigins, mediaOrigins, proxyOrigin, prefix) {
  if (!text) return text;
  const ptp = proxyUrlPrefix();
  // 先替换自动识别的未知媒体源站（形式B），避免被形式A 误伤
  for (const m of mediaOrigins || []) {
    if (!m || !m.origin) continue;
    const ref = `${proxyOrigin}/${ptp}${prefix}/${m.origin}`;
    text = text.split(m.origin).join(ref);
  }
  for (const origin of knownOrigins || []) {
    if (!origin) continue;
    const panelRef = `${proxyOrigin}/${ptp}${prefix}`;
    text = text.split(origin).join(panelRef);
  }
  return text;
}

/** 优先解析 JSON URL 字段，文件名含括号/逗号或无扩展名时也能识别媒体源站。 */
function extractMediaOrigins(text, knownOrigins) {
  const found = [];
  const seen = new Set();
  const known = new Set(knownOrigins || []);
  const add = (raw, mediaField) => {
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol) || known.has(u.origin) || known.has(u.host)) return;
      if (mediaField || MEDIA_PATH_RE.test(u.pathname) || MEDIA_PATH_RE.test(u.href)) {
        if (!seen.has(u.origin)) { seen.add(u.origin); found.push({ origin: u.origin, host: u.host }); }
      }
    } catch (_) {}
  };
  try {
    const value = JSON.parse(text);
    const queue = [{ value, key: '', depth: 0 }];
    let count = 0;
    while (queue.length && count++ < 20000) {
      const item = queue.pop();
      if (typeof item.value === 'string') {
        add(item.value, /^(DirectStreamUrl|TranscodingUrl|MediaUrl|stream_url|media_url)$/i.test(item.key));
      } else if (item.value && typeof item.value === 'object' && item.depth < 32) {
        for (const [key, child] of Object.entries(item.value)) queue.push({ value: child, key, depth: item.depth + 1 });
      }
    }
  } catch (_) {
    const re = /https?:\/\/[^\s"'<>}\]\\]+/g;
    let m;
    while ((m = re.exec(text)) !== null) add(m[0].replace(/[.,;:!?]+$/, ''), false);
  }
  return found;
}

/* ---------- 上游请求 ---------- */
async function buildUpstreamCandidates(target, remainingPath, search) {
  const candidates = [];
  // 形式 B 的 target 已是完整媒体 URL，必须保留末尾斜杠和签名路径。
  let base = remainingPath ? target.replace(/\/+$/, '') : target;
  // remainingPath 为空时不能再补一个 /。
  const p = remainingPath ? (remainingPath.startsWith('/') ? remainingPath : '/' + remainingPath) : '';
  candidates.push(base + p + search);
  // 仅普通节点路径尝试 /emby 回退；完整 URL 不回退，避免媒体地址被二次拼接。
  if (p && !/^\/emby(\/|$)/i.test(p)) {
    candidates.push(base + '/emby' + p + search);
  }
  return candidates;
}

async function proxyOnce(targetUrlStr, req, mode, realIp, originHost, signal, forwardCredentials = true) {
  const targetUrl = new URL(targetUrlStr);
  const headers = new Headers();

  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (['host', 'cookie', 'connection', 'content-length', 'transfer-encoding',
         'upgrade', 'http2-settings', 'proxy-connection', 'keep-alive'].includes(k)) continue;
    if (!forwardCredentials && ['authorization', 'x-emby-token', 'x-mediabrowser-token',
      'x-emby-authorization', 'x-mediabrowser-authorization', 'x-api-key'].includes(k.toLowerCase())) continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else headers.set(k, String(v));
  }

  // 去掉面板自身 cookie
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .filter(c => !c.toLowerCase().startsWith('admin_token='));
  if (forwardCredentials && cookies.length) headers.set('Cookie', cookies.join('; '));

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

  const init = { method: req.method, headers, redirect: 'manual', signal };
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
function proxyUrlPrefix() {
  const pt = config.proxyToken || {};
  return (pt.enabled && pt.key) ? pt.key + '/' : '';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function recordProxyHit(req, path) {
  if (!config.proxyHits) config.proxyHits = [];
  const ip = getClientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 200);
  const now = Date.now();
  const hit = config.proxyHits.find(h => h.ip === ip && h.path === path);
  if (hit) { hit.times = (hit.times || 1) + 1; hit.ts = now; }
  else config.proxyHits.unshift({ ip, path: String(path).slice(0, 200), ua, ts: now, times: 1 });
  if (config.proxyHits.length > 500) config.proxyHits.length = 500;
  persistConfig();
}
async function handleProxy(req, res, pathname, search) {
  // 路径保留百分号编码：整体 decode 会把签名文件路径里的 %2F/%3F 改成分隔符。
  let decodedPath = pathname;
  // 反代 Token 门禁：开启后路径必须带 /密钥/ 前缀才可反代
  const pt = config.proxyToken || {};
  if (pt.enabled && pt.key) {
    const prefixPath = '/' + pt.key + '/';
    let stripped = null;
    if (decodedPath === '/' + pt.key) stripped = '/';
    else if (decodedPath.indexOf(prefixPath) === 0) stripped = decodedPath.slice(prefixPath.length - 1);
    if (stripped === null) {
      recordProxyHit(req, decodedPath);
      res.writeHead(302, { Location: '/catch', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    decodedPath = stripped;
  }
  let targetUrls = [];
  let configuredTargets = [];
  let remainingPath = '';
  let matchedPrefix = null;
  let mode = 'off';
  let enableCache = true;
  let ipv6Mode = 'auto';
  let relayMedia = true;
  const proxyOrigin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;

  if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
    targetUrls = [decodedPath.substring(1)];
    remainingPath = '';
  } else {
    const parts = decodedPath.split('/');
    let prefix = parts[1];
    try { prefix = decodeURIComponent(prefix || ''); } catch (_) {}
    if (!prefix) return sendText(res, 404, 'Not Found');
    const route = routes.find(r => r.prefix === prefix);
    if (!route) return sendText(res, 404, 'Not Found');
    matchedPrefix = prefix;
    mode = route.mode || 'off';
    enableCache = route.cache_img !== 'off';
    ipv6Mode = route.v6 || 'auto';
    relayMedia = route.relay_media !== 'off';
    remainingPath = '/' + parts.slice(2).join('/');
    targetUrls = (route.target || '').split(',').map(s => s.trim()).filter(Boolean);
    configuredTargets = targetUrls.slice();
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
  // 前端/节点源站走简洁形式 A；显式后端和自动识别媒体源站走完整 URL 形式 B。
  const frontOrigins = getTargetOrigins(targetUrls, [config.frontendDomain]);
  const backendOrigins = getTargetOrigins([], [config.backendDomain]);
  const configuredMediaOrigins = getMediaOriginEntries([config.backendDomain]);
  const credentialOrigins = getTargetOrigins(configuredTargets, [config.frontendDomain, config.backendDomain]);

  let lastError = null;

  for (const target of targetUrls) {
    const candidates = await buildUpstreamCandidates(target, remainingPath, search);

    for (let j = 0; j < candidates.length; j++) {
      const candidateUrl = candidates[j];
      let upstreamRes = null;
      let targetUrlObj = null;
      let controller = null;
      let downstreamAborted = false;
      const abortUpstream = () => {
        if (downstreamAborted || res.writableEnded) return;
        downstreamAborted = true;
        if (controller && !controller.signal.aborted) controller.abort();
        if (upstreamRes && upstreamRes.body) {
          Promise.resolve(upstreamRes.body.cancel()).catch(() => {});
        }
      };
      const onRequestAborted = () => abortUpstream();
      const onResponseClosed = () => {
        if (!res.writableEnded) abortUpstream();
      };

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

        controller = new AbortController();
        req.once('aborted', onRequestAborted);
        res.once('close', onResponseClosed);
        if (req.aborted || res.destroyed) {
          abortUpstream();
          return;
        }
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
            upstreamRes = await proxyOnce(requestUrl, req, mode, realIp, originHost, controller.signal, originMatches(credentialOrigins, targetUrl));
          } catch (e) {
            if (controller.signal.aborted) throw e;
            if (requestUrl !== candidateUrl) {
              upstreamRes = await proxyOnce(candidateUrl, req, mode, realIp, null, controller.signal, originMatches(credentialOrigins, targetUrl));
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

        const upstreamHeaders = sanitizeUpstreamHeaders(upstreamRes.headers);

        // redirect 改写：默认让媒体 302 经 VPS；节点可显式关闭并让客户端直连。
        if (status >= 300 && status < 400) {
          const loc = upstreamRes.headers.get('location');
          let rewrittenLoc = loc
            ? rewriteUrlsInText(loc, frontOrigins, [], proxyOrigin, matchedPrefix || '')
            : undefined;
          // 相对 Location 也必须补回节点前缀，否则客户端会跳到面板根路径。
          if (loc) {
            try {
              const resolvedLoc = new URL(loc, candidateUrl);
              if (originMatches(frontOrigins, resolvedLoc)) {
                const prefixPart = matchedPrefix ? matchedPrefix + '/' : '';
                rewrittenLoc = `${proxyOrigin}/${proxyUrlPrefix()}${prefixPart}${resolvedLoc.pathname.replace(/^\/+/, '')}${resolvedLoc.search}`;
              }
            } catch (_) {}
          }
          const relayUrl = loc && isRelayStreamUrl(
            loc, candidateUrl, frontOrigins, backendOrigins, req.headers.host, matchedPrefix || ''
          );
          if (relayUrl) {
            if (relayMedia) {
              rememberRelayOrigins(matchedPrefix || '', [{ origin: relayUrl.origin, host: relayUrl.host }]);
              const prefixPart = matchedPrefix ? matchedPrefix + '/' : '';
              rewrittenLoc = `${proxyOrigin}/${proxyUrlPrefix()}${prefixPart}${relayUrl.origin}${relayUrl.pathname}${relayUrl.search}`;
            } else {
              rewrittenLoc = relayUrl.href;
            }
          }
          if (upstreamRes.body) {
            try { await upstreamRes.body.cancel(); } catch (_) {}
          }
          const headersOut = { ...upstreamHeaders };
          delete headersOut['location'];
          delete headersOut['content-length'];
          delete headersOut['content-encoding'];
          headersOut['content-length'] = '0';
          headersOut['cache-control'] = 'no-store';
          if (rewrittenLoc) headersOut['location'] = rewrittenLoc;
          res.writeHead(status, headersOut);
          res.end();
          return;
        }

        // 文本类响应：按节点策略改写并按节点隔离学习媒体源站。
        const ct = upstreamRes.headers.get('content-type') || '';
        if (/json|javascript|xml|text/i.test(ct)) {
          const buf = Buffer.from(await upstreamRes.arrayBuffer());
          const text = buf.toString('utf8');
          const mediaFound = extractMediaOrigins(text, frontOrigins);
          for (const item of configuredMediaOrigins) {
            if (!originMatches(frontOrigins, new URL(item.origin)) && !mediaFound.some(x => x.origin === item.origin)) mediaFound.push(item);
          }
          if (relayMedia) rememberRelayOrigins(matchedPrefix || '', mediaFound);
          const rewritten = rewriteUrlsInText(
            text, frontOrigins, relayMedia ? mediaFound : [], proxyOrigin, matchedPrefix || ''
          );

          const headersOut = { ...upstreamHeaders };
          delete headersOut['content-length'];
          delete headersOut['content-encoding'];
          headersOut['content-length'] = String(Buffer.byteLength(rewritten));
          headersOut['cache-control'] = 'no-store';
          res.writeHead(status, headersOut);
          res.end(rewritten);
          return;
        }

        // 静态资源缓存（非鉴权）
        if (isStatic && enableCache && !authLike && req.method === 'GET' && status === 200) {
          const buf = Buffer.from(await upstreamRes.arrayBuffer());
          const headersOut = { ...upstreamHeaders };
          delete headersOut['content-length'];
          delete headersOut['content-encoding'];
          headersOut['content-length'] = String(buf.length);
          headersOut['cache-control'] = 'public, max-age=86400';
          putCache(candidateUrl, buf, headersOut);
          res.writeHead(status, headersOut);
          res.end(buf);
          return;
        }

        // 其他（媒体流等）：流式透传。严格遵守背压；下游断开时立刻取消上游。
        res.writeHead(status, upstreamHeaders);
        if (upstreamRes.body) {
          for await (const chunk of upstreamRes.body) {
            if (downstreamAborted || res.destroyed) break;
            if (!res.write(Buffer.from(chunk))) {
              await new Promise((resolve, reject) => {
                let stallTimer = null;
                const cleanup = () => {
                  if (stallTimer) clearTimeout(stallTimer);
                  res.removeListener('drain', onDrain);
                  res.removeListener('close', onClose);
                  res.removeListener('error', onError);
                };
                const onDrain = () => { cleanup(); resolve(); };
                const onClose = () => { cleanup(); reject(new Error('下游连接已断开')); };
                const onError = (err) => { cleanup(); reject(err); };
                stallTimer = setTimeout(() => {
                  cleanup();
                  reject(new Error('下游长时间无写入进展'));
                }, STREAM_STALL_MS);
                if (stallTimer.unref) stallTimer.unref();
                res.once('drain', onDrain);
                res.once('close', onClose);
                res.once('error', onError);
              });
            }
          }
        }
        if (!downstreamAborted && !res.writableEnded) res.end();
        return;
      } catch (e) {
        // 客户端主动退出/拖动后不再尝试候选线路，也不能向已关闭的响应写 502。
        if (downstreamAborted || res.destroyed) return;
        // 响应头或部分媒体已经发给客户端后，不能再拼接下一条候选线路。
        if (res.headersSent) {
          if (!res.destroyed) res.destroy(e);
          return;
        }
        lastError = e;
        if (e.name === 'AbortError') lastError = new Error('上游超时: ' + candidateUrl);
        // 继续尝试下一个候选
        continue;
      } finally {
        req.removeListener('aborted', onRequestAborted);
        res.removeListener('close', onResponseClosed);
      }
    }
  }

  if (res.destroyed || res.writableEnded) return;
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

  // /api/entry:逃生登录(无需认证,只认 adminToken,adminPass 仅兜底)
  if (url.pathname === '/api/entry' && req.method === 'POST') {
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const pass = String(body.pass || '');
    let adminPass = config.adminToken || '';
    if (!adminPass && config.adminPass) adminPass = config.adminPass;
    if (pass && pass === adminPass) {
      const clientIp = getClientIp(req);
      if (clientIp && clientIp !== 'Unknown') {
        const t = config.ipguardTrusted || [];
        if (t.indexOf(clientIp) < 0) { t.push(clientIp); config.ipguardTrusted = t; persistConfig(); }
      }
      setAuthCookie(res, pass);
      return sendJSON(res, 200, { success: true, currentIp: clientIp });
    }
    return sendJSON(res, 200, { success: false, error: '密钥错误' });
  }

  // /api/ipguard:GET 任意可读(逃生页未登录需读配置);POST 仅管理员
  if (url.pathname === '/api/ipguard' && req.method === 'GET') {
    const guard = config.ipguard || { mode: 'off', ips: [], countries: [], redirect: '' };
    return sendJSON(res, 200, {
      success: true,
      mode: guard.mode,
      ips: guard.ips || [],
      countries: guard.countries || [],
      redirect: guard.redirect || '',
      trusted: config.ipguardTrusted || [],
      currentIp: getClientIp(req),
      currentCountry: getClientCountry(req),
    });
  }
  if (url.pathname === '/api/ipguard' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    const mode = ['off', 'whitelist', 'blacklist'].includes(body.mode) ? body.mode : 'off';
    const ips = Array.isArray(body.ips) ? body.ips.map(String).map(x => x.trim()).filter(Boolean) : [];
    const countries = Array.isArray(body.countries) ? body.countries.map(String).map(x => x.trim().toUpperCase()).filter(Boolean) : [];
    const redirect = String(body.redirect || '').trim();
    config.ipguard = { mode, ips, countries, redirect };
    if (Array.isArray(body.trusted)) config.ipguardTrusted = body.trusted.map(String).map(x => x.trim()).filter(Boolean);
    persistConfig();
    return sendJSON(res, 200, { success: true });
  }

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

  // 版本信息与 GitHub 一键更新
  if (url.pathname === '/api/version' && req.method === 'GET') {
    if (!updateCtl) return sendJSON(res, 200, { current: APP_VERSION, available: false, supported: false, error: 'updater.js 未安装' });
    try {
      const state = url.searchParams.get('check') === '1' ? await updateCtl.check() : updateCtl.snapshot();
      return sendJSON(res, 200, Object.assign({ supported: true }, state));
    } catch (error) {
      return sendJSON(res, 502, { success: false, current: APP_VERSION, error: '检查更新失败: ' + error.message });
    }
  }
  if (url.pathname === '/api/update' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    if (!updateCtl) return sendJSON(res, 503, { success: false, error: 'updater.js 未安装' });
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (_) { return {}; } });
    try {
      return sendJSON(res, 202, Object.assign({ success: true }, updateCtl.start(!!body.force)));
    } catch (error) {
      return sendJSON(res, 409, { success: false, error: error.message });
    }
  }

  // TG Persona（关键词回复/保号/自动化任务/监听等，动态加载，缺文件则 404）
  if (url.pathname.indexOf('/api/tg-persona') === 0) {
    const ph = personaApi();
    if (ph) return ph(req, res, url, role);
    return sendJSON(res, 404, { success: false, error: 'TG Persona 模块未安装（缺少 tg-persona.js）' });
  }

  // TG bot 签到（MTProto）
  if (url.pathname.indexOf('/api/tg') === 0) return tgApi(req, res, url, role);

  if (url.pathname === '/api/me' && req.method === 'GET') {
    return sendJSON(res, 200, { success: true, role });
  }

  if (url.pathname === '/api/account' && req.method === 'POST') {
    if (!needAdmin(url.pathname)) return;
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    if (body.proxyToken !== undefined) {
      const pt = body.proxyToken;
      const enabled = !!pt.enabled;
      const key = String(pt.key || '').trim();
      if (enabled && !/^[A-Za-z0-9]{3,32}$/.test(key)) return sendJSON(res, 400, { success: false, error: '密钥需 3-32 位字母数字' });
      config.proxyToken = { enabled, key };
      persistConfig();
      return sendJSON(res, 200, { success: true });
    }
    const pw = String(body.password || '').trim();
    if (pw.length < 4) return sendJSON(res, 400, { success: false, error: '密码至少 4 位' });
    config.adminPass = pw;
    persistConfig();
    return sendJSON(res, 200, { success: true });
  }

  // 反代 Token 状态（登录可见：订阅者也需知道节点链接前缀；未登录不泄漏）
  if (url.pathname === '/api/proxytoken' && req.method === 'GET') {
    const pt = config.proxyToken || {};
    return sendJSON(res, 200, { success: true, enabled: !!(pt.enabled && pt.key), key: (pt.enabled && pt.key) ? pt.key : '' });
  }
  // 来访记录 IP（仅管理员）
  if (url.pathname === '/api/proxytoken/hits' && req.method === 'GET') {
    if (role !== 'admin') return sendJSON(res, 403, { success: false, error: 'Forbidden' });
    return sendJSON(res, 200, { success: true, hits: config.proxyHits || [] });
  }
  if (url.pathname === '/api/proxytoken/hits' && req.method === 'POST') {
    if (role !== 'admin') return sendJSON(res, 403, { success: false, error: 'Forbidden' });
    const body = await readBody(req).then(b => { try { return JSON.parse(b.toString()); } catch (e) { return {}; } });
    if (body.clear) { config.proxyHits = []; persistConfig(); }
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
      if (existing.target !== target) relayOriginsByRoute.delete(prefix);
      existing.target = target;
      existing.mode = body.mode || existing.mode || 'off';
      existing.cache_img = body.cache_img !== undefined ? body.cache_img : existing.cache_img;
      if (body.relay_media !== undefined) existing.relay_media = body.relay_media === 'off' ? 'off' : 'on';
      if (body.v6 !== undefined) existing.v6 = body.v6;
      if (body.icon !== undefined) existing.icon = body.icon;
    } else {
      routes.push({
        prefix,
        target,
        mode: body.mode || 'off',
        cache_img: body.cache_img !== undefined ? body.cache_img : true,
        relay_media: body.relay_media === 'off' ? 'off' : 'on',
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
    relayOriginsByRoute.delete(prefix || '');
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
      relay_media: r.relay_media === 'off' ? 'off' : 'on',
      v6: r.v6 || 'auto',
      icon: r.icon || '',
      sort_order: r.sort_order || 1,
      createdAt: r.createdAt || nowStr(),
    })).filter(r => r.prefix && r.target);
    relayOriginsByRoute.clear();
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

    // ===== IP 访问控制(与 CF 版一致:面板 + 节点统一拦截;保留后缀不拦;无 cookie 逃生) =====
    if (!isIpGuardBypass(url.pathname)) {
      const guard = config.ipguard || { mode: 'off' };
      if (guard.mode !== 'off') {
        const clientIp = getClientIp(req);
        if (clientIp && clientIp !== 'Unknown') {
          const trusted = config.ipguardTrusted || [];
          if (trusted.indexOf(clientIp) < 0) {
            const country = getClientCountry(req);
            const hit = ipMatchAny(clientIp, guard.ips) || (country && (guard.countries || []).indexOf(country) >= 0);
            const blocked = guard.mode === 'whitelist' ? !hit : hit;
            if (blocked) {
              if (guard.redirect) { res.writeHead(302, { Location: guard.redirect }); res.end(); return; }
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
              res.end(IP_BLOCKED_UI.replace('__IP__', escapeHtml(clientIp)).replace('__COUNTRY__', escapeHtml(country || '-')));
              return;
            }
          }
        }
      }
    }

    // 管理员逃生入口(不拦截)
    if (url.pathname === '/entry') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(ENTRY_UI);
      return;
    }

    // API
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }

    // 反代 Token 抓人页面
    if (url.pathname === '/catch') {
      const ip = getClientIp(req);
      const ua = (req.headers['user-agent'] || '').slice(0, 120);
      const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oops</title><style>
        body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at top,#0f0c29,#302b63,#24243e);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#fff}
        .box{text-align:center;padding:48px;border:1px solid rgba(255,255,255,.15);border-radius:20px;background:rgba(255,255,255,.05);backdrop-filter:blur(8px);max-width:90vw}
        h1{font-size:34px;margin:0 0 12px;letter-spacing:2px}
        .sub{font-size:14px;color:#a8b2d1;margin-bottom:24px}
        .ip{font-size:18px;font-weight:700;color:#ffd700;word-break:break-all}
        .meta{font-size:12px;color:#7f8bb3;margin-top:16px;word-break:break-all}
      </style></head><body><div class="box">
        <h1>宝贝抓到你了 👋</h1>
        <div class="sub">你的来访信息已被记录</div>
        <div class="ip">${escapeHtml(ip)}</div>
        <div class="meta">UA: ${escapeHtml(ua)}</div>
      </div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
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
    if (!res.headersSent && !res.destroyed) {
      try { sendText(res, 500, 'Internal Error: ' + e.message); } catch (_) {}
    } else if (!res.destroyed) {
      res.destroy(e);
    }
  }
});

/* WebSocket upgrade 透传 */
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // IP 访问控制:被拦截的 WS 连接直接断开(与节点拦截一致)
  if (!isIpGuardBypass(url.pathname)) {
    const guard = config.ipguard || { mode: 'off' };
    if (guard.mode !== 'off') {
      const clientIp = getClientIp(req);
      if (clientIp && clientIp !== 'Unknown') {
        const trusted = config.ipguardTrusted || [];
        if (trusted.indexOf(clientIp) < 0) {
          const country = getClientCountry(req);
          const hit = ipMatchAny(clientIp, guard.ips) || (country && (guard.countries || []).indexOf(country) >= 0);
          const blocked = guard.mode === 'whitelist' ? !hit : hit;
          if (blocked) { socket.destroy(); return; }
        }
      }
    }
  }
  let decodedPath = decodeURIComponent(url.pathname);
  // 反代 Token 门禁：WS 路径同样需带密钥前缀
  const pt = config.proxyToken || {};
  if (pt.enabled && pt.key) {
    const prefixPath = '/' + pt.key + '/';
    let stripped = null;
    if (decodedPath === '/' + pt.key) stripped = '/';
    else if (decodedPath.indexOf(prefixPath) === 0) stripped = decodedPath.slice(prefixPath.length - 1);
    if (stripped === null) { socket.destroy(); return; }
    decodedPath = stripped;
  }
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

/* ============ TG MTProto 内核（构建产物，勿手改） ============ */
const TGKIT = (function (module) {
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// cf-sockets.js
var require_cf_sockets = __commonJS({
  "cf-sockets.js"(exports2, module2) {
    var net = require("net");
    function connect2(addr, opts) {
      const host = addr.hostname || addr.host;
      const port = Number(addr.port);
      let ctrl = null;
      let openedResolve, openedReject, closedResolve;
      const opened = new Promise((res, rej) => {
        openedResolve = res;
        openedReject = rej;
      });
      const closed = new Promise((res) => {
        closedResolve = res;
      });
      const socket = net.connect({ host, port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy(new Error("\u8FDE\u63A5\u8D85\u65F6 " + host + ":" + port));
      }, 2e4);
      const readable = new ReadableStream({
        start(c) {
          ctrl = c;
        },
        pull() {
          socket.resume();
        },
        cancel() {
          socket.destroy();
        }
      });
      const writable = new WritableStream({
        write(chunk) {
          return new Promise((res, rej) => {
            try {
              socket.write(chunk, (err) => err ? rej(err) : res());
            } catch (e) {
              rej(e);
            }
          });
        },
        close() {
          socket.end();
        },
        abort() {
          socket.destroy();
        }
      });
      socket.on("connect", () => {
        clearTimeout(timer);
        openedResolve();
        socket.resume();
      });
      socket.on("data", (d) => {
        socket.pause();
        try {
          ctrl.enqueue(new Uint8Array(d));
        } catch (e) {
        }
      });
      socket.on("error", (e) => {
        clearTimeout(timer);
        openedReject(e);
        try {
          ctrl.error(e);
        } catch (x) {
        }
      });
      socket.on("close", () => {
        clearTimeout(timer);
        closedResolve();
        try {
          ctrl.close();
        } catch (e) {
        }
      });
      return {
        readable,
        writable,
        opened,
        closed,
        close() {
          try {
            socket.destroy();
          } catch (e) {
          }
          return Promise.resolve();
        }
      };
    }
    module2.exports = { connect: connect2 };
  }
});

// entry.js
var entry_exports = {};
__export(entry_exports, {
  MTProtoClient: () => MTProtoClient,
  TLReader: () => TLReader,
  TLWriter: () => TLWriter,
  checkAccount: () => checkAccount,
  parseProxyUrl: () => parseProxyUrl,
  runTasks: () => runTasks
});
module.exports = __toCommonJS(entry_exports);

// src/mtp.js
var import_cloudflare_sockets = __toESM(require_cf_sockets());
var TEXT_ENC = new TextEncoder();
var TEXT_DEC = new TextDecoder();
var TG_DCS = {
  1: { ip: "149.154.175.53", port: 443 },
  2: { ip: "149.154.167.50", port: 443 },
  3: { ip: "149.154.175.100", port: 443 },
  4: { ip: "149.154.167.91", port: 443 },
  5: { ip: "91.108.56.130", port: 443 }
};
var TG_RSA_KEYS = [
  {
    fpBytes: new Uint8Array([133, 253, 100, 222, 133, 29, 157, 208]),
    fpHex: "85fd64de851d9dd0",
    e: 65537n,
    n: BigInt("0xe8bb3305c0b52c6cf2afdf7637313489e63e05268e5badb601af417786472e5f93b85438968e20e6729a301c0afc121bf7151f834436f7fda680847a66bf64accec78ee21c0b316f0edafe2f41908da7bd1f4a5107638eeb67040ace472a14f90d9f7c2b7def99688ba3073adb5750bb02964902a359fe745d8170e36876d4fd8a5d41b2a76cbff9a13267eb9580b2d06d10357448d20d9da2191cb5d8c93982961cdfdeda629e37f1fb09a0722027696032fe61ed663db7a37f6f263d370f69db53a0dc0a1748bdaaff6209d5645485e6e001d1953255757e4b8e42813347b11da6ab500fd0ace7e6dfa3736199ccaf9397ed0745a427dcfa6cd67bcb1acff3")
  }
];
var MTPROTO_LAYER = 158;
function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >>> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function bytesToBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBytes(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}
function bytesToBigIntBE(bytes) {
  const hex = bytesToHex(bytes);
  return hex ? BigInt("0x" + hex) : 0n;
}
function bigIntToBytesBE(num, length) {
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const raw = hexToBytes(hex);
  if (!length) return raw;
  if (raw.length === length) return raw;
  if (raw.length > length) return raw.subarray(raw.length - length);
  const out = new Uint8Array(length);
  out.set(raw, length - raw.length);
  return out;
}
function modPow(base, exp, mod) {
  let result = 1n;
  let b = (base % mod + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = result * b % mod;
    e >>= 1n;
    b = b * b % mod;
  }
  return result;
}
function gcdBigInt(a, b) {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a < 0n ? -a : a;
}
function factorizePQ(pqBytes) {
  const n = bytesToBigIntBE(pqBytes);
  if (n % 2n === 0n) {
    const p2 = 2n, q2 = n / 2n;
    return p2 < q2 ? [bigIntToBytesBE(p2), bigIntToBytesBE(q2)] : [bigIntToBytesBE(q2), bigIntToBytesBE(p2)];
  }
  let g = 1n;
  for (let c = 1n; c < 64n && g === 1n; c++) {
    let x = 2n, y = 2n, d = 1n;
    const f = (v) => (v * v + c) % n;
    while (d === 1n) {
      x = f(x);
      y = f(f(y));
      const diff = x > y ? x - y : y - x;
      d = gcdBigInt(diff, n);
    }
    if (d !== n) {
      g = d;
      break;
    }
  }
  const other = n / g;
  const p = g < other ? g : other;
  const q = g < other ? other : g;
  return [bigIntToBytesBE(p), bigIntToBytesBE(q)];
}
async function sha1(data) {
  const buf = await crypto.subtle.digest("SHA-1", data);
  return new Uint8Array(buf);
}
async function sha256(data) {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}
var CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let crc = 4294967295;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
var [AES_SBOX, AES_INV_SBOX] = (() => {
  const sbox = new Uint8Array(256);
  const inv = new Uint8Array(256);
  const rotl8 = (x, sh) => (x << sh | x >>> 8 - sh) & 255;
  let p = 1, q = 1;
  for (let i = 0; i < 255; i++) {
    p = p ^ p << 1 ^ (p & 128 ? 283 : 0);
    p &= 255;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q ^= q & 128 ? 9 : 0;
    q &= 255;
    const xformed = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 99) & 255;
    sbox[p] = xformed;
    inv[xformed] = p;
  }
  sbox[0] = 99;
  inv[99] = 0;
  return [sbox, inv];
})();
function xtime(a) {
  return (a & 128 ? a << 1 ^ 283 : a << 1) & 255;
}
function gmul(a, b) {
  let res = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) res ^= a;
    a = xtime(a);
    b >>>= 1;
  }
  return res;
}
function expandKey256(key) {
  const w = new Uint8Array(240);
  w.set(key.subarray(0, 32), 0);
  let rcon = 1;
  for (let i = 8; i < 60; i++) {
    const prev = (i - 1) * 4;
    let t0 = w[prev], t1 = w[prev + 1], t2 = w[prev + 2], t3 = w[prev + 3];
    if (i % 8 === 0) {
      const tmp = t0;
      t0 = AES_SBOX[t1] ^ rcon;
      t1 = AES_SBOX[t2];
      t2 = AES_SBOX[t3];
      t3 = AES_SBOX[tmp];
      rcon = xtime(rcon);
    } else if (i % 8 === 4) {
      t0 = AES_SBOX[t0];
      t1 = AES_SBOX[t1];
      t2 = AES_SBOX[t2];
      t3 = AES_SBOX[t3];
    }
    const base = (i - 8) * 4;
    const dst = i * 4;
    w[dst] = w[base] ^ t0;
    w[dst + 1] = w[base + 1] ^ t1;
    w[dst + 2] = w[base + 2] ^ t2;
    w[dst + 3] = w[base + 3] ^ t3;
  }
  return w;
}
function aes256EncryptBlock(block, w) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ w[i];
  const t = new Uint8Array(16);
  for (let r = 1; r <= 14; r++) {
    t[0] = AES_SBOX[s[0]];
    t[1] = AES_SBOX[s[5]];
    t[2] = AES_SBOX[s[10]];
    t[3] = AES_SBOX[s[15]];
    t[4] = AES_SBOX[s[4]];
    t[5] = AES_SBOX[s[9]];
    t[6] = AES_SBOX[s[14]];
    t[7] = AES_SBOX[s[3]];
    t[8] = AES_SBOX[s[8]];
    t[9] = AES_SBOX[s[13]];
    t[10] = AES_SBOX[s[2]];
    t[11] = AES_SBOX[s[7]];
    t[12] = AES_SBOX[s[12]];
    t[13] = AES_SBOX[s[1]];
    t[14] = AES_SBOX[s[6]];
    t[15] = AES_SBOX[s[11]];
    if (r < 14) {
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = t[i], a1 = t[i + 1], a2 = t[i + 2], a3 = t[i + 3];
        const h = a0 ^ a1 ^ a2 ^ a3;
        t[i] ^= h ^ xtime(a0 ^ a1);
        t[i + 1] ^= h ^ xtime(a1 ^ a2);
        t[i + 2] ^= h ^ xtime(a2 ^ a3);
        t[i + 3] ^= h ^ xtime(a3 ^ a0);
      }
    }
    const roff = r * 16;
    for (let j = 0; j < 16; j++) s[j] = t[j] ^ w[roff + j];
  }
  return s;
}
function aes256DecryptBlock(block, w) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = block[i] ^ w[224 + i];
  const t = new Uint8Array(16);
  for (let r = 13; r >= 0; r--) {
    t[0] = AES_INV_SBOX[s[0]];
    t[1] = AES_INV_SBOX[s[13]];
    t[2] = AES_INV_SBOX[s[10]];
    t[3] = AES_INV_SBOX[s[7]];
    t[4] = AES_INV_SBOX[s[4]];
    t[5] = AES_INV_SBOX[s[1]];
    t[6] = AES_INV_SBOX[s[14]];
    t[7] = AES_INV_SBOX[s[11]];
    t[8] = AES_INV_SBOX[s[8]];
    t[9] = AES_INV_SBOX[s[5]];
    t[10] = AES_INV_SBOX[s[2]];
    t[11] = AES_INV_SBOX[s[15]];
    t[12] = AES_INV_SBOX[s[12]];
    t[13] = AES_INV_SBOX[s[9]];
    t[14] = AES_INV_SBOX[s[6]];
    t[15] = AES_INV_SBOX[s[3]];
    const roff = r * 16;
    for (let j = 0; j < 16; j++) s[j] = t[j] ^ w[roff + j];
    if (r > 0) {
      for (let c = 0; c < 4; c++) {
        const i = c * 4;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }
  }
  return s;
}
function aes256IgeEncrypt(data, key, iv) {
  const w = expandKey256(key);
  const out = new Uint8Array(data.length);
  let iv1 = iv.subarray(0, 16);
  let iv2 = iv.subarray(16, 32);
  const x = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    const p = data.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) x[i] = p[i] ^ iv1[i];
    const enc = aes256EncryptBlock(x, w);
    const c = new Uint8Array(16);
    for (let i = 0; i < 16; i++) c[i] = enc[i] ^ iv2[i];
    out.set(c, off);
    iv1 = c;
    iv2 = p;
  }
  return out;
}
function aes256IgeDecrypt(data, key, iv) {
  const w = expandKey256(key);
  const out = new Uint8Array(data.length);
  let iv1 = iv.subarray(0, 16);
  let iv2 = iv.subarray(16, 32);
  const x = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    const c = data.subarray(off, off + 16);
    for (let i = 0; i < 16; i++) x[i] = c[i] ^ iv2[i];
    const dec = aes256DecryptBlock(x, w);
    const p = new Uint8Array(16);
    for (let i = 0; i < 16; i++) p[i] = dec[i] ^ iv1[i];
    out.set(p, off);
    iv1 = c;
    iv2 = p;
  }
  return out;
}
var TLWriter = class {
  constructor() {
    this.parts = [];
  }
  writeInt32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.parts.push(b);
    return this;
  }
  writeUInt32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.parts.push(b);
    return this;
  }
  writeInt64(bigVal) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(bigVal), true);
    this.parts.push(b);
    return this;
  }
  writeRaw(bytes) {
    this.parts.push(bytes);
    return this;
  }
  writeBytes(bytes) {
    const len = bytes.length;
    if (len < 254) {
      const pad = (4 - (len + 1) % 4) % 4;
      const out = new Uint8Array(1 + len + pad);
      out[0] = len;
      out.set(bytes, 1);
      this.parts.push(out);
    } else {
      const pad = (4 - len % 4) % 4;
      const out = new Uint8Array(4 + len + pad);
      out[0] = 254;
      out[1] = len & 255;
      out[2] = len >>> 8 & 255;
      out[3] = len >>> 16 & 255;
      out.set(bytes, 4);
      this.parts.push(out);
    }
    return this;
  }
  writeString(str) {
    return this.writeBytes(TEXT_ENC.encode(String(str)));
  }
  toBytes() {
    return concatBytes(...this.parts);
  }
};
var TLReader = class {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  readInt32() {
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  readUInt32() {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v >>> 0;
  }
  readInt64() {
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  readRaw(n) {
    const s = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return s;
  }
  readBytes() {
    const first = this.bytes[this.offset++];
    let len = 0;
    let pad = 0;
    if (first < 254) {
      len = first;
      pad = (4 - (len + 1) % 4) % 4;
    } else {
      len = this.bytes[this.offset] | this.bytes[this.offset + 1] << 8 | this.bytes[this.offset + 2] << 16;
      this.offset += 3;
      pad = (4 - len % 4) % 4;
    }
    const out = this.bytes.subarray(this.offset, this.offset + len);
    this.offset += len + pad;
    return out;
  }
  readString() {
    return TEXT_DEC.decode(this.readBytes());
  }
};
var CloudflareTcpTransport = class {
  constructor(proxy) {
    this.proxy = proxy || null;
    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.chunks = [];
    this.totalLen = 0;
    this.sendSeq = 0;
  }
  async connect(targetIp, targetPort) {
    this.chunks = [];
    this.totalLen = 0;
    this.sendSeq = 0;
    const useSocks = Boolean(this.proxy && this.proxy.host && this.proxy.port);
    this.socket = (0, import_cloudflare_sockets.connect)({
      hostname: useSocks ? this.proxy.host : targetIp,
      port: useSocks ? Number(this.proxy.port) : Number(targetPort)
    });
    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();
    if (useSocks) {
      const hasAuth = Boolean(this.proxy.username && this.proxy.password);
      await this.writer.write(hasAuth ? new Uint8Array([5, 2, 0, 2]) : new Uint8Array([5, 1, 0]));
      const hRes = await this.readExactly(2);
      if (hRes[0] !== 5 || hRes[1] === 255) {
        throw new Error("SOCKS5 \u4EE3\u7406\u63E1\u624B\u534F\u5546\u5931\u8D25");
      }
      if (hRes[1] === 2) {
        const u = TEXT_ENC.encode(this.proxy.username);
        const p = TEXT_ENC.encode(this.proxy.password);
        const authPkt = new Uint8Array(3 + u.length + p.length);
        authPkt[0] = 1;
        authPkt[1] = u.length;
        authPkt.set(u, 2);
        authPkt[2 + u.length] = p.length;
        authPkt.set(p, 3 + u.length);
        await this.writer.write(authPkt);
        const aRes = await this.readExactly(2);
        if (aRes[1] !== 0) throw new Error("SOCKS5 \u8D26\u53F7\u6216\u5BC6\u7801\u8BA4\u8BC1\u5931\u8D25");
      }
      const ipParts = targetIp.split(".").map(Number);
      const connReq = new Uint8Array([
        5,
        1,
        0,
        1,
        ipParts[0],
        ipParts[1],
        ipParts[2],
        ipParts[3],
        targetPort >>> 8 & 255,
        targetPort & 255
      ]);
      await this.writer.write(connReq);
      const rHead = await this.readExactly(4);
      if (rHead[1] !== 0) {
        throw new Error(`SOCKS5 \u65E0\u6CD5\u8FDE\u63A5 Telegram DC (${targetIp}:${targetPort})\uFF0C\u9519\u8BEF\u7801: ${rHead[1]}`);
      }
      if (rHead[3] === 1) await this.readExactly(6);
      else if (rHead[3] === 3) {
        const dLen = await this.readExactly(1);
        await this.readExactly(dLen[0] + 2);
      } else if (rHead[3] === 4) await this.readExactly(18);
    }
  }
  async readExactly(size) {
    while (this.totalLen < size) {
      const { value, done } = await this.reader.read();
      if (done || !value) throw new Error("\u8FDC\u7A0B Socket \u8FDE\u63A5\u5DF2\u65AD\u5F00 (EOF)");
      this.chunks.push(value);
      this.totalLen += value.length;
    }
    const combined = this.chunks.length === 1 ? this.chunks[0] : concatBytes(...this.chunks);
    const out = combined.slice(0, size);
    const rest = combined.slice(size);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.totalLen = rest.length;
    return out;
  }
  // MTProto TCP Full 协议封包发送
  async sendPacket(payload) {
    const totalLen = payload.length + 12;
    const pkt = new Uint8Array(totalLen);
    const dv = new DataView(pkt.buffer);
    dv.setInt32(0, totalLen, true);
    dv.setInt32(4, this.sendSeq++, true);
    pkt.set(payload, 8);
    const crc = crc32(pkt.subarray(0, totalLen - 4));
    dv.setUint32(totalLen - 4, crc, true);
    await this.writer.write(pkt);
  }
  // MTProto TCP Full 协议拆包接收
  async recvPacket() {
    const lenBuf = await this.readExactly(4);
    const totalLen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getInt32(0, true);
    if (totalLen < 0) {
      throw new Error(`Telegram \u4F20\u8F93\u5C42\u8FD4\u56DE\u9519\u8BEF\u7801: ${totalLen}`);
    }
    const rest = await this.readExactly(totalLen - 4);
    const payload = rest.subarray(4, totalLen - 8);
    if (payload.length === 4) {
      const code = new DataView(payload.buffer, payload.byteOffset, 4).getInt32(0, true);
      if (code < 0) throw new Error(`MTProto \u4F20\u8F93\u5C42\u62D2\u7EDD\u8BF7\u6C42: ${code}`);
    }
    return payload;
  }
  async close() {
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {
        });
        this.reader.releaseLock();
      }
    } catch (e) {
    }
    try {
      if (this.writer) {
        await this.writer.close().catch(() => {
        });
        this.writer.releaseLock();
      }
    } catch (e) {
    }
    try {
      if (this.socket) this.socket.close();
    } catch (e) {
    }
  }
};
async function decompressGzip(bytes) {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const out = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return concatBytes(...out);
}
var MTProtoClient = class {
  constructor(sessionStr, env) {
    this.env = env || {};
    this.apiId = Number(this.env.TG_API_ID || 2040);
    this.apiHash = String(this.env.TG_API_HASH || "b18441a1ff607e10a989891a5462e627");
    this.proxy = this.env.S5_HOST && this.env.S5_PORT ? {
      host: String(this.env.S5_HOST).trim(),
      port: Number(this.env.S5_PORT),
      username: this.env.S5_USER ? String(this.env.S5_USER).trim() : "",
      password: this.env.S5_PASS ? String(this.env.S5_PASS).trim() : ""
    } : null;
    this.dcId = 2;
    this.authKey = null;
    this.authKeyId = null;
    this.salt = randomBytes(8);
    this.sessionId = randomBytes(8);
    this.seqNo = 0;
    this.lastMsgId = 0n;
    this.inited = false;
    this.transport = null;
    if (sessionStr) this._loadSession(sessionStr);
  }
  _loadSession(str) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && parsed.authKey) {
        this.dcId = Number(parsed.dcId || 2);
        this.authKey = hexToBytes(parsed.authKey);
        this.authKeyId = hexToBytes(parsed.authKeyId);
        if (parsed.salt) this.salt = hexToBytes(parsed.salt);
        return;
      }
    } catch (e) {
    }
    if (str.startsWith("1") && str.length > 300) {
      const raw = base64UrlToBytes(str.slice(1));
      if (raw.length >= 263) {
        this.dcId = raw[0];
        this.authKey = raw.slice(raw.length - 256);
      }
    }
  }
  saveSession() {
    if (!this.authKey || !this.authKeyId) return "";
    return JSON.stringify({
      dcId: this.dcId,
      authKey: bytesToHex(this.authKey),
      authKeyId: bytesToHex(this.authKeyId),
      salt: bytesToHex(this.salt)
    });
  }
  _nextMsgId() {
    const nowSec = BigInt(Math.floor(Date.now() / 1e3));
    let id = nowSec << 32n | BigInt(Math.floor(Math.random() * 268435455) & ~3);
    if (id <= this.lastMsgId) id = this.lastMsgId + 4n;
    this.lastMsgId = id;
    return id;
  }
  _nextSeqNo(contentRelated = true) {
    const s = this.seqNo * 2 + (contentRelated ? 1 : 0);
    if (contentRelated) this.seqNo++;
    return s;
  }
  async connect() {
    const dc = TG_DCS[this.dcId] || TG_DCS[2];
    this.transport = new CloudflareTcpTransport(this.proxy);
    await this.transport.connect(dc.ip, dc.port);
    if (this.authKey && !this.authKeyId) {
      this.authKeyId = (await sha1(this.authKey)).subarray(12, 20);
    }
    if (!this.authKey) {
      await this._performDHHandshake();
    }
  }
  async switchDC(newDcId) {
    await this.disconnect();
    this.dcId = Number(newDcId);
    this.authKey = null;
    this.authKeyId = null;
    this.salt = randomBytes(8);
    this.sessionId = randomBytes(8);
    this.seqNo = 0;
    this.inited = false;
    await this.connect();
  }
  async disconnect() {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
  }
  async _sendUnencrypted(tlBytes) {
    const w = new TLWriter().writeInt64(0n).writeInt64(this._nextMsgId()).writeInt32(tlBytes.length).writeRaw(tlBytes);
    await this.transport.sendPacket(w.toBytes());
    const resp = await this.transport.recvPacket();
    const r = new TLReader(resp);
    r.readInt64();
    r.readInt64();
    const len = r.readInt32();
    return new TLReader(r.readRaw(len));
  }
  // MTProto 2.0 RSA_PAD 混合加密实现 + 完整 DH-2048 握手
  async _performDHHandshake() {
    const nonce = randomBytes(16);
    const reqPq = new TLWriter().writeUInt32(3195965169).writeRaw(nonce).toBytes();
    const resPqReader = await this._sendUnencrypted(reqPq);
    const ctor1 = resPqReader.readUInt32();
    if (ctor1 !== 85337187) throw new Error(`\u63E1\u624B\u9636\u6BB51\u5931\u8D25: \u672A\u77E5\u6784\u9020\u5668 0x${ctor1.toString(16)}`);
    resPqReader.readRaw(16);
    const serverNonce = resPqReader.readRaw(16);
    const pqBytes = resPqReader.readBytes();
    resPqReader.readUInt32();
    const fpCount = resPqReader.readInt32();
    let matchedKey = TG_RSA_KEYS[0];
    for (let i = 0; i < fpCount; i++) {
      const fpRaw = resPqReader.readRaw(8);
      const fpHex = bytesToHex(fpRaw);
      const found = TG_RSA_KEYS.find((k) => k.fpHex === fpHex);
      if (found) matchedKey = found;
    }
    const [pBytes, qBytes] = factorizePQ(pqBytes);
    const newNonce = randomBytes(32);
    const innerData = new TLWriter().writeUInt32(2851430293).writeBytes(pqBytes).writeBytes(pBytes).writeBytes(qBytes).writeRaw(nonce).writeRaw(serverNonce).writeRaw(newNonce).writeInt32(this.dcId).toBytes();
    const padLen = 192 - innerData.length;
    const dataWithPad = concatBytes(innerData, randomBytes(padLen));
    const dataRev = new Uint8Array(192);
    for (let i = 0; i < 192; i++) dataRev[i] = dataWithPad[191 - i];
    let rsaEncrypted = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const tempKey = randomBytes(32);
      const dataWithHash = concatBytes(dataRev, await sha256(concatBytes(tempKey, dataWithPad)));
      const aesEncrypted = aes256IgeEncrypt(dataWithHash, tempKey, new Uint8Array(32));
      const tempKeyXor = xorBytes(tempKey, await sha256(aesEncrypted));
      const keyAesEnc = concatBytes(tempKeyXor, aesEncrypted);
      const keyAesInt = bytesToBigIntBE(keyAesEnc);
      if (keyAesInt < matchedKey.n) {
        const resInt = modPow(keyAesInt, matchedKey.e, matchedKey.n);
        rsaEncrypted = bigIntToBytesBE(resInt, 256);
        break;
      }
    }
    const reqDh = new TLWriter().writeUInt32(3608339646).writeRaw(nonce).writeRaw(serverNonce).writeBytes(pBytes).writeBytes(qBytes).writeRaw(matchedKey.fpBytes).writeBytes(rsaEncrypted).toBytes();
    const dhResReader = await this._sendUnencrypted(reqDh);
    const ctor2 = dhResReader.readUInt32();
    if (ctor2 !== 3504867164) throw new Error(`\u63E1\u624B\u9636\u6BB52\u5931\u8D25 (Server_DH_Params): 0x${ctor2.toString(16)}`);
    dhResReader.readRaw(16);
    dhResReader.readRaw(16);
    const encAnswer = dhResReader.readBytes();
    const h1 = await sha1(concatBytes(newNonce, serverNonce));
    const h2 = await sha1(concatBytes(serverNonce, newNonce));
    const h3 = await sha1(concatBytes(newNonce, newNonce));
    const tmpAesKey = concatBytes(h1, h2.subarray(0, 12));
    const tmpAesIv = concatBytes(h2.subarray(12, 20), h3, newNonce.subarray(0, 4));
    const decAnswer = aes256IgeDecrypt(encAnswer, tmpAesKey, tmpAesIv);
    const innerReader = new TLReader(decAnswer, 20);
    const ctor3 = innerReader.readUInt32();
    if (ctor3 !== 3045658042) throw new Error(`server_DH_inner_data \u6821\u9A8C\u5931\u8D25: 0x${ctor3.toString(16)}`);
    innerReader.readRaw(16);
    innerReader.readRaw(16);
    const g = BigInt(innerReader.readInt32());
    const dhPrimeBytes = innerReader.readBytes();
    const gABytes = innerReader.readBytes();
    innerReader.readInt32();
    const dhPrime = bytesToBigIntBE(dhPrimeBytes);
    const gA = bytesToBigIntBE(gABytes);
    const b = bytesToBigIntBE(randomBytes(256));
    const gBBytes = bigIntToBytesBE(modPow(g, b, dhPrime), 256);
    const authKeyBytes = bigIntToBytesBE(modPow(gA, b, dhPrime), 256);
    const clientInner = new TLWriter().writeUInt32(1715713620).writeRaw(nonce).writeRaw(serverNonce).writeInt64(0n).writeBytes(gBBytes).toBytes();
    const clientHash = await sha1(clientInner);
    const clientPadLen = (16 - (20 + clientInner.length) % 16) % 16;
    const encClientInner = aes256IgeEncrypt(
      concatBytes(clientHash, clientInner, randomBytes(clientPadLen)),
      tmpAesKey,
      tmpAesIv
    );
    const setDhReq = new TLWriter().writeUInt32(4110704415).writeRaw(nonce).writeRaw(serverNonce).writeBytes(encClientInner).toBytes();
    const dhGenReader = await this._sendUnencrypted(setDhReq);
    const ctor4 = dhGenReader.readUInt32();
    if (ctor4 !== 1003222836) throw new Error(`DH \u5BC6\u94A5\u534F\u5546\u6700\u7EC8\u786E\u8BA4\u5931\u8D25: 0x${ctor4.toString(16)}`);
    this.authKey = authKeyBytes;
    this.authKeyId = (await sha1(authKeyBytes)).subarray(12, 20);
    this.salt = xorBytes(newNonce.subarray(0, 8), serverNonce.subarray(0, 8));
  }
  async _deriveMtproto2Keys(msgKey, x) {
    const sha256a = await sha256(concatBytes(msgKey, this.authKey.subarray(x, x + 36)));
    const sha256b = await sha256(concatBytes(this.authKey.subarray(40 + x, 40 + x + 36), msgKey));
    const aesKey = concatBytes(sha256a.subarray(0, 8), sha256b.subarray(8, 24), sha256a.subarray(24, 32));
    const aesIv = concatBytes(sha256b.subarray(0, 8), sha256a.subarray(8, 24), sha256b.subarray(24, 32));
    return { aesKey, aesIv };
  }
  async _encryptMessage(tlBody, contentRelated = true) {
    const msgId = this._nextMsgId();
    const seqNo = this._nextSeqNo(contentRelated);
    const header = new TLWriter().writeRaw(this.salt).writeRaw(this.sessionId).writeInt64(msgId).writeInt32(seqNo).writeInt32(tlBody.length).writeRaw(tlBody).toBytes();
    let padLen = (16 - header.length % 16) % 16;
    if (padLen < 12) padLen += 16;
    const plain = concatBytes(header, randomBytes(padLen));
    const msgKeyLarge = await sha256(concatBytes(this.authKey.subarray(88, 120), plain));
    const msgKey = msgKeyLarge.subarray(8, 24);
    const { aesKey, aesIv } = await this._deriveMtproto2Keys(msgKey, 0);
    const encrypted = aes256IgeEncrypt(plain, aesKey, aesIv);
    return {
      msgId,
      packet: concatBytes(this.authKeyId, msgKey, encrypted)
    };
  }
  async _decryptPacket(packet) {
    const msgKey = packet.subarray(8, 24);
    const encrypted = packet.subarray(24);
    const { aesKey, aesIv } = await this._deriveMtproto2Keys(msgKey, 8);
    const plain = aes256IgeDecrypt(encrypted, aesKey, aesIv);
    const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const msgLen = dv.getInt32(28, true);
    return plain.subarray(32, 32 + msgLen);
  }
  async _parseIncomingBody(body, targetMsgId, state) {
    const r = new TLReader(body);
    const ctor = r.readUInt32();
    if (ctor === 1945237724) {
      const count = r.readInt32();
      for (let i = 0; i < count; i++) {
        r.readInt64();
        r.readInt32();
        const len = r.readInt32();
        const inner = r.readRaw(len);
        await this._parseIncomingBody(inner, targetMsgId, state);
      }
      return;
    }
    if (ctor === 812830625) {
      const unzipped = await decompressGzip(r.readBytes());
      await this._parseIncomingBody(unzipped, targetMsgId, state);
      return;
    }
    if (ctor === 2663516424) {
      r.readInt64();
      r.readInt64();
      this.salt = r.readRaw(8);
      return;
    }
    if (ctor === 3987424379) {
      r.readInt64();
      r.readInt32();
      r.readInt32();
      this.salt = r.readRaw(8);
      state.retrySalt = true;
      return;
    }
    if (ctor === 4082920705) {
      const reqMsgId = r.readInt64();
      let resBytes = r.readRaw(body.length - r.offset);
      const innerCtor = new DataView(resBytes.buffer, resBytes.byteOffset, 4).getUint32(0, true);
      if (innerCtor === 812830625) {
        const gr = new TLReader(resBytes, 4);
        resBytes = await decompressGzip(gr.readBytes());
      }
      const checkCtor = new DataView(resBytes.buffer, resBytes.byteOffset, 4).getUint32(0, true);
      if (checkCtor === 558156313) {
        const er = new TLReader(resBytes, 4);
        const code = er.readInt32();
        const msg = er.readString();
        const err = new Error(msg);
        err.errorCode = code;
        err.errorMessage = msg;
        state.error = err;
        return;
      }
      if (reqMsgId === targetMsgId) {
        state.result = resBytes;
      }
    }
  }
  async invoke(innerPayload) {
    let payloadToSend = innerPayload;
    if (!this.inited) {
      payloadToSend = new TLWriter().writeUInt32(3667594509).writeInt32(MTPROTO_LAYER).writeUInt32(3251461801).writeInt32(0).writeInt32(this.apiId).writeString("Cloudflare Worker").writeString("Linux 6.1").writeString("4.16.8").writeString("zh").writeString("").writeString("zh").writeRaw(innerPayload).toBytes();
      this.inited = true;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const { msgId, packet } = await this._encryptMessage(payloadToSend, true);
      await this.transport.sendPacket(packet);
      const state = { result: null, error: null, retrySalt: false };
      for (let step = 0; step < 8; step++) {
        const rawPkt = await this.transport.recvPacket();
        const body = await this._decryptPacket(rawPkt);
        await this._parseIncomingBody(body, msgId, state);
        if (state.error) throw state.error;
        if (state.result) return new TLReader(state.result);
        if (state.retrySalt) break;
      }
    }
    throw new Error("MTProto \u8BF7\u6C42\u7B49\u5F85\u54CD\u5E94\u8D85\u65F6");
  }
  // 解析 Layer 158 User#8f97c628 真实昵称、@用户名、手机号
  _parseUserFromReader(r) {
    const ctor = r.readUInt32();
    if (ctor !== 2409088552) {
      return { id: 0n, accessHash: 0n, firstName: "Telegram \u7528\u6237", lastName: "", username: "", phone: "" };
    }
    const flags = r.readInt32();
    r.readInt32();
    const id = r.readInt64();
    const accessHash = flags & 1 ? r.readInt64() : 0n;
    const firstName = flags & 2 ? r.readString() : "";
    const lastName = flags & 4 ? r.readString() : "";
    const username = flags & 8 ? r.readString() : "";
    const phone = flags & 16 ? r.readString() : "";
    return { id, accessHash, firstName, lastName, username, phone };
  }
  // 调用 users.getUsers#0d91a548([inputUserSelf#f7c1b13f]) 获取当前登录真人信息
  async getMe() {
    const req = new TLWriter().writeUInt32(227648840).writeUInt32(481674261).writeInt32(1).writeUInt32(4156666175).toBytes();
    const r = await this.invoke(req);
    r.readUInt32();
    const count = r.readInt32();
    if (count < 1) throw new Error("\u672A\u80FD\u83B7\u53D6\u5230\u5F53\u524D\u767B\u5F55\u8D26\u53F7\u4FE1\u606F");
    return this._parseUserFromReader(r);
  }
  // 解析 @bot_username 并发送真实签到消息
  async sendMessageToUsername(username, messageText) {
    const cleanName = String(username).replace(/^@/, "").trim();
    const resolveReq = new TLWriter().writeUInt32(4181511075).writeString(cleanName).toBytes();
    const r = await this.invoke(resolveReq);
    const ctor = r.readUInt32();
    if (ctor !== 2131196633) throw new Error(`\u627E\u4E0D\u5230\u76EE\u6807\u673A\u5668\u4EBA @${cleanName}`);
    const peerCtor = r.readUInt32();
    r.readInt64();
    r.readUInt32();
    const chatCount = r.readInt32();
    let inputPeerBytes = null;
    if (peerCtor === 1498486562 && chatCount === 0) {
      r.readUInt32();
      r.readInt32();
      const u = this._parseUserFromReader(r);
      inputPeerBytes = new TLWriter().writeUInt32(3723011404).writeInt64(u.id).writeInt64(u.accessHash).toBytes();
    } else {
      r.readUInt32();
      const cFlags = r.readInt32();
      r.readInt32();
      const channelId = r.readInt64();
      const accessHash = cFlags & 8192 ? r.readInt64() : 0n;
      inputPeerBytes = new TLWriter().writeUInt32(666680316).writeInt64(channelId).writeInt64(accessHash).toBytes();
    }
    const randomId = BigInt(Math.floor(Math.random() * 2147483647)) << 32n | BigInt(Math.floor(Math.random() * 4294967295));
    const sendReq = new TLWriter().writeUInt32(228423076).writeInt32(0).writeRaw(inputPeerBytes).writeString(messageText).writeInt64(randomId).toBytes();
    await this.invoke(sendReq);
    return { id: (randomId & 0xffffffffn).toString() };
  }
  // ==================== 执行层：目标解析 / 发送 / 历史 / 按钮 ====================
  async resolvePeer(target) {
    const raw = String(target == null ? "" : target).trim();
    if (!raw) throw new Error("\u4EFB\u52A1\u6CA1\u6709\u586B\u76EE\u6807\uFF08\u673A\u5668\u4EBA @\u7528\u6237\u540D\uFF09");
    if (/^-?\d+$/.test(raw)) throw new Error("\u76EE\u6807\u5199\u6210\u4E86\u7EAF\u6570\u5B57 ID\uFF1A\u672C\u7248\u672C\u8BF7\u6539\u6210\u673A\u5668\u4EBA @\u7528\u6237\u540D");
    const name = raw.replace(/^@/, "");
    const r = await this.invoke(new TLWriter().writeUInt32(4181511075).writeString(name).toBytes());
    if (r.readUInt32() !== 2131196633) throw new Error("\u627E\u4E0D\u5230\u76EE\u6807 @" + name);
    const peerCtor = r.readUInt32();
    if (peerCtor === 1498486562) {
      const userId = r.readInt64();
      r.readUInt32();
      const chatCount = r.readInt32();
      if (chatCount > 0) throw new Error("\u76EE\u6807\u89E3\u6790\u5F02\u5E38\uFF1A\u7528\u6237\u76EE\u6807\u5374\u8FD4\u56DE\u4E86\u7FA4\u7EC4");
      r.readUInt32();
      const userCount = r.readInt32();
      if (userCount < 1) throw new Error("\u627E\u4E0D\u5230\u76EE\u6807 @" + name);
      const u = this._parseUserFromReader(r);
      const id = u.id || userId;
      if (!u.accessHash) throw new Error("\u65E0\u6CD5\u83B7\u53D6 @" + name + " \u7684 access_hash");
      return {
        kind: "user",
        id,
        title: u.username ? "@" + u.username : name,
        inputPeer: new TLWriter().writeUInt32(3723011404).writeInt64(id).writeInt64(u.accessHash).toBytes()
      };
    }
    if (peerCtor === 918946202) {
      const chatId = r.readInt64();
      return {
        kind: "chat",
        id: chatId,
        title: name,
        inputPeer: new TLWriter().writeUInt32(900291769).writeInt64(chatId).toBytes()
      };
    }
    if (peerCtor === 2728736542 || peerCtor === 2728863067) {
      const channelId = r.readInt64();
      r.readUInt32();
      const chatCount = r.readInt32();
      let accessHash = 0n;
      for (let i = 0; i < chatCount; i++) {
        const ctor = r.readUInt32();
        if (ctor !== 4265900221 && ctor !== 2200278116) throw new Error("\u76EE\u6807\u7FA4\u7EC4\u89E3\u6790\u5931\u8D25");
        const flags = r.readUInt32();
        if (ctor === 4265900221) r.readUInt32();
        const id = r.readInt64();
        const ah = flags & 8192 ? r.readInt64() : 0n;
        if (id === channelId) accessHash = ah;
        break;
      }
      if (!accessHash) throw new Error("\u65E0\u6CD5\u83B7\u53D6\u76EE\u6807\u7FA4\u7EC4\u7684 access_hash");
      return {
        kind: "channel",
        id: channelId,
        title: name,
        inputPeer: new TLWriter().writeUInt32(666680316).writeInt64(channelId).writeInt64(accessHash).toBytes()
      };
    }
    throw new Error("\u76EE\u6807\u7C7B\u578B\u6682\u4E0D\u652F\u6301");
  }
  _skipFwdHeader(r) {
    const ctor = r.readUInt32();
    if (ctor !== 1313731771) throw new Error("fwd header " + ctor.toString(16));
    const f = r.readUInt32();
    if (f & 1) this._skipPeer(r);
    if (f & 32) r.readString();
    r.readInt32();
    if (f & 4) r.readInt32();
    if (f & 8) r.readString();
    if (f & 16) {
      this._skipPeer(r);
      r.readInt32();
    }
    if (f & 256) this._skipPeer(r);
    if (f & 512) r.readString();
    if (f & 1024) r.readInt32();
    if (f & 64) r.readString();
  }
  _skipReplyHeader(r) {
    const ctor = r.readUInt32();
    if (ctor === 2799007587) {
      const f0 = r.readUInt32();
      r.readInt32();
      if (f0 & 1) this._skipPeer(r);
      if (f0 & 2) r.readInt32();
      return;
    }
    if (ctor !== 2948336091) throw new Error("reply header " + ctor.toString(16));
    const f = r.readUInt32();
    if (f & 16) r.readInt32();
    if (f & 1) this._skipPeer(r);
    if (f & 32) this._skipFwdHeader(r);
    if (f & 256) throw new Error("reply media");
    if (f & 2) r.readInt32();
    if (f & 64) r.readString();
    if (f & 128) throw new Error("reply quote entities");
    if (f & 1024) r.readInt32();
  }
  _skipPeer(r) {
    const c = r.readUInt32();
    if (c === 1498486562 || c === 2728736542 || c === 2728863067 || c === 918946202) {
      r.readInt64();
      return;
    }
    throw new Error("peer?");
  }
  async sendText(inputPeer, text) {
    const randomId = BigInt(Math.floor(Math.random() * 2147483647)) << 32n | BigInt(Math.floor(Math.random() * 4294967295));
    const req = new TLWriter().writeUInt32(228423076).writeInt32(0).writeRaw(inputPeer).writeString(text).writeInt64(randomId).toBytes();
    const r = await this.invoke(req);
    return { randomId, msgId: this._sentIdFromUpdates(r, randomId) };
  }
  _sentIdFromUpdates(r, randomId) {
    try {
      const ctor = r.readUInt32();
      if (ctor === 1957577280) {
        r.readUInt32();
        if (r.readUInt32() !== 481674261) return 0;
        const n = r.readInt32();
        for (let i = 0; i < n; i++) {
          const c = r.readUInt32();
          if (c === 1318109142) {
            const id = r.readInt32();
            const rid = r.readInt64();
            if (rid === randomId) return id;
          } else {
            return 0;
          }
        }
      } else if (ctor === 2417357404) {
        r.readUInt32();
        return r.readInt32();
      } else if (ctor === 2027216577) {
        if (r.readUInt32() === 1318109142) {
          const id = r.readInt32();
          r.readInt64();
          return id;
        }
      }
    } catch (e) {
    }
    return 0;
  }
  async historyPage(inputPeer, opts) {
    const o = opts || {};
    const req = new TLWriter().writeUInt32(1143203525).writeRaw(inputPeer).writeInt32(o.offsetId || 0).writeInt32(0).writeInt32(0).writeInt32(o.limit || 1).writeInt32(0).writeInt32(o.minId || 0).writeInt64(0n).toBytes();
    const r = await this.invoke(req);
    const ctor = r.readUInt32();
    if (ctor === 978610270) {
      const flags = r.readUInt32();
      r.readInt32();
      if (flags & 1) r.readInt32();
      if (flags & 4) r.readInt32();
    } else if (ctor === 3346446926) {
      const flags = r.readUInt32();
      r.readInt32();
      r.readInt32();
      if (flags & 4) r.readInt32();
    } else if (ctor !== 2356252295) {
      throw new Error("\u5386\u53F2\u6D88\u606F\u54CD\u5E94\u5F02\u5E38: 0x" + ctor.toString(16));
    }
    if (r.readUInt32() !== 481674261) throw new Error("\u5386\u53F2\u6D88\u606F\u683C\u5F0F\u5F02\u5E38");
    const n = r.readInt32();
    const out = [];
    for (let i = 0; i < n; i++) {
      const m = this._readMessage(r);
      if (!m) break;
      out.push(m);
    }
    return out;
  }
  _readMessage(r) {
    const start = r.offset;
    const orders = this._msgOrder ? [this._msgOrder] : ["peer-first", "from-first"];
    for (let i = 0; i < orders.length; i++) {
      r.offset = start;
      const m = this._readMessageAs(r, orders[i]);
      if (m) {
        this._msgOrder = orders[i];
        return m;
      }
    }
    r.offset = start;
    return null;
  }
  _readMessageAs(r, order) {
    try {
      const mctor = r.readUInt32();
      if (mctor !== 940666592) return null;
      const flags = r.readUInt32();
      const id = r.readInt32();
      if (order === "from-first") {
        if (flags & 256) this._skipPeer(r);
        this._skipPeer(r);
      } else {
        this._skipPeer(r);
        if (flags & 256) this._skipPeer(r);
      }
      if (flags & 4) this._skipFwdHeader(r);
      if (flags & 8) this._skipReplyHeader(r);
      const date = r.readInt32();
      const text = r.readString();
      if (text.length > 4096 || text.indexOf("\uFFFD") >= 0) return null;
      const msg = { id, date, text, out: !!(flags & 2), buttons: null };
      if (flags & 512) {
        if (!this._skipMedia(r)) return msg;
      }
      if (flags & 64) {
        const at = r.offset;
        const mc = (r.bytes[r.offset] | r.bytes[r.offset + 1] << 8 | r.bytes[r.offset + 2] << 16 | r.bytes[r.offset + 3] << 24) >>> 0;
        if (mc !== 1218642516 && mc !== 2245892561 && mc !== 2688441221) return msg;
        r.offset = at;
        msg.buttons = this._readMarkup(r);
      }
      return msg;
    } catch (e) {
      return null;
    }
  }
  _skipVector(r, fn) {
    if (r.readUInt32() !== 481674261) throw new Error("vector?");
    const n = r.readInt32();
    for (let i = 0; i < n; i++) fn(r);
  }
  _skipPhotoSize(r) {
    const c = r.readUInt32();
    if (c === 1976012384) {
      r.readString();
      r.readInt32();
      r.readInt32();
      r.readInt32();
    } else if (c === 35527382) {
      r.readString();
      r.readInt32();
      r.readInt32();
      r.readBytes();
    } else if (c === 3769678894) {
      r.readString();
      r.readBytes();
    } else if (c === 4198431637) {
      r.readString();
      r.readInt32();
      r.readInt32();
      this._skipVector(r, function(rr) {
        rr.readInt32();
      });
    } else if (c === 3626061121) {
      r.readString();
      r.readBytes();
    } else {
      throw new Error("photoSize?");
    }
  }
  _skipDocument(r) {
    const f = r.readUInt32();
    r.readInt64();
    r.readInt64();
    r.readBytes();
    r.readInt32();
    r.readString();
    r.readRaw(8);
    const self = this;
    if (f & 1) self._skipVector(r, function(rr) {
      self._skipPhotoSize(rr);
    });
    if (f & 2) self._skipVector(r, function(rr) {
      rr.readString();
      rr.readInt32();
      rr.readInt32();
      rr.readInt32();
    });
    r.readInt32();
    self._skipVector(r, function(rr) {
      self._skipDocAttr(rr);
    });
  }
  _skipDocAttr(r) {
    const c = r.readUInt32();
    if (c === 358154344) {
      r.readString();
      return;
    }
    if (c === 1815593308) {
      r.readInt32();
      r.readInt32();
      return;
    }
    if (c === 297109817 || c === 3246071453) return;
    if (c === 2555574726) {
      const f = r.readUInt32();
      r.readInt32();
      if (f & 1) r.readString();
      if (f & 2) r.readString();
      if (f & 4) r.readBytes();
      return;
    }
    if (c === 1137015880) {
      const f = r.readUInt32();
      r.readInt32();
      r.readInt32();
      r.readInt32();
      if (f & 1) r.readRaw(8);
      return;
    }
    if (c === 4245985433) {
      r.readInt64();
      return;
    }
    if (c === 1662637586) {
      const f = r.readUInt32();
      r.readString();
      r.readInt64();
      r.readInt64();
      if (f & 1) {
        const fl = r.readUInt32();
        if (fl & 1) r.readRaw(8);
        if (fl & 2) r.readRaw(8);
      }
      r.readInt32();
      return;
    }
    if (c === 3727929492) {
      rrSkip();
      return;
    }
    throw new Error("docAttr?");
    function rrSkip() {
    }
  }
  _skipPhoto(r) {
    const f = r.readUInt32();
    r.readInt64();
    r.readInt64();
    r.readBytes();
    r.readInt32();
    const self = this;
    self._skipVector(r, function(rr) {
      self._skipPhotoSize(rr);
    });
    r.readInt32();
    if (f & 1) self._skipVector(r, function(rr) {
      rr.readString();
      rr.readInt32();
      rr.readInt32();
      rr.readInt32();
    });
    if (f & 2) self._skipVector(r, function(rr) {
      rr.readString();
      rr.readInt32();
      rr.readInt32();
      rr.readInt32();
    });
  }
  _skipMedia(r) {
    try {
      const ctor = r.readUInt32();
      if (ctor === 1038967584 || ctor === 2676290718) return true;
      if (ctor === 1766936791) {
        const f = r.readUInt32();
        if (f & 1) {
          r.readUInt32();
          this._skipPhoto(r);
        }
        if (f & 4) r.readInt32();
        return true;
      }
      if (ctor === 80693892 || ctor === 2628808919) {
        const f = r.readUInt32();
        if (f & 1) {
          r.readUInt32();
          this._skipDocument(r);
        }
        if (f & 4) r.readInt32();
        return true;
      }
      if (ctor === 3723562043 || ctor === 802824708) {
        const f = r.readUInt32();
        r.readUInt32();
        this._skipWebPage(r);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  _readMarkup(r) {
    const ctor = r.readUInt32();
    if (ctor === 2688441221) return [];
    if (ctor === 1218642516) {
    } else if (ctor === 2245892561) {
      r.readUInt32();
    } else {
      return null;
    }
    if (r.readUInt32() !== 481674261) return null;
    const rows = r.readInt32();
    const out = [];
    for (let i = 0; i < rows; i++) {
      if (r.readUInt32() !== 2002815875) return out;
      r.readUInt32();
      const n = r.readInt32();
      const row = [];
      for (let j = 0; j < n; j++) {
        const c = r.readUInt32();
        const b = { text: "", data: null, url: "" };
        if (c === 2734311552) {
          b.text = r.readString();
        } else if (c === 629866245) {
          b.text = r.readString();
          b.url = r.readString();
        } else if (c === 901503851) {
          r.readUInt32();
          b.text = r.readString();
          b.data = r.readBytes();
        } else if (c === 280464681) {
          const f = r.readUInt32();
          b.text = r.readString();
          if (f & 1) r.readString();
          b.url = r.readString();
          r.readInt32();
        } else if (c === 2976541737 || c === 4235815743) {
          b.text = r.readString();
        } else if (c === 3150401885) {
          const f = r.readUInt32();
          if (f & 1) r.readUInt32();
          b.text = r.readString();
        } else {
          return out;
        }
        row.push(b);
      }
      out.push(row);
    }
    return out;
  }
  async clickButton(inputPeer, msgId, data) {
    const req = new TLWriter().writeUInt32(2470627847).writeInt32(data && data.length ? 1 : 0).writeRaw(inputPeer).writeInt32(msgId);
    if (data && data.length) req.writeBytes(data);
    const r = await this.invoke(req.toBytes());
    if (r.readUInt32() !== 911761060) throw new Error("\u6309\u94AE\u70B9\u51FB\u54CD\u5E94\u5F02\u5E38");
    const flags = r.readUInt32();
    const message = flags & 1 ? r.readString() : "";
    const url = flags & 4 ? r.readString() : "";
    r.readInt32();
    return { message, url, alert: !!(flags & 2) };
  }
  /** 从最新往回逐条取消息（每次只取 1 条，避免跳过复杂媒体对象） */
  async recentMessages(inputPeer, count, minId) {
    const out = [];
    let offsetId = 0;
    for (let i = 0; i < (count || 5); i++) {
      const page = await this.historyPage(inputPeer, { limit: 1, minId: minId || 0, offsetId });
      if (!page.length) break;
      out.push(page[0]);
      offsetId = page[0].id;
      if (minId && page[0].id <= minId) break;
    }
    return out;
  }
  // 导出二维码登录 Token (auth.exportLoginToken#b7e085fe)
  async exportLoginToken() {
    const req = new TLWriter().writeUInt32(3084944894).writeInt32(this.apiId).writeString(this.apiHash).writeUInt32(481674261).writeInt32(0).toBytes();
    let r = await this.invoke(req);
    let ctor = r.readUInt32();
    if (ctor === 110008598) {
      const targetDc = r.readInt32();
      const migToken = r.readBytes();
      await this.switchDC(targetDc);
      const impReq = new TLWriter().writeUInt32(2511101156).writeBytes(migToken).toBytes();
      r = await this.invoke(impReq);
      ctor = r.readUInt32();
    }
    if (ctor === 957176926) {
      return { status: "success" };
    }
    if (ctor === 1654593920) {
      const expires = r.readInt32();
      const tokenBytes = r.readBytes();
      return { status: "pending", expires, token: bytesToBase64Url(tokenBytes) };
    }
    throw new Error(`\u672A\u77E5\u626B\u7801\u72B6\u6001\u54CD\u5E94: 0x${ctor.toString(16)}`);
  }
  // 手机号发送验证码 (auth.sendCode#a677244f)
  async sendPhoneCode(phone) {
    const buildReq = () => new TLWriter().writeUInt32(2792825935).writeString(phone).writeInt32(this.apiId).writeString(this.apiHash).writeUInt32(2904898936).writeInt32(0).toBytes();
    let r;
    try {
      r = await this.invoke(buildReq());
    } catch (err) {
      const m = (err.errorMessage || "").match(/PHONE_MIGRATE_(\d+)/);
      if (m) {
        await this.switchDC(Number(m[1]));
        r = await this.invoke(buildReq());
      } else {
        throw err;
      }
    }
    const ctor = r.readUInt32();
    if (ctor !== 1577067778) throw new Error("\u53D1\u9001\u9A8C\u8BC1\u7801\u8FD4\u56DE\u672A\u77E5\u54CD\u5E94");
    r.readInt32();
    const typeCtor = r.readUInt32();
    if (typeCtor === 3646315577) r.readString();
    r.readInt32();
    const phoneCodeHash = r.readString();
    return phoneCodeHash;
  }
  // 手机号核验验证码 (auth.signIn#8d52a951)
  async signInWithCode(phone, phoneCodeHash, code) {
    const req = new TLWriter().writeUInt32(2371004753).writeInt32(1).writeString(phone).writeString(phoneCodeHash).writeString(code).toBytes();
    await this.invoke(req);
  }
  // 两步验证 (2FA 云端密码) SRP 协议核验 (account.getPassword#548a30f5 + auth.checkPassword#d18b4d16)
  async check2FAPassword(password) {
    const r = await this.invoke(new TLWriter().writeUInt32(1418342645).toBytes());
    const ctor = r.readUInt32();
    if (ctor !== 2507886843) throw new Error("\u65E0\u6CD5\u8BFB\u53D6 2FA \u53C2\u6570");
    const flags = r.readInt32();
    if (!(flags & 4)) throw new Error("\u5F53\u524D\u8D26\u53F7\u672A\u5F00\u542F\u4E24\u6B65\u9A8C\u8BC1\u5BC6\u7801");
    const algoCtor = r.readUInt32();
    if (algoCtor !== 982592842) throw new Error("\u4E0D\u652F\u6301\u7684 KDF \u7B97\u6CD5");
    const salt1 = r.readBytes();
    const salt2 = r.readBytes();
    const g = BigInt(r.readInt32());
    const pBytes = r.readBytes();
    const srpBBytes = r.readBytes();
    const srpId = r.readInt64();
    const p = bytesToBigIntBE(pBytes);
    const B = bytesToBigIntBE(srpBBytes);
    const sh = async (data, s) => sha256(concatBytes(s, data, s));
    const passBytes = TEXT_ENC.encode(password);
    const ph1 = await sh(await sh(passBytes, salt1), salt2);
    const baseKey = await crypto.subtle.importKey("raw", ph1, "PBKDF2", false, ["deriveBits"]);
    const derived = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-512", salt: salt1, iterations: 1e5 },
      baseKey,
      512
    ));
    const ph2 = await sh(derived, salt2);
    const x = bytesToBigIntBE(ph2);
    const v = modPow(g, x, p);
    const pPad = bigIntToBytesBE(p, 256);
    const gPad = bigIntToBytesBE(g, 256);
    const k = bytesToBigIntBE(await sha256(concatBytes(pPad, gPad)));
    const kv = k * v % p;
    const a = bytesToBigIntBE(randomBytes(256));
    const ABytes = bigIntToBytesBE(modPow(g, a, p), 256);
    const bPad = bigIntToBytesBE(B, 256);
    const u = bytesToBigIntBE(await sha256(concatBytes(ABytes, bPad)));
    let t = (B - kv) % p;
    if (t < 0n) t += p;
    const SBytes = bigIntToBytesBE(modPow(t, a + u * x, p), 256);
    const KBytes = await sha256(SBytes);
    const m1 = await sha256(concatBytes(
      xorBytes(await sha256(pPad), await sha256(gPad)),
      await sha256(salt1),
      await sha256(salt2),
      ABytes,
      bPad,
      KBytes
    ));
    const checkReq = new TLWriter().writeUInt32(3515567382).writeUInt32(3531600002).writeInt64(srpId).writeBytes(ABytes).writeBytes(m1).toBytes();
    await this.invoke(checkReq);
  }
};

// src/engine.js
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var brief = (s, n = 200) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "\u2026";
};
var DEAD_SESSION = /AUTH_KEY_UNREGISTERED|USER_DEACTIVATED|SESSION_REVOKED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED_BAN|SESSION_EXPIRED/i;
function errText(e) {
  const msg = String(e && (e.errorMessage || e.message) || e || "");
  const code = /^([A-Z][A-Z0-9_]{3,})$/.exec(msg);
  if (/FLOOD_WAIT/.test(msg) || /FLOOD/.test(String(e && e.code || ""))) {
    const m = /FLOOD_WAIT_(\d+)/.exec(msg);
    const sec = m && m[1] || "?";
    return "\u89E6\u53D1\u9650\u6D41\uFF08FLOOD_WAIT_" + sec + "\uFF09\uFF0CTelegram \u8981\u6C42\u7B49\u5F85 " + sec + " \u79D2";
  }
  if (DEAD_SESSION.test(msg)) return "\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u5230\u9762\u677F\u91CD\u65B0\u767B\u5F55\u8D26\u53F7\uFF08" + msg + "\uFF09";
  if (msg === "TIMEOUT") return "\u8BF7\u6C42\u8D85\u65F6\uFF08Telegram \u6CA1\u6709\u56DE\u5305\uFF09";
  return brief(code ? msg : e && e.message || msg || "\u672A\u77E5\u9519\u8BEF");
}
function makeClient({ session, apiId, apiHash, proxy }) {
  const env = { TG_API_ID: apiId, TG_API_HASH: apiHash };
  if (proxy && proxy.host && proxy.port) {
    env.S5_HOST = proxy.host;
    env.S5_PORT = proxy.port;
    env.S5_USER = proxy.user || "";
    env.S5_PASS = proxy.pass || "";
  }
  return new MTProtoClient(session || "", env);
}
function taskContext(ms, name, onAbort, waiter) {
  const wait = waiter || sleep;
  const ctx = {
    ms,
    name,
    aborted: false,
    reason: "",
    cancelled: false,
    sendAttempted: false,
    abort(reason, cancelled = false) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason;
      this.cancelled = cancelled;
      try {
        if (onAbort) onAbort(reason);
      } catch (e) {
      }
    },
    throwIfAborted() {
      if (this.aborted) {
        const e = new Error(this.reason || "ABORTED");
        e.code = this.cancelled ? "CANCELLED" : "ABORTED";
        throw e;
      }
    },
    async sleep(ms2) {
      const end = Date.now() + ms2;
      while (Date.now() < end) {
        this.throwIfAborted();
        await wait(Math.min(250, end - Date.now()));
      }
      this.throwIfAborted();
    },
    async checkStop(shouldStop) {
      if (shouldStop && await shouldStop()) this.abort("\u5DF2\u624B\u52A8\u7ED3\u675F\u8BE5\u6279\u6B21", true);
      this.throwIfAborted();
    }
  };
  return ctx;
}
async function withDeadline(p, ctx) {
  let timer;
  const timed = new Promise(function(_, reject) {
    timer = setTimeout(function() {
      ctx.abort(ctx.name + " \u6267\u884C\u8D85\u65F6\uFF08" + Math.round(ctx.ms / 1e3) + " \u79D2\u65E0\u7ED3\u679C\uFF09");
      const e = new Error(ctx.reason);
      e.code = "ABORTED";
      reject(e);
    }, ctx.ms);
  });
  try {
    const value = await Promise.race([Promise.resolve(p), timed]);
    ctx.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
  }
}
async function withFlood(fn, ctx, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e && e.message || e);
      const m = /FLOOD_WAIT_(\d+)/.exec(msg);
      if (m && i < tries) {
        const wait = Number(m[1]) || 3;
        if (wait > 45) {
          const err = new Error(msg);
          err.code = "NO_RETRY";
          throw err;
        }
        await ctx.sleep(wait * 1e3 + 1e3);
        continue;
      }
      throw e;
    }
  }
}
async function checkin(client, t, log, ctx) {
  if (ctx.checkStop) await ctx.checkStop(ctx.shouldStop);
  else ctx.throwIfAborted();
  const peer = await withFlood(() => client.resolvePeer(t.target), ctx);
  ctx.throwIfAborted();
  const cmd = String(t.command || "/start").trim();
  const t0 = Math.floor(Date.now() / 1e3);
  const SKEW = 10;
  const since = (m, t2) => (Number(m && m.date) || 0) >= t2 - SKEW;
  ctx.sendAttempted = true;
  const sent = await withFlood(() => client.sendText(peer.inputPeer, cmd), ctx);
  log("\u5DF2\u53D1\u9001\uFF1A" + cmd);
  let sentId = sent.msgId || 0;
  if (!sentId) {
    await ctx.sleep(900);
    const last2 = await withFlood(() => client.historyPage(peer.inputPeer, { limit: 1 }), ctx);
    if (last2.length && last2[0].out) sentId = last2[0].id;
  }
  const keyword = String(t.button || "").trim();
  const success = String(t.successText || "").split("|").map((x) => x.trim()).filter(Boolean);
  let popup = "";
  let clicked = false;
  let clickedAt = 0;
  if (keyword) {
    const end = Date.now() + 25e3;
    let hit = null;
    while (Date.now() < end) {
      await ctx.sleep(0);
      const msgs = await withFlood(() => client.recentMessages(peer.inputPeer, 6, sentId), ctx);
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.out || !m.buttons) continue;
        if (!since(m, t0)) continue;
        for (let r = 0; r < m.buttons.length; r++) {
          const row = m.buttons[r];
          for (let b = 0; b < row.length; b++) {
            const btn = row[b];
            if (btn.url) continue;
            if (String(btn.text || "").indexOf(keyword) >= 0) {
              hit = { msg: m, btn };
              break;
            }
          }
          if (hit) break;
        }
        if (hit) break;
      }
      if (hit) break;
      await ctx.sleep(1500);
    }
    if (!hit) return { ok: false, message: "25 \u79D2\u5185\u6CA1\u7B49\u5230\u5305\u542B\u300C" + keyword + "\u300D\u7684\u6309\u94AE" };
    log("\u627E\u5230\u6309\u94AE\uFF1A" + hit.btn.text);
    if (hit.btn.data && hit.btn.data.length) {
      if (ctx.checkStop) await ctx.checkStop(ctx.shouldStop);
      else ctx.throwIfAborted();
      clickedAt = Math.floor(Date.now() / 1e3);
      const res = await withFlood(() => client.clickButton(peer.inputPeer, hit.msg.id, hit.btn.data), ctx);
      clicked = true;
      popup = res.message || "";
      log("\u5DF2\u70B9\u51FB" + (popup ? "\uFF0C\u5F39\u7A97\uFF1A" + popup : ""));
    } else {
      clicked = true;
      log("\u6309\u94AE\u662F URL \u7C7B\u578B\uFF0C\u65E0\u9700\u70B9\u51FB");
    }
  }
  const t1 = clickedAt || t0;
  const ALREADY = /已经签|已签到|今日已签|已签|签过|重复签|已领取|领取过|已打卡|打卡过/;
  const deadline = Date.now() + (success.length ? 15e3 : 1e4);
  await ctx.sleep(2500);
  let texts = [];
  for (; ; ) {
    const msgs = await withFlood(() => client.recentMessages(peer.inputPeer, 6, sentId), ctx);
    texts = msgs.filter((m) => !m.out && m.text && since(m, t1)).map((m) => m.text);
    const pool = [popup].concat(texts);
    if (popup && ALREADY.test(popup)) {
      log("\u5F39\u7A97\uFF1A" + brief(popup));
      return { ok: true, message: brief(popup) };
    }
    const already = texts.find((x) => ALREADY.test(x));
    if (already) {
      log("\u673A\u5668\u4EBA\u56DE\u590D\uFF1A" + brief(already));
      return { ok: true, message: brief(already) };
    }
    if (success.length) {
      const hitText = pool.filter(Boolean).find((x) => success.some((s) => String(x).indexOf(s) >= 0));
      if (hitText) {
        log("\u673A\u5668\u4EBA\u56DE\u590D\uFF1A" + brief(hitText));
        return { ok: true, message: brief(hitText) };
      }
    }
    if (!success.length && texts.length) break;
    if (Date.now() >= deadline) break;
    await ctx.sleep(1500);
  }
  const last = texts[0] || popup;
  if (last) log("\u673A\u5668\u4EBA\u56DE\u590D\uFF1A" + brief(last));
  if (last && ALREADY.test(last)) return { ok: true, message: brief(last) };
  if (clicked && !texts.length) {
    return { ok: false, noRetry: true, message: "\u5DF2\u70B9\u51FB\u300C" + keyword + "\u300D\uFF0C\u4F46\u673A\u5668\u4EBA\u6CA1\u6709\u4EFB\u4F55\u65B0\u56DE\u590D" + (popup ? "\uFF08\u5F39\u7A97\uFF1A" + brief(popup) + "\uFF09" : "") + "\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u6210\u529F" };
  }
  if (success.length) return { ok: false, message: "\u6CA1\u770B\u5230\u6210\u529F\u5173\u952E\u8BCD\u3002\u673A\u5668\u4EBA\u6700\u65B0\u56DE\u590D\uFF1A" + brief(last || "\uFF08\u65E0\uFF09") };
  if (keyword && !clicked) return { ok: false, message: "\u6CA1\u80FD\u70B9\u51FB\u6309\u94AE" };
  if (!popup && !last) return { ok: false, noRetry: true, message: "\u547D\u4EE4\u5DF2\u53D1\u9001\uFF0C\u4F46\u673A\u5668\u4EBA\u4E00\u76F4\u6CA1\u6709\u56DE\u590D\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u6210\u529F" };
  return { ok: true, message: brief(popup || last) };
}
async function runTasks(opts) {
  const tasks = (opts.tasks || []).slice();
  const log = opts.log || (() => {
  });
  const out = [];
  const stamp = () => (/* @__PURE__ */ new Date()).toISOString().slice(11, 19);
  if (!tasks.length) return { results: [], error: "" };
  if (!opts.session) {
    return {
      results: tasks.map((t) => ({ id: t.id, name: t.name || t.id, ok: false, message: "\u8D26\u53F7\u6CA1\u6709 session\uFF0C\u8BF7\u5148\u5728\u9762\u677F\u767B\u5F55", lines: [] })),
      error: "\u6CA1\u6709 session"
    };
  }
  const mk = opts.makeClient || makeClient;
  async function connect2() {
    const c = mk(opts);
    await c.connect();
    return c;
  }
  let head = null;
  try {
    head = await connect2();
    await head.getMe();
  } catch (e) {
    const m = errText(e);
    try {
      if (head) await head.disconnect();
    } catch (err) {
    }
    return {
      results: tasks.map((t) => ({ id: t.id, name: t.name || t.id, ok: false, message: "\u8FDE\u63A5 Telegram \u5931\u8D25\uFF1A" + m, lines: [] })),
      error: "\u8FDE\u63A5 Telegram \u5931\u8D25\uFF1A" + m
    };
  }
  const queue = tasks.slice();
  const conc = Math.max(1, Math.min(Number(opts.concurrency) || 3, 4, queue.length));
  async function worker(seed) {
    let client = seed;
    try {
      while (queue.length) {
        const t = queue.shift();
        const lines = [];
        if (opts.shouldStop && await opts.shouldStop()) {
          const stopRec = { id: t.id, name: t.name || t.id, target: t.target || "", ok: false, message: "\u5DF2\u624B\u52A8\u7ED3\u675F\u8BE5\u6279\u6B21", cancelled: true, noRetry: true, lines: [] };
          out.push(stopRec);
          if (opts.onResult) {
            try {
              await opts.onResult(stopRec);
            } catch (e) {
            }
          }
          continue;
        }
        if (!client) {
          try {
            client = await connect2();
          } catch (e) {
            const rec2 = { id: t.id, name: t.name || t.id, target: t.target || "", ok: false, message: "\u8FDE\u63A5\u4E2D\u65AD\uFF1A" + errText(e), lines };
            out.push(rec2);
            if (opts.onResult) {
              try {
                await opts.onResult(rec2);
              } catch (err) {
              }
            }
            break;
          }
        }
        let rec = null;
        for (let attempt = 0; attempt < 2 && !rec; attempt++) {
          if (!client) {
            try {
              client = await connect2();
            } catch (e) {
              rec = {
                id: t.id,
                name: t.name || t.id,
                target: t.target || "",
                ok: false,
                noRetry: true,
                message: "\u91CD\u8FDE Telegram \u5931\u8D25\uFF1A" + errText(e),
                lines
              };
              break;
            }
          }
          const ctx = taskContext(Number(opts.taskTimeoutMs) || 9e4, t.name || t.id, function() {
            try {
              if (client) client.disconnect();
            } catch (e) {
            }
          }, opts.sleep);
          ctx.shouldStop = opts.shouldStop;
          try {
            const r = await withDeadline(checkin(client, t, (s) => lines.push(stamp() + " " + s), ctx), ctx);
            rec = { id: t.id, name: t.name || t.id, target: t.target || "", ok: !!r.ok, message: r.message, lines };
          } catch (e) {
            const em = errText(e);
            try {
              await client.disconnect();
            } catch (err) {
            }
            client = null;
            if (ctx.cancelled) {
              rec = { id: t.id, name: t.name || t.id, target: t.target || "", ok: false, cancelled: true, noRetry: true, message: "\u5DF2\u624B\u52A8\u7ED3\u675F\u8BE5\u6279\u6B21", lines };
            } else if (ctx.aborted) {
              rec = {
                id: t.id,
                name: t.name || t.id,
                target: t.target || "",
                ok: false,
                noRetry: ctx.sendAttempted,
                lines,
                message: ctx.reason + (ctx.sendAttempted ? "\uFF1B\u6D88\u606F\u5DF2\u53D1\u51FA\uFF0C\u7ED3\u679C\u672A\u77E5\uFF0C\u672A\u81EA\u52A8\u91CD\u8BD5" : "")
              };
            } else if (attempt === 0 && !ctx.sendAttempted && e.code !== "NO_RETRY" && /Socket|EOF|closed|ECONN|timeout|Not connected|FLOOD|限流/i.test(em)) {
              lines.push(stamp() + " \u8FDE\u63A5\u5F02\u5E38\uFF08" + em + "\uFF09\uFF0C\u91CD\u8FDE\u91CD\u8BD5\u4E00\u6B21");
              continue;
            } else {
              rec = {
                id: t.id,
                name: t.name || t.id,
                target: t.target || "",
                ok: false,
                noRetry: ctx.sendAttempted || e.code === "NO_RETRY",
                message: "\u6267\u884C\u5F02\u5E38\uFF1A" + em,
                lines
              };
            }
          }
        }
        lines.push((rec.ok ? "\u6210\u529F\uFF1A" : "\u5931\u8D25\uFF1A") + rec.message);
        out.push(rec);
        if (opts.onResult) {
          try {
            await opts.onResult(rec);
          } catch (e) {
          }
        }
        log((t.name || t.id) + " \u2192 " + (rec.ok ? "ok" : "fail"));
        if (queue.length) await sleep(600 + Math.floor(Math.random() * 1200));
      }
    } finally {
      try {
        if (client) await client.disconnect();
      } catch (e) {
      }
    }
    while (queue.length) {
      const t = queue.shift();
      const rec = {
        id: t.id,
        name: t.name || t.id,
        target: t.target || "",
        ok: false,
        noRetry: true,
        message: "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u672A\u6536\u5230\u6267\u884C\u7ED3\u679C\uFF1B\u4E3A\u907F\u514D\u91CD\u590D\u7B7E\u5230\u672A\u81EA\u52A8\u91CD\u53D1",
        lines: []
      };
      out.push(rec);
      if (opts.onResult) {
        try {
          await opts.onResult(rec);
        } catch (e) {
        }
      }
    }
  }
  const pool = [];
  for (let i = 0; i < conc; i++) pool.push(worker(i === 0 ? head : null));
  await Promise.all(pool);
  return { results: out, error: "" };
}
function parseProxyUrl(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  const m = /^(?:socks5h?):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+):(\d+)\/?$/i.exec(s);
  if (!m) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
    const m2 = /^(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+):(\d+)$/.exec(s);
    if (!m2) return null;
    return { user: decodeURIComponent(m2[1] || ""), pass: decodeURIComponent(m2[2] || ""), host: m2[3], port: Number(m2[4]) };
  }
  return { user: decodeURIComponent(m[1] || ""), pass: decodeURIComponent(m[2] || ""), host: m[3], port: Number(m[4]) };
}
async function checkAccount(opts) {
  const t0 = Date.now();
  let client = null;
  try {
    client = makeClient(opts);
    await client.connect();
    const me = await client.getMe();
    return {
      ok: true,
      ms: Date.now() - t0,
      display: [me.firstName, me.lastName].filter(Boolean).join(" ") || String(me.username || ""),
      user: { id: String(me.id), username: me.username || "", firstName: me.firstName || "", lastName: me.lastName || "", phone: me.phone || "" }
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: errText(e) };
  } finally {
    try {
      if (client) await client.disconnect();
    } catch (e) {
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MTProtoClient,
  TLReader,
  TLWriter,
  checkAccount,
  parseProxyUrl,
  runTasks
});

  return module.exports;
})({ exports: {} });

/* ================= TG bot 签到（MTProto，零依赖） ================= */
const crypto = require('crypto');
const TG_FILE = path.join(DATA_DIR, 'tg.json');
const TG_DEF = {
  settings: { enabled: true, start: '00:05', end: '00:40', apiId: '2040',
    apiHash: 'b18441a1ff607e10a989891a5462e627', timeout: 90, retry: 2 },
  accounts: [], tasks: [], plan: {}, logs: [], updatedAt: 0
};
let tg = loadJSON(TG_FILE, null);
if (!tg || typeof tg !== 'object') tg = JSON.parse(JSON.stringify(TG_DEF));
tg.settings = Object.assign({}, TG_DEF.settings, tg.settings || {});
tg.accounts = Array.isArray(tg.accounts) ? tg.accounts : [];
tg.tasks = Array.isArray(tg.tasks) ? tg.tasks : [];
tg.logs = Array.isArray(tg.logs) ? tg.logs : [];
tg.plan = tg.plan && typeof tg.plan === 'object' ? tg.plan : {};

function tgPersist() {
  tg.updatedAt = Date.now();
  try { saveJSON(TG_FILE, tg); fs.chmodSync(TG_FILE, 0o600); } catch (e) {}
}
function tgId(p) { return (p || 'x') + '_' + crypto.randomBytes(5).toString('hex'); }
function tgNowText(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function tgDateKey(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function tgMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return -1;
  return Math.min(1439, Math.max(0, (+m[1]) * 60 + (+m[2])));
}
function tgMinText(m) {
  const p = (n) => String(n).padStart(2, '0');
  return p(Math.floor(m / 60) % 24) + ':' + p(m % 60);
}
function tgNormPhone(s) {
  let v = String(s || '').trim().replace(/[\s\-()]/g, '');
  if (!v) return '';
  if (v[0] !== '+') v = '+' + v.replace(/^\+/, '');
  return /^\+\d{6,16}$/.test(v) ? v : '';
}
/* session 加密：密钥由管理员密钥派生，可用 TG_ENC_KEY 固定 */
function tgKeyList() {
  const salt = 'vps-tg-session:v1:';
  const out = [];
  if (process.env.TG_ENC_KEY) out.push(crypto.createHash('sha256').update(salt + process.env.TG_ENC_KEY).digest());
  out.push(crypto.createHash('sha256').update(salt + (config.adminToken || '')).digest());
  out.push(crypto.createHash('sha256').update(salt + 'default').digest());
  return out;
}
function tgSeal(str) {
  if (!str) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', tgKeyList()[0], iv);
  const ct = Buffer.concat([c.update(String(str), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function tgOpen(blob) {
  if (!blob) return '';
  const s = String(blob);
  if (s.indexOf('v1.') !== 0) return s;
  const raw = Buffer.from(s.slice(3), 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  let last = null;
  for (const key of tgKeyList()) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) { last = e; }
  }
  throw new Error('session 解密失败（管理员密钥被改过？可用 TG_ENC_KEY 固定，或重新登录）');
}
function tgProxyEnv(proxy) {
  const env = {};
  const s0 = String(proxy || '').trim().replace(/^socks5?:\/\//i, '');
  if (!s0) return env;
  let s = s0, user = '', pass = '';
  const at = s.lastIndexOf('@');
  if (at > 0) { const cred = s.slice(0, at); s = s.slice(at + 1); const i = cred.indexOf(':'); user = i < 0 ? cred : cred.slice(0, i); pass = i < 0 ? '' : cred.slice(i + 1); }
  const i = s.lastIndexOf(':');
  if (i < 0) return env;
  env.S5_HOST = s.slice(0, i);
  env.S5_PORT = s.slice(i + 1) || '1080';
  env.S5_USER = user;
  env.S5_PASS = pass;
  return env;
}
function tgEnvOf(acc) {
  return Object.assign({
    TG_API_ID: String(acc.apiId || tg.settings.apiId || '2040'),
    TG_API_HASH: String(acc.apiHash || tg.settings.apiHash || '')
  }, tgProxyEnv(acc.proxy));
}

/* ---------- 登录（手机号）与账号 ---------- */
const tgRunning = Object.create(null);
const tgQueued = Object.create(null);
let tgPending = Object.create(null);
function tgPendingClean() {
  const now = Date.now();
  for (const k of Object.keys(tgPending)) {
    if (now - tgPending[k].at > 10 * 60 * 1000) {
      try { tgPending[k].client.disconnect(); } catch (e) {}
      delete tgPending[k];
    }
  }
}
function tgErrText(e) {
  const m = String((e && e.message) || e || '').trim();
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '域名解析失败（检查代理 / DNS）';
  if (/ECONNREFUSED/.test(m)) return '连接被拒绝（检查代理端口）';
  if (/ETIMEDOUT|timed? ?out/i.test(m)) return '连接超时（Telegram 可能被墙，建议填代理）';
  if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/.test(m)) return 'session 已失效，请重新登录';
  if (/FLOOD_WAIT_(\d+)/.test(m)) return '请求太频繁，等 ' + Math.round(+m.match(/FLOOD_WAIT_(\d+)/)[1] / 60) + ' 分钟再试';
  if (/PHONE_NUMBER_INVALID/.test(m)) return '手机号格式不对（要带国家码）';
  if (/PHONE_CODE_INVALID/.test(m)) return '验证码不对';
  if (/PHONE_CODE_EXPIRED/.test(m)) return '验证码已过期，重新发送';
  if (/PASSWORD_HASH_INVALID/.test(m)) return '两步验证密码不对';
  if (/API_ID|API_HASH/.test(m)) return 'api_id / api_hash 不对（内置的是公开客户端参数，一般不用改）';
  return m || '未知错误';
}
function tgPublicAcc(a) {
  const me = String(a.session || '').length > 0;
  return {
    id: a.id, name: a.name || a.phone || '未命名', phone: a.phone || '',
    proxy: a.proxy ? a.proxy.replace(/:[^:@]*@/, ':***@') : '',
    hasSession: me, enabled: a.enabled !== false,
    lastRun: a.lastRun || '', lastOk: a.lastOk === undefined ? null : a.lastOk,
    lastMsg: a.lastMsg || '', running: !!(tgRunning[a.id] || tgQueued[a.id])
  };
}
function tgPublicTask(t) {
  return {
    id: t.id, name: t.name || t.target, accountId: t.accountId, target: t.target,
    command: t.command, enabled: t.enabled !== false,
    lastTs: t.lastTs || 0, lastOk: t.lastOk === undefined ? null : t.lastOk,
    lastMsg: t.lastMsg || '', doneOn: t.doneOn || '', attempts: t.attemptsCount || 0
  };
}
async function tgLoginStart(b) {
  tgPendingClean();
  const phone = tgNormPhone(b.phone);
  if (!phone) throw new Error('手机号要带国家码，例如 +8613800138000');
  const env = Object.assign({
    TG_API_ID: String(b.apiId || tg.settings.apiId || '2040'),
    TG_API_HASH: String(b.apiHash || tg.settings.apiHash || '')
  }, tgProxyEnv(b.proxy));
  if (!env.TG_API_HASH) throw new Error('缺少 api_hash');
  const client = new TGKIT.MTProtoClient('', env);
  await client.connect();
  let hash = '';
  try {
    hash = await client.sendPhoneCode(phone);
  } catch (e) {
    try { await client.disconnect(); } catch (e2) {}
    throw new Error(tgErrText(e));
  }
  const loginId = tgId('lg');
  tgPending[loginId] = {
    client, phone, apiId: env.TG_API_ID, apiHash: env.TG_API_HASH,
    proxy: String(b.proxy || '').trim(), hash, name: String(b.name || '').trim(), at: Date.now()
  };
  return { loginId, phone };
}
async function tgLoginCode(loginId, code) {
  const p = tgPending[loginId];
  if (!p) throw new Error('登录已超时，请重新发送验证码');
  p.at = Date.now();
  try {
    await p.client.signInWithCode(p.phone, p.hash, String(code || '').replace(/\s/g, ''));
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/SESSION_PASSWORD_NEEDED|SESSION_PASSWORD/.test(m)) { p.needPw = true; return { needPassword: true }; }
    throw new Error(tgErrText(e));
  }
  return tgLoginFinish(p);
}
async function tgLoginPassword(loginId, password) {
  const p = tgPending[loginId];
  if (!p) throw new Error('登录已超时，请重新走一遍');
  p.at = Date.now();
  try {
    await p.client.check2FAPassword(String(password || ''));
  } catch (e) {
    throw new Error(tgErrText(e));
  }
  return tgLoginFinish(p);
}
async function tgLoginFinish(p) {
  let me = null;
  try { me = await p.client.getMe(); } catch (e) {}
  const session = p.client.saveSession();
  try { await p.client.disconnect(); } catch (e) {}
  const id = p.client && p.client.id;
  const acc = {
    id: tgId('acc'), name: p.name || (me && (me.firstName || me.username)) || p.phone,
    phone: p.phone, apiId: p.apiId, apiHash: p.apiHash, proxy: p.proxy,
    session: tgSeal(session), enabled: true, addedAt: Date.now(),
    lastRun: '', lastOk: null, lastMsg: me ? ('已登录：' + (me.firstName || me.username || me.id)) : '已登录'
  };
  tg.accounts.push(acc);
  tgPersist();
  for (const k of Object.keys(tgPending)) if (tgPending[k].client === p.client) delete tgPending[k];
  return tgPublicAcc(acc);
}
async function tgImportSession(b) {
  const session = String(b.session || '').trim();
  if (!session) throw new Error('请把 session 字符串贴进来');
  const env = Object.assign({
    TG_API_ID: String(b.apiId || tg.settings.apiId || '2040'),
    TG_API_HASH: String(b.apiHash || tg.settings.apiHash || '')
  }, tgProxyEnv(b.proxy));
  const client = new TGKIT.MTProtoClient(session, env);
  await client.connect();
  let me;
  try { me = await client.getMe(); }
  catch (e) { try { await client.disconnect(); } catch (e2) {} throw new Error(tgErrText(e)); }
  const acc = {
    id: tgId('acc'), name: String(b.name || '').trim() || (me && (me.firstName || me.username)) || '导入账号',
    phone: String(b.phone || '').trim(), apiId: env.TG_API_ID, apiHash: env.TG_API_HASH,
    proxy: String(b.proxy || '').trim(), session: tgSeal(client.saveSession()),
    enabled: true, addedAt: Date.now(), lastRun: '',
    lastOk: null, lastMsg: '已登录：' + ((me && (me.firstName || me.username)) || '')
  };
  try { await client.disconnect(); } catch (e) {}
  tg.accounts.push(acc);
  tgPersist();
  return tgPublicAcc(acc);
}
async function tgCheckAccount(acc) {
  const client = new TGKIT.MTProtoClient(tgOpen(acc.session), tgEnvOf(acc));
  try {
    await client.connect();
    const me = await client.getMe();
    acc.lastMsg = '正常：' + ((me && (me.firstName || me.username)) || '') + (me && me.phone ? ' ' + me.phone : '');
    acc.lastOk = true;
    return acc.lastMsg;
  } finally {
    try { await client.disconnect(); } catch (e) {}
    tgPersist();
  }
}

/* ---------- 执行 ---------- */
function tgDateKey(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function tgMinuteOf(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return -1;
  return Math.min(1439, Math.max(0, (+m[1]) * 60 + (+m[2])));
}
function tgNowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function tgPlanTime(seed) {
  const a = tgMinuteOf(tg.settings.start), b = tgMinuteOf(tg.settings.end);
  const lo = a < 0 ? 0 : a, hi = b <= lo ? lo + 60 : b;
  const h = crypto.createHash('sha256').update('tg|' + tgDateKey() + '|' + seed).digest();
  const span = Math.max(1, hi - lo);
  const mins = lo + (h.readUInt32BE(0) % span);
  return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
}
function tgLog(rec) {
  tg.logs.unshift(Object.assign({ ts: Date.now() }, rec));
  if (tg.logs.length > 300) tg.logs.length = 300;
}
async function tgExecAccount(acc, list, reason) {
  const t0 = Date.now();
  let out;
  try {
    out = await TGKIT.runTasks({
      session: tgOpen(acc.session),
      apiId: acc.apiId || tg.settings.apiId,
      apiHash: acc.apiHash || tg.settings.apiHash,
      proxy: acc.proxy || '',
      tasks: list.map(t => ({ id: t.id, name: t.name, target: t.target, command: t.command })),
      concurrency: 1,
      taskTimeoutMs: Math.max(20, +tg.settings.timeout || 90) * 1000,
      log: function () {}
    });
  } catch (e) {
    out = { results: list.map(t => ({ id: t.id, ok: false, message: tgErrText(e) })), error: tgErrText(e) };
  }
  const res = (out && out.results) || [];
  let okN = 0, failN = 0;
  for (const t of list) {
    const r = res.find(x => x && x.id === t.id) || { ok: false, message: (out && out.error) || '没有拿到结果' };
    t.lastTs = Date.now();
    t.lastOk = !!r.ok;
    t.lastMsg = String(r.message || (r.ok ? '完成' : '失败')).slice(0, 200);
    if (t.lastOk) { okN++; t.doneOn = tgDateKey(); }
    else {
      failN++;
      const _today = tgDateKey();
      if (t.attemptsDate !== _today) { t.attemptsDate = _today; t.attemptsCount = 0; }
      t.attemptsCount = (t.attemptsCount || 0) + 1;
      t.lastAttempt = Date.now();
    }
    tgLog({ kind: 'task', taskId: t.id, name: t.name || t.target, ok: t.lastOk, msg: t.lastMsg, ms: Date.now() - t0, reason: reason || '' });
  }
  acc.lastRun = new Date().toLocaleString('zh-CN', { hour12: false });
  acc.lastOk = failN === 0;
  acc.lastMsg = (okN + ' 成功' + (failN ? ' / ' + failN + ' 失败' : '') + ' · ' + (reason || ''));
  tgLog({ kind: 'run', name: acc.name || acc.phone, ok: failN === 0, msg: '本次 ' + list.length + ' 个签到：成功 ' + okN + '，失败 ' + failN, ms: Date.now() - t0, reason: reason || '' });
  tgPersist();
  return { ok: failN === 0, okN, failN, results: res };
}
function tgEnqueue(acc, list, reason) {
  if (!acc || !list.length) return false;
  if (!acc.session) return false;
  if (tgRunning[acc.id]) return false;
  tgQueued[acc.id] = true;
  tgChain = tgChain.then(async () => {
    delete tgQueued[acc.id];
    if (tgRunning[acc.id]) return;
    tgRunning[acc.id] = true;
    try { await tgExecAccount(acc, list, reason); }
    catch (e) { tgLog({ kind: 'run', name: acc.name || acc.phone, ok: false, msg: tgErrText(e), reason: reason || '' }); tgPersist(); }
    finally { delete tgRunning[acc.id]; }
  }).catch(() => {});
  return true;
}
let tgTimer = null;
let tgChain = Promise.resolve();
let tgChainBusy = false;
async function tgTick() {
  if (!tg.settings.enabled) return;
  const date = tgDateKey();
  for (const k of Object.keys(tg.plan)) if (k !== date) delete tg.plan[k];
  const day = tg.plan[date] || (tg.plan[date] = {});
  const nowMin = tgNowMin();
  const groups = Object.create(null);
  for (const t of tg.tasks) {
    if (t.enabled === false) continue;
    if (t.doneOn === date) continue;
    const acc = tg.accounts.find(a => a.id === t.accountId);
    if (!acc || !acc.session || acc.enabled === false) continue;
    if (tgRunning[acc.id] || tgQueued[acc.id]) continue;
    if (t.attemptsDate === date && (t.attemptsCount || 0) >= (+tg.settings.retry || 2)) continue;
    if (t.lastAttempt && Date.now() - t.lastAttempt < 20 * 60 * 1000) continue;
    if (!day[t.id]) { day[t.id] = tgPlanTime(t.id); tgPersist(); }
    if (nowMin < tgMinuteOf(day[t.id])) continue;
    (groups[acc.id] = groups[acc.id] || []).push(t);
  }
  for (const accId of Object.keys(groups)) {
    const acc = tg.accounts.find(a => a.id === accId);
    if (acc) tgEnqueue(acc, groups[accId], '计划任务');
  }
}
function startTgScheduler() {
  if (tgTimer) return;
  tgTimer = setInterval(function () { tgTick().catch(function () {}); }, 60 * 1000);
  setTimeout(function () { tgTick().catch(function () {}); }, 8000);
  try { tgTimer.unref && tgTimer.unref(); } catch (e) {}
}
function tgState() {
  return {
    success: true,
    settings: tg.settings,
    accounts: tg.accounts.map(tgPublicAcc),
    tasks: tg.tasks.map(tgPublicTask),
    logs: tg.logs.slice(0, 60),
    running: Object.keys(tgRunning).concat(Object.keys(tgQueued)).filter(function (v, i, a) { return a.indexOf(v) === i; }),
    plan: tg.plan[tgDateKey()] || {}
  };
}


async function tgLoginCancel(loginId) {
  const p = tgPending[loginId];
  if (p) { delete tgPending[loginId]; try { p.client.disconnect(); } catch (e) {} }
}
async function tgApi(req, res, url, role) {
  if (role !== 'admin') return sendJSON(res, 403, { success: false, error: '只有管理员可以管理签到' });
  const p = url.pathname;
  const B = async function () { try { return JSON.parse((await readBody(req)) || '{}'); } catch (e) { return {}; } };
  try {
    if (p === '/api/tg' && req.method === 'GET') return sendJSON(res, 200, tgState());
    if (p === '/api/tg/settings' && req.method === 'POST') {
      const b = await B(), s = tg.settings;
      if (b.enabled !== undefined) s.enabled = !!b.enabled;
      if (b.start !== undefined && /^\d{1,2}:\d{2}$/.test(String(b.start))) s.start = String(b.start);
      if (b.end !== undefined && /^\d{1,2}:\d{2}$/.test(String(b.end))) s.end = String(b.end);
      if (b.timeout !== undefined) s.timeout = Math.min(600, Math.max(30, parseInt(b.timeout, 10) || 90));
      if (b.retry !== undefined) s.retry = Math.min(5, Math.max(0, parseInt(b.retry, 10) || 0));
      if (b.apiId !== undefined) s.apiId = String(b.apiId || '2040').trim();
      if (b.apiHash !== undefined && String(b.apiHash).trim()) s.apiHash = String(b.apiHash).trim();
      tg.plan = {};
      tgPersist();
      tgTick().catch(function () {});
      return sendJSON(res, 200, { success: true, settings: s });
    }
    if (p === '/api/tg/login/start' && req.method === 'POST') return sendJSON(res, 200, await tgLoginStart(await B()));
    {
      const b = await B();
      if (p === '/api/tg/login/code' && req.method === 'POST') return sendJSON(res, 200, await tgLoginCode(b.loginId, b.code));
      if (p === '/api/tg/login/password' && req.method === 'POST') return sendJSON(res, 200, { success: true, account: await tgLoginPassword(b.loginId, b.password) });
      if (p === '/api/tg/login/cancel' && req.method === 'POST') { await tgLoginCancel(b.loginId); return sendJSON(res, 200, { success: true }); }
      if (p === '/api/tg/account' && req.method === 'POST') return sendJSON(res, 200, { success: true, account: await tgImportSession(b) });
      if (p === '/api/tg/account/delete' && req.method === 'POST') return sendJSON(res, 200, await tgAccDelete(b));
      if (p === '/api/tg/account/check' && req.method === 'POST') return sendJSON(res, 200, await tgAccCheck(b));
      if (p === '/api/tg/task' && req.method === 'POST') return sendJSON(res, 200, await tgTaskSave(b));
      if (p === '/api/tg/task/delete' && req.method === 'POST') return sendJSON(res, 200, await tgTaskDelete(b));
      if (p === '/api/tg/run' && req.method === 'POST') return sendJSON(res, 200, await tgRun(b));
      if ((p === '/api/tg/logs/clear' || p === '/api/tg/clear-logs') && req.method === 'POST') {
        tg.logs = [];
        tgPersist();
        return sendJSON(res, 200, { success: true });
      }
    }
    return sendJSON(res, 404, { success: false, error: '接口不存在' });
  } catch (e) {
    return sendJSON(res, 400, { success: false, error: tgErrText(e) });
  }
}
function startTgScheduler() {
  if (tgTimer) return;
  tgTimer = setInterval(function () { tgTick().catch(function () {}); }, 60000);
}async function tgAccDelete(b) {
  const i = tg.accounts.findIndex(a => a.id === b.id);
  if (i < 0) throw new Error('账号不存在');
  tg.accounts.splice(i, 1);
  tg.tasks = tg.tasks.filter(t => t.accountId !== b.id);
  tgPersist();
  return { deleted: b.id };
}

async function tgAccCheck(b) {
  const acc = tg.accounts.find(a => a.id === b.id);
  if (!acc) throw new Error('账号不存在');
  const me = await tgCheckAccount(acc);
  acc.lastRun = tgNowText();
  acc.lastOk = true;
  acc.lastMsg = '账号正常：' + (me.name || me.username || me.id);
  tgPersist();
  return { ok: true, me: { name: me.name, username: me.username, id: me.id } };
}
async function tgTaskSave(b) {
  if (!b.name || !b.accountId) throw new Error('任务名或账号不能为空');
  const acc = tg.accounts.find(a => a.id === b.accountId);
  if (!acc) throw new Error('所选账号不存在');
  let t = tg.tasks.find(x => x.id === b.id);
  const upd = {
    name: String(b.name).trim(),
    accountId: b.accountId,
    target: String(b.target || '').trim(),
    command: String(b.command || '/checkin').trim() || '/checkin',
    enabled: b.enabled !== false
  };
  if (t) Object.assign(t, upd);
  else tg.tasks.push(Object.assign({ id: tgId('k'), doneOn: '', lastOk: null, lastMsg: '' }, upd));
  tgPersist();
  return { task: tgPublicTask(t || tg.tasks[tg.tasks.length - 1]) };
}async function tgTaskDelete(b) {
  tg.tasks = tg.tasks.filter(t => t.id !== b.id);
  tgPersist();
  return { deleted: b.id };
}async function tgRun(b) {
  let list;
  if (b && b.id) {
    const t = tg.tasks.find(x => x.id === b.id);
    if (!t) throw new Error('任务不存在');
    list = [t];
  } else if (b && b.accountId) {
    list = tg.tasks.filter(t => t.accountId === b.accountId && t.enabled !== false);
  } else {
    list = tg.tasks.filter(t => t.enabled !== false);
  }
  if (!list.length) throw new Error('没有可执行的任务');
  const accs = {};
  for (const t of list) {
    const acc = tg.accounts.find(a => a.id === t.accountId);
    if (acc && acc.session) (accs[acc.id] = accs[acc.id] || []).push(t);
  }
  let n = 0;
  for (const accId of Object.keys(accs)) {
    const acc = tg.accounts.find(a => a.id === accId);
    tgEnqueue(acc, accs[accId], b && b.id ? '手动执行' : '全部执行');
    n += accs[accId].length;
  }
  return { queued: n };
}
// TG Persona 动态加载（文件缺失不影响原有功能）
let personaCtl = null;
function personaApi() {
  if (!personaCtl) {
    try {
      const mod = require(path.join(__dirname, 'tg-persona.js'));
      personaCtl = mod.mount({
        dataDir: DATA_DIR, tg: tg, tgOpen: tgOpen, tgSeal: tgSeal, tgEnvOf: tgEnvOf,
        tgErrText: tgErrText, tgPersist: tgPersist,
        MTProtoClient: TGKIT.MTProtoClient, TLWriter: TGKIT.TLWriter, TLReader: TGKIT.TLReader,
        saveJSON: saveJSON, loadJSON: loadJSON, sendJSON: sendJSON, readBody: readBody,
        fs: fs, path: path, crypto: crypto
      });
      personaCtl.start();
      const st = personaCtl.state() || {};
      console.log('[TG Persona] 已加载，工作账号：' + (st.account || '未选择'));
    } catch (e) {
      console.log('[TG Persona] 加载失败：' + ((e && e.message) || e));
      personaCtl = null;
    }
  }
  return personaCtl ? personaCtl.apiHandler : null;
}

// 不指定 host：监听系统全部地址（IPv6 双栈，IPv4 自动映射），纯 IPv4 / 纯 IPv6 / 双栈机器均可访问
server.listen(PORT, () => {
  startTgScheduler();
  personaApi(); // 预加载 TG Persona（若存在 tg-persona.js）
  console.log(`Emby 反代管理面板已启动: http://0.0.0.0:${PORT} （IPv4 + IPv6）`);
  console.log(`管理员密钥: ${config.adminToken}`);
  console.log(`节点数: ${routes.length}`);
});
