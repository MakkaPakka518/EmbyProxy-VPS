'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, validVersion, newer, safeName } = require('./updater');
const SHA = 'a'.repeat(40);
const response = (body, status = 200) => new Response(body, { status });
function fixture(fetchFn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'emby-updater-test-'));
  const data = path.join(base, 'data'); fs.mkdirSync(data);
  for (const name of ['server.js','panel.html','updater.js']) fs.writeFileSync(path.join(base,name),'// test\n');
  fs.writeFileSync(path.join(base,'VERSION'),'2.2.0\n');
  return { base, updater:createUpdater({baseDir:base,dataDir:data,repo:'owner/repo',branch:'main',currentVersion:'2.2.0',fetchFn}) };
}
test('version and path validation',()=>{
  assert.equal(validVersion('2.2.0\n'),'2.2.0'); assert.equal(newer('2.3.0','2.2.9'),true);
  assert.equal(safeName('repo/file.js'),true); assert.equal(safeName('../etc/passwd'),false); assert.equal(safeName('/etc/passwd'),false);
  assert.throws(()=>validVersion('main'));
});
test('check pins commit without network',async t=>{
  const calls=[]; const f=fixture(async url=>{calls.push(url); if(url.includes('/commits/')) return response(JSON.stringify({sha:SHA})); if(url.includes('/'+SHA+'/VERSION')) return response('2.3.0\n'); throw Error('unexpected '+url);});
  t.after(()=>fs.rmSync(f.base,{recursive:true,force:true})); const s=await f.updater.check();
  assert.equal(s.current,'2.2.0'); assert.equal(s.latest,'2.3.0'); assert.equal(s.latestCommit,SHA); assert.equal(s.available,true); assert.equal(calls.length,2);
});
test('concurrent update rejected and bad archive changes nothing',async t=>{
  let release; const gate=new Promise(r=>release=r); const f=fixture(async url=>{if(url.includes('/commits/')){await gate;return response(JSON.stringify({sha:SHA}));} if(url.includes('/'+SHA+'/VERSION'))return response('2.3.0\n'); if(url.includes('codeload.github.com'))return response('bad'); throw Error('unexpected '+url);});
  t.after(()=>fs.rmSync(f.base,{recursive:true,force:true})); assert.equal(f.updater.start(false).accepted,true); assert.throws(()=>f.updater.start(false),/更新正在运行/); release(); await f.updater._wait();
  assert.equal(f.updater.snapshot().ok,false); assert.equal(fs.readFileSync(path.join(f.base,'VERSION'),'utf8').trim(),'2.2.0');
});

test('valid pinned archive replaces allowlist, preserves data and creates backup',async t=>{
  const source=fs.mkdtempSync(path.join(os.tmpdir(),'emby-updater-source-'));const root=path.join(source,'repo-'+SHA.slice(0,7));fs.mkdirSync(root);
  const files={
    'server.js':'// new server\n','panel.html':'<!doctype html>new\n','updater.js':'// new updater\n','VERSION':'2.3.0\n',
    'tg-persona.js':'// new persona\n','install.sh':'#!/bin/sh\n','README.md':'new readme\n'
  };
  for(const [n,v] of Object.entries(files))fs.writeFileSync(path.join(root,n),v);
  const tarPath=path.join(source,'source.tar.gz');const cp=require('node:child_process').spawnSync('tar',['-czf',tarPath,'-C',source,path.basename(root)]);assert.equal(cp.status,0);
  const blob=fs.readFileSync(tarPath);const f=fixture(async url=>{if(url.includes('/commits/'))return response(JSON.stringify({sha:SHA}));if(url.includes('/'+SHA+'/VERSION'))return response('2.3.0\n');if(url.includes('codeload.github.com'))return response(blob);throw Error('unexpected '+url);});
  fs.writeFileSync(path.join(f.base,'data','keep.json'),'secret-data');
  t.after(()=>{fs.rmSync(source,{recursive:true,force:true});fs.rmSync(f.base,{recursive:true,force:true});});
  f.updater.start(false);await f.updater._wait();const s=f.updater.snapshot();assert.equal(s.ok,true);assert.equal(s.current,'2.3.0');assert.equal(s.restartNeeded,true);assert.equal(fs.readFileSync(path.join(f.base,'server.js'),'utf8'),'// new server\n');assert.equal(fs.readFileSync(path.join(f.base,'data','keep.json'),'utf8'),'secret-data');
  const backups=fs.readdirSync(path.join(f.base,'data')).filter(n=>n.startsWith('update-backup-'));assert.equal(backups.length,1);assert.equal(fs.readFileSync(path.join(f.base,'data',backups[0],'server.js'),'utf8'),'// test\n');
});
