'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const assert=require('node:assert/strict');
const repo=path.resolve(__dirname,'../../..');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'proypers-executor-check-'));
const cases=['normal-v10','normal-core','stop-limit','stale','duplicate-position','minimum-protection','protection-rejected','accepted-timeout'];
const results=[];
function invoke(mode,dir,iteration=0){
  const output=path.join(dir,`result-${iteration}.txt`);
  const signalTime=path.join(dir,'signal-time.txt');
  if(!fs.existsSync(signalTime))fs.writeFileSync(signalTime,new Date(Date.now()-(mode==='stale'?31*60000:0)).toISOString());
  const env={PATH:process.env.PATH,HOME:dir,SPOT_TEST_DIR:dir,SPOT_TEST_CASE:mode,
    BINANCE_API_KEY:'ISOLATED_FIXTURE_KEY',BINANCE_SECRET_KEY:'ISOLATED_FIXTURE_SECRET',
    SIGNAL_SYMBOL:mode==='normal-core'?'SOLUSDT':'BTCUSDT',SIGNAL_PRICE:'100',SIGNAL_PCT:'5',
    SIGNAL_CREATED_AT:fs.readFileSync(signalTime,'utf8'),
    SIGNAL_LANE:mode==='normal-core'?'CORE':'V10_HUNTER',GITHUB_OUTPUT:output};
  const r=spawnSync(process.execPath,['--require',path.join(__dirname,'executor-fixture.cjs'),path.join(repo,'backend/scripts/github-spot-manual-execution-v10-aware.js')],
    {env,cwd:path.join(repo,'backend'),encoding:'utf8',timeout:10000,maxBuffer:1048576});
  if(r.error)throw r.error;
  const parsed=fs.existsSync(output)?Object.fromEntries(fs.readFileSync(output,'utf8').trim().split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];})):{};
  return {code:r.status,outcome:parsed.outcome,reason:parsed.reason,diagnostic:(r.stdout+r.stderr).slice(-2000)};
}
try{
  for(const mode of cases){
    const dir=path.join(folder,mode);fs.mkdirSync(dir);
    const first=invoke(mode,dir);
    if(mode==='accepted-timeout')invoke(mode,dir,1);
    const book=JSON.parse(fs.readFileSync(path.join(dir,'exchange.json')));
    if(['normal-v10','normal-core','stop-limit'].includes(mode)){
      assert.equal(first.outcome,'executed',`${mode}: ${first.diagnostic}`);
      assert.equal(book.buys.length,1);assert.equal(book.stops.length,1);
      const stop=book.stops[0];assert.equal(Number(stop.stopPrice),mode==='normal-core'?95:98.8);
      if(mode==='stop-limit')assert.equal(stop.type,'STOP_LOSS_LIMIT');
    }
    if(['stale','duplicate-position'].includes(mode)){assert.equal(first.outcome,'declined');assert.equal(book.buys.length,0);}
    const blocking=[];
    if(book.buys.length>book.stops.length&&book.buys.length)blocking.push('FILLED_BUY_WITHOUT_NATIVE_STOP');
    if(mode==='accepted-timeout'&&book.buys.length>1)blocking.push('DUPLICATE_BUY_AFTER_AMBIGUOUS_RESULT');
    results.push({case:mode,executorCode:first.code,outcome:first.outcome,simulatedBuys:book.buys.length,nativeStops:book.stops.length,productionBlockers:blocking});
  }
  const report={at:new Date().toISOString(),network:'MOCK_ONLY',realOrdersSent:0,results,productionReady:!results.some(r=>r.productionBlockers.length)};
  if(process.env.SPOT_CHECK_REPORT)fs.writeFileSync(process.env.SPOT_CHECK_REPORT,JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
  if(!report.productionReady)process.exitCode=2;
}finally{fs.rmSync(folder,{recursive:true,force:true});}
