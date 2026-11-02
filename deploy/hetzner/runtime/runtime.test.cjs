'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {makeFetch}=require('./readonly.cjs');
const {Journal,atomic}=require('./journal.cjs');
const {coverage}=require('./audit.cjs');
const {createSafety,lock}=require('./execution-safety.cjs');
test('the entry safety adapter cannot bypass the staging write barrier',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-entry-barrier-'));
  try{
    let calls=0,reads=0;const blocked=makeFetch(()=>{calls++;throw new Error('NETWORK_MUST_NOT_RUN');});
    const transport=(input,init={})=>{
      if((init.method||'GET')!=='GET')return blocked(input,init);
      reads++;const u=new URL(input);
      if(u.pathname==='/api/v3/ticker/price')return Response.json({symbol:'BTCUSDT',price:'100'});
      if(u.pathname==='/api/v3/exchangeInfo')return Response.json({symbols:[{symbol:'BTCUSDT',status:'TRADING',isSpotTradingAllowed:true,orderTypes:['STOP_LOSS'],filters:[{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'MIN_NOTIONAL',minNotional:'5'}]}]});
      throw new Error('UNEXPECTED_READ');
    };
    const safety=createSafety({transport,dir,key:'dummy',secret:'dummy',context:{symbol:'BTCUSDT',lane:'CORE',createdAt:'2026-10-31T10:00:00Z'},
      repo:process.env.PROYPERS_CHECK_REPO||path.resolve(__dirname,'../../..')});
    const r=await safety.fetch('https://api.binance.com/api/v3/order?symbol=BTCUSDT&side=BUY&type=MARKET&quoteOrderQty=10',{method:'POST'});
    assert.equal(r.status,403);assert.equal(calls,0);assert.equal(reads,2);assert.equal(safety.current().state,'REJECTED');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the global execution lock rejects concurrent entry/recovery workers',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-entry-lock-'));
  try{const release=lock(dir);assert.throws(()=>lock(dir),/ALREADY_RUNNING/);release();lock(dir)();}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('exchangeInfo omits only unused permission expansion while retaining the symbol query',async()=>{
  const {EventEmitter}=require('node:events');let captured;
  const get=makeFetch((url,options,callback)=>{
    captured=new URL(url);assert.equal(options.family,4);
    const request=new EventEmitter(),response=new EventEmitter();response.statusCode=200;
    callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from('{"symbols":[]}'));response.emit('end');});return request;
  });
  const response=await get('https://api.binance.com/api/v3/exchangeInfo?symbol=BTCUSDT');
  assert.equal(captured.searchParams.get('symbol'),'BTCUSDT');
  assert.equal(captured.searchParams.get('showPermissionSets'),'false');
  assert.deepEqual(await response.json(),{symbols:[]});
});
test('writes are rejected before transport, regardless of activation environment',async()=>{
  let calls=0;const get=makeFetch(()=>{calls++;throw new Error('NETWORK_MUST_NOT_RUN');});
  process.env.PROYPERS_LIVE='true';
  for(const method of ['POST','DELETE','PATCH','PUT'])assert.equal((await get('https://api.binance.com/api/v3/order',{method})).status,403);
  assert.equal(calls,0);delete process.env.PROYPERS_LIVE;
});
test('unknown destinations and credential forwarding fail closed',async()=>{
  const get=makeFetch(()=>assert.fail('unexpected network'));
  await assert.rejects(get('https://example.org/'),/HOST_DENIED/);
  await assert.rejects(get('https://data-api.binance.vision/api/v3/ping',{headers:{'X-MBX-APIKEY':'dummy'}}),/CREDENTIAL_DESTINATION_DENIED/);
  await assert.rejects(get('http://api.binance.com/'),/TARGET_DENIED/);
});
test('actual preload blocks an order in a separate Node process',()=>{
  const r=spawnSync(process.execPath,['--require',path.join(__dirname,'readonly.cjs'),'-e',
    "fetch('https://api.binance.com/api/v3/order',{method:'POST'}).then(r=>{if(r.status!==403)process.exit(1);console.log('BLOCKED')})"],
    {env:{PATH:process.env.PATH,PROYPERS_STAGING_PRELOAD:'1'},encoding:'utf8'});
  assert.equal(r.status,0);assert.match(r.stdout,/BLOCKED/);assert.match(r.stderr,/SHADOW_WRITE_BLOCKED/);
});
test('exit orchestration passes the write barrier to its nested Node children',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-nested-'));
  const oldRepo=process.env.PROYPERS_REPO,oldState=process.env.PROYPERS_STATE_DIR;
  try{
    const scripts=path.join(dir,'backend','scripts');fs.mkdirSync(scripts,{recursive:true});
    const child="fetch('https://unreachable.invalid/api/v3/order',{method:'POST'}).then(r=>{if(r.status!==403)process.exit(1);console.log('NESTED_WRITE_BLOCKED')}).catch(()=>process.exit(2))";
    fs.writeFileSync(path.join(scripts,'github-spot-orphan-audit.js'),child);
    fs.writeFileSync(path.join(scripts,'github-spot-auto-exit.js'),
      `const r=require('node:child_process').spawnSync(process.execPath,[require('node:path').join(__dirname,'github-spot-orphan-audit.js')],{stdio:'inherit',env:process.env});process.exit(r.status||0);`);
    process.env.PROYPERS_REPO=dir;process.env.PROYPERS_STATE_DIR=path.join(dir,'state');
    const {run}=require('./engine.cjs');
    const result=await run('github-spot-auto-exit.js',{},5000);
    assert.equal(result.code,0);assert.match(result.stdout,/NESTED_WRITE_BLOCKED/);assert.equal(result.blocked,1);
  }finally{
    if(oldRepo===undefined)delete process.env.PROYPERS_REPO;else process.env.PROYPERS_REPO=oldRepo;
    if(oldState===undefined)delete process.env.PROYPERS_STATE_DIR;else process.env.PROYPERS_STATE_DIR=oldState;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('an intent survives restart and UNKNOWN is never automatically retried',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-journal-'));
  try{
    const signal={symbol:'BTCUSDT',createdAt:'2026-10-31T10:00:00.000Z',lane:'CORE'};
    const first=new Journal(dir).claim(signal);assert(first);assert(first.clientOrderId.length<=36);
    const old=JSON.parse(fs.readFileSync(first.file));atomic(first.file,{...old,state:'UNKNOWN'});
    assert.equal(new Journal(dir).claim(signal),null);
    assert.equal(JSON.parse(fs.readFileSync(first.file)).state,'UNKNOWN');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
const info=[{symbol:'ABCUSDT',baseAsset:'ABC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,
  filters:[{filterType:'LOT_SIZE',stepSize:'1',minQty:'1'},{filterType:'MIN_NOTIONAL',minNotional:'5'}]}];
const prices=[{symbol:'ABCUSDT',price:'2'}];
const account={balances:[{asset:'ABC',free:'4',locked:'6'}]};
test('take-profit alone and partial stops do not count as full loss protection',()=>{
  const order={symbol:'ABCUSDT',side:'SELL',status:'NEW',type:'TAKE_PROFIT_LIMIT',origQty:'10',executedQty:'0',stopPrice:'3'};
  assert.equal(coverage(account,[order],info,prices)[0].status,'UNPROTECTED_OR_PARTIAL');
  assert.equal(coverage(account,[{...order,type:'STOP_LOSS_LIMIT',origQty:'6'}],info,prices)[0].status,'UNPROTECTED_OR_PARTIAL');
  assert.equal(coverage(account,[{...order,type:'STOP_LOSS_LIMIT'}],info,prices)[0].status,'NATIVE_STOP_PRESENT');
});
test('unknown assets and invalid balances require review instead of claiming safety',()=>{
  assert.equal(coverage({balances:[{asset:'XYZ',free:'3',locked:'0'}]},[],info,prices)[0].status,'UNVALUED_REQUIRES_REVIEW');
  assert.throws(()=>coverage({balances:[{asset:'ABC',free:'broken',locked:'0'}]},[],info,prices),/INVALID_BALANCE/);
});
