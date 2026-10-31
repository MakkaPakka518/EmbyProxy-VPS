'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const listen=s=>new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',()=>ok(s.address().port));});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function waitProxy(child){return new Promise((ok,no)=>{let out='';const tm=setTimeout(()=>no(Error('start timeout '+out)),8000);const got=c=>{out+=c;if(out.includes('面板已启动')){clearTimeout(tm);ok();}};child.stdout.on('data',got);child.stderr.on('data',got);child.once('exit',c=>no(Error('proxy exit '+c+' '+out)));});}
function getAll(url){return new Promise((ok,no)=>http.get(url,r=>{const a=[];r.on('data',c=>a.push(c));r.on('end',()=>ok({status:r.statusCode,body:Buffer.concat(a)}));r.on('error',no);}).on('error',no));}
test('downstream close aborts upstream and normal stream stays complete',async t=>{
  let chunks=0,closed=false,fallback=0;const expected=Buffer.alloc(1024*1024);for(let i=0;i<expected.length;i++)expected[i]=i&255;
  const upstream=http.createServer((req,res)=>{if(req.url.startsWith('/emby/'))fallback++;if(req.url==='/stream.mkv'){res.writeHead(200,{'Content-Type':'application/octet-stream'});const tm=setInterval(()=>{chunks++;res.write(Buffer.alloc(65536,chunks&255));if(chunks>=2000){clearInterval(tm);res.end();}},5);res.on('close',()=>{if(!res.writableEnded)closed=true;clearInterval(tm);});return;}if(req.url==='/small.mkv'){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':expected.length});res.end(expected);return;}res.writeHead(404);res.end('no');});
  const upPort=await listen(upstream);t.after(()=>new Promise(r=>upstream.close(r)));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'emby-proxy-test-'));fs.mkdirSync(path.join(dir,'data'));
  for(const n of ['server.js','panel.html','tg-persona.js','updater.js','VERSION'])fs.copyFileSync(path.join(__dirname,n),path.join(dir,n));
  fs.writeFileSync(path.join(dir,'data/config.json'),JSON.stringify({adminToken:'test',subscribers:[],ipguard:{mode:'off'}}));
  fs.writeFileSync(path.join(dir,'data/routes.json'),JSON.stringify([{prefix:'test',target:`http://127.0.0.1:${upPort}`,mode:'off',cache_img:'off',v6:'auto'}]));fs.writeFileSync(path.join(dir,'data/stats.json'),'{}');
  const reserve=http.createServer(),proxyPort=await listen(reserve);await new Promise(r=>reserve.close(r));
  const child=spawn(process.execPath,['server.js'],{cwd:dir,env:{...process.env,PORT:String(proxyPort)},stdio:['ignore','pipe','pipe']});t.after(()=>{child.kill('SIGTERM');fs.rmSync(dir,{recursive:true,force:true});});await waitProxy(child);
  await new Promise((ok,no)=>{const q=http.get(`http://127.0.0.1:${proxyPort}/test/stream.mkv`,r=>{r.once('data',()=>{r.destroy();ok();});r.once('error',ok);});q.once('error',e=>e.code==='ECONNRESET'?ok():no(e));});
  await delay(500);const stopped=chunks;await delay(150);assert.equal(closed,true);assert.equal(chunks,stopped);assert.ok(chunks<80);assert.equal(fallback,0);
  const normal=await getAll(`http://127.0.0.1:${proxyPort}/test/small.mkv`);assert.equal(normal.status,200);assert.equal(normal.body.length,expected.length);const sha=b=>crypto.createHash('sha256').update(b).digest('hex');assert.equal(sha(normal.body),sha(expected));
});
