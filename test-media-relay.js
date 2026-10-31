'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const listen=s=>new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',()=>ok(s.address().port));});
const request=url=>new Promise((ok,no)=>http.get(url,{headers:{'X-Emby-Token':'mock-token','Authorization':'Bearer mock','Cookie':'test_session=mock'}},r=>{const a=[];r.on('data',c=>a.push(c));r.on('end',()=>ok({status:r.statusCode,headers:r.headers,raw:r.rawHeaders,body:Buffer.concat(a)}));r.on('error',no)}).on('error',no));
const wait=c=>new Promise((ok,no)=>{let out='';const tm=setTimeout(()=>no(Error('start timeout '+out)),8000);const got=x=>{out+=x;if(out.includes('面板已启动')){clearTimeout(tm);ok()}};c.stdout.on('data',got);c.stderr.on('data',got);c.once('exit',code=>no(Error('proxy exited '+code+' '+out)));});
async function run(backendKnown,relayMode){
 let mediaPath='',mediaHeaders=null;
 const media=http.createServer((q,s)=>{mediaPath=q.url;mediaHeaders=q.headers;s.writeHead(200,{'content-type':'application/octet-stream'});s.end('MEDIA')});const mp=await listen(media);
 const location=`http://127.0.0.1:${mp}/file%20A(2017)%2Fpart%3Fclip.mkv?token=x`;
 // 不设 Content-Length，刻意产生 chunked 302，验证代理不会同时回传 TE + CL。
 const front=http.createServer((q,s)=>{
  if(q.url==='/relative'){s.writeHead(302,{Location:'/same.mkv'});s.end();return;}
  if(q.url==='/same.mkv'){s.writeHead(200,{'content-type':'application/octet-stream'});s.end('FRONTMEDIA');return;}
  if(q.url==='/json'){s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({MediaSources:[{DirectStreamUrl:location}]}));return;}
  s.writeHead(302,{Location:location});s.end();
 });const fp=await listen(front);
 const app=fs.mkdtempSync(path.join(os.tmpdir(),'media-relay-test-'));fs.mkdirSync(path.join(app,'data'));
 for(const n of ['server.js','panel.html','tg-persona.js','updater.js','VERSION'])fs.copyFileSync(path.join(__dirname,n),path.join(app,n));
 fs.writeFileSync(path.join(app,'data/config.json'),JSON.stringify({adminToken:'x',subscribers:[],ipguard:{mode:'off'},backendDomain:backendKnown?`http://127.0.0.1:${mp}`:''}));
 fs.writeFileSync(path.join(app,'data/routes.json'),JSON.stringify([{prefix:'t',target:`http://127.0.0.1:${fp}`,mode:'off',cache_img:'off',relay_media:relayMode}]));fs.writeFileSync(path.join(app,'data/stats.json'),'{}');
 const reserve=http.createServer(),pp=await listen(reserve);await new Promise(r=>reserve.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:app,env:{...process.env,PORT:String(pp)},stdio:['ignore','pipe','pipe']});await wait(child);
 try{
  const json=await request(`http://127.0.0.1:${pp}/t/json`);
  const jsonUrl=JSON.parse(json.body.toString()).MediaSources[0].DirectStreamUrl;
  const jsonFollow=await request(jsonUrl);
  const relativeFirst=await request(`http://127.0.0.1:${pp}/t/relative`);
  const relativeFollow=await request(relativeFirst.headers.location);
  const malformed=await request(`http://127.0.0.1:${pp}/t/file%ZZ.mkv`);
  const first=await request(`http://127.0.0.1:${pp}/t/start`);let follow=null;if(first.headers.location)follow=await request(first.headers.location);
  const api=async(endpoint,body)=>{const r=await fetch(`http://127.0.0.1:${pp}${endpoint}`,{method:body?'POST':'GET',headers:{Cookie:'admin_token=x','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200);return r.json();};
  await api('/api/routes',{prefix:'t',target:`http://127.0.0.1:${fp}`,relay_media:'off'});
  assert.equal((await api('/api/routes')).routes[0].relay_media,'off');
  const backup=await api('/api/routes/export');assert.equal(backup.routes[0].relay_media,'off');await api('/api/routes/import',backup);
  assert.equal((await api('/api/routes')).routes[0].relay_media,'off');
  return{first,follow,mediaPath,mediaHeaders,malformed,relativeFirst,relativeFollow,jsonUrl,jsonFollow};
 }finally{
  child.kill('SIGTERM');await new Promise(r=>front.close(r));await new Promise(r=>media.close(r));fs.rmSync(app,{recursive:true,force:true});
 }
}
test('media 302 defaults to VPS relay, supports configured backend and per-node direct mode',async()=>{
 const unknown=await run(false,undefined),known=await run(true,undefined),direct=await run(false,'off');
 assert.equal(unknown.first.status,302);assert.notEqual(unknown.malformed.status,500);assert.equal(unknown.relativeFollow.body.toString(),'FRONTMEDIA');assert.match(unknown.relativeFirst.headers.location,/\/t\/same\.mkv$/);assert.equal(unknown.first.raw.filter(x=>String(x).toLowerCase()==='location').length,1);assert.equal(unknown.follow.body.toString(),'MEDIA');assert.equal(unknown.mediaPath,'/file%20A(2017)%2Fpart%3Fclip.mkv?token=x');
 assert.equal(known.follow.status,200);assert.equal(known.follow.body.toString(),'MEDIA');assert.equal(known.mediaPath,'/file%20A(2017)%2Fpart%3Fclip.mkv?token=x');assert.match(known.first.headers.location,/\/t\/http:\/\//);
 assert.equal(direct.follow.body.toString(),'MEDIA');assert.ok(!direct.first.headers.location.includes('/t/http://'));
 assert.equal(unknown.mediaHeaders['x-emby-token'],undefined);assert.equal(unknown.mediaHeaders.authorization,undefined);assert.equal(unknown.mediaHeaders.cookie,undefined);
 assert.equal(known.mediaHeaders['x-emby-token'],'mock-token');assert.equal(known.mediaHeaders.authorization,'Bearer mock');
 for(const r of [unknown,known,direct])assert.equal(r.jsonFollow.body.toString(),'MEDIA');
 assert.match(unknown.jsonUrl,/\/t\/http:\/\//);assert.match(known.jsonUrl,/\/t\/http:\/\//);assert.ok(!direct.jsonUrl.includes('/t/http://'));
});

test('relay learning is node-isolated and bounded; media JSON and exact URL candidates are supported',async()=>{
 const vm=require('node:vm');const code=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
 const helpers=vm.runInNewContext(code.slice(code.indexOf('const MEDIA_PATH_RE ='),code.indexOf('async function proxyOnce('))+'\n({rememberRelayOrigins,isRememberedRelayOrigin,relayOriginsByRoute,extractMediaOrigins,buildUpstreamCandidates})',{URL,process:{env:{}},console});
 for(let i=0;i<50;i++)helpers.rememberRelayOrigins('a',[{origin:'https://cdn'+i+'.example'}]);
 assert.equal(helpers.relayOriginsByRoute.get('a').size,32);assert.equal(helpers.isRememberedRelayOrigin('b','https://cdn49.example'),false);assert.equal(helpers.isRememberedRelayOrigin('a','https://cdn49.example'),true);
 const mediaUrl='https://cdn.example/file%2Fpart%3Fclip/';const urls=await helpers.buildUpstreamCandidates(mediaUrl,'','?sig=a%2Fb');assert.equal(urls.length,1);assert.equal(urls[0],mediaUrl+'?sig=a%2Fb');
 const parsed=helpers.extractMediaOrigins(JSON.stringify({DirectStreamUrl:'https://cdn.example/dl/hash?sig=1'}),[]);assert.equal(parsed[0].origin,'https://cdn.example');
});
