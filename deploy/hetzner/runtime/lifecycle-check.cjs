'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const repo=process.env.PROYPERS_CHECK_REPO||path.resolve(__dirname,'../../..');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'spot-lifecycle-'));
const results=[];
function invoke(dir,mode,args){
  const r=spawnSync(process.execPath,[path.join(__dirname,'lifecycle-worker.cjs'),...args],{cwd:path.join(repo,'backend'),
    env:{PATH:process.env.PATH,SPOT_TEST_DIR:dir,SPOT_TEST_CASE:mode},encoding:'utf8',timeout:5000});
  if(r.error)throw r.error;
  return {status:r.status,summary:r.status===0?JSON.parse(r.stdout.trim()):null};
}
try{
  const seed=path.join(folder,'seed');fs.mkdirSync(seed);
  const output=path.join(seed,'entry.txt');
  const entry=spawnSync(process.execPath,['--require',path.join(__dirname,'executor-fixture.cjs'),path.join(__dirname,'entry-safe.cjs')],{
    cwd:path.join(repo,'backend'),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:seed,SPOT_TEST_DIR:seed,SPOT_TEST_CASE:'normal-core',PROYPERS_REPO:repo,PROYPERS_STATE_DIR:seed,
      BINANCE_API_KEY:'fixture',BINANCE_SECRET_KEY:'fixture',SIGNAL_SYMBOL:'SOLUSDT',SIGNAL_PRICE:'100',SIGNAL_PCT:'5',SIGNAL_CREATED_AT:new Date().toISOString(),SIGNAL_LANE:'CORE',GITHUB_OUTPUT:output}});
  assert.equal(entry.status,0,entry.stderr);assert.match(fs.readFileSync(output,'utf8'),/outcome=executed/);
  const book=JSON.parse(fs.readFileSync(path.join(seed,'exchange.json')));
  assert.equal(book.buys.length,1);assert.equal(book.stops.length,1);
  Object.assign(book.buys[0],{side:'BUY',type:'MARKET',origQty:book.buys[0].executedQty,time:Date.now()-1000});
  Object.assign(book.stops[0],{orderListId:-1,time:Date.now()});
  const originalQty=book.qty;
  for(const mode of ['happy','partial','partial-lost','residual-lost','dust','new-rejected','unknown-before-accept','repeated-partial']){
    const dir=path.join(folder,mode);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'exchange.json'),JSON.stringify(book));
    const first=invoke(dir,mode,['--exit']);
    const resumed=invoke(dir,mode,[]);
    const final=JSON.parse(fs.readFileSync(path.join(dir,'exchange.json')));
    const sellCount=(final.sells||[]).length;
    const sold=(final.sells||[]).reduce((n,o)=>n+Number(o.executedQty),0);
    assert.equal(final.buys.length,1);assert(Math.abs(sold+final.qty-originalQty)<1e-8);
    if(['happy','partial','partial-lost','residual-lost'].includes(mode)){
      assert.equal(resumed.status,0);assert.equal(resumed.summary.pending,0);assert(Math.abs(final.qty)<1e-9);
      assert.equal(sellCount,mode==='happy'?1:2);
    }
    if(mode==='dust'){assert.equal(resumed.summary.pending,0);assert.equal(sellCount,1);assert(final.qty>0&&final.qty*102<5);}
    if(mode==='new-rejected'){assert.equal(sellCount,0);assert.equal(final.stops.filter(o=>o.status==='NEW').length,1);assert.equal(resumed.summary.pending,0);}
    if(mode==='unknown-before-accept'){assert.equal(sellCount,0);assert.equal(final.stops[0].status,'NEW');assert(resumed.summary.pending>0);}
    if(mode==='repeated-partial'){assert.equal(sellCount,3);assert(resumed.summary.pending>0);}
    invoke(dir,mode,[]);
    assert.equal((JSON.parse(fs.readFileSync(path.join(dir,'exchange.json'))).sells||[]).length,sellCount,'restart duplicated SELL');
    results.push({case:mode,firstStatus:first.status,pending:resumed.summary?.pending,sellRequests:sellCount,quantityConserved:true});
  }
  console.log(JSON.stringify({network:'MOCK_ONLY',realOrdersSent:0,originalCoreEntryVerified:true,results,passed:true},null,2));
}finally{fs.rmSync(folder,{recursive:true,force:true});}
