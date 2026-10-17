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

// VERSION: 1.5.0（新增 IP 访问控制：白/黑名单 + 国家封锁 + /entry 逃生）
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
  let decodedPath = decodeURIComponent(pathname);
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
              upstreamRes = await proxyOnce(candidateUrl, req, mode, realIp, null);
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
          let rewritten = rewriteUrlsInText(text, baseOrigins, mediaFound, proxyOrigin, matchedPrefix || '');

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
    try { sendText(res, 500, 'Internal Error: ' + e.message); } catch (_) {}
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

// 不指定 host：监听系统全部地址（IPv6 双栈，IPv4 自动映射），纯 IPv4 / 纯 IPv6 / 双栈机器均可访问
server.listen(PORT, () => {
  console.log(`Emby 反代管理面板已启动: http://0.0.0.0:${PORT} （IPv4 + IPv6）`);
  console.log(`管理员密钥: ${config.adminToken}`);
  console.log(`节点数: ${routes.length}`);
});
