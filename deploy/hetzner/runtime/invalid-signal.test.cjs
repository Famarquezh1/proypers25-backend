'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {Journal}=require('./journal.cjs');
function loadEngine(dir) {
  const logs=[];
  const module={exports:{}};
  const sandbox={module,exports:module.exports,__dirname:__dirname,
    process:{env:{PROYPERS_STATE_DIR:dir},argv:[]},
    console:{log:x=>logs.push(JSON.parse(x))},setTimeout,
    require(name){
      if(name.startsWith('node:'))return require(name);
      if(name==='./journal.cjs')return require(name);
      return {};
    }};
  sandbox.require.main={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'engine.cjs'),'utf8'),sandbox);
  return {...module.exports,logs};
}
test('malformed signals reject without intents; subsequent valid intent and deduplication work',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invalid-signal-'));
  try {
    const {claimSignal,logs}=loadEngine(dir),j=new Journal(path.join(dir,'intents'));
    for(const symbol of [undefined,null,'','BTC/USDT','not-a-symbol']) {
      assert.equal(claimSignal(j,{symbol,createdAt:new Date().toISOString(),lane:'CORE'}),undefined);
    }
    assert.equal(claimSignal(j,{symbol:'BTCUSDT',createdAt:'invalid',lane:'CORE'}),undefined);
    assert.equal(fs.readdirSync(j.dir).length,0);
    assert.equal(logs.length,6);
    assert.ok(logs.every(x=>x.event==='SIGNAL_REJECTED'&&x.reason==='INVALID_SIGNAL'));
    const good={symbol:'BTCUSDT',createdAt:'2026-11-08T03:00:00Z',lane:'CORE'};
    const intent=claimSignal(j,good);
    assert.ok(intent.id);
    assert.equal(claimSignal(j,good),null);
    assert.equal(fs.readdirSync(j.dir).length,1);
    assert.equal(JSON.parse(fs.readFileSync(intent.file)).state,'OBSERVED');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('storage and unknown failures still fail closed',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invalid-signal-'));
  try {
    const {claimSignal}=loadEngine(dir);
    for(const message of ['EACCES','ENOSPC','UNKNOWN']) {
      const error=new Error(message);
      assert.throws(()=>claimSignal({claim(){throw error;}},{lane:'CORE'}),e=>e===error);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
