'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { submitOrder, requestJson } = require('../services/spotOrderSafety');
const { resolveManagedResidual } = require('../services/spotManagedResidual');
const { evaluateMicrostructure } = require('../services/localPretradeGuard');
const { evaluateSpotEntryBurstGate } = require('../services/spotEntryBurstGate');
function memory() {
  const records = new Map();
  return { read: s => records.get(s), write: (s, x) => { assert(!records.has(s)); records.set(s,x); }, clear: s => records.delete(s) };
}
const params = { symbol: 'ALTUSDT', side: 'SELL', type: 'MARKET', quantity: '1', newClientOrderId: 'test-exit' };
async function orderTests() {
  const store = memory(); let posts = 0; let reads = 0;
  const send = async (_, method, endpoint) => {
    if (method === 'POST') { posts++; throw new Error('fetch failed'); }
    reads++;
    return endpoint.endsWith('/account') ? { balances: [] } : { orderId: 1, status: 'FILLED' };
  };
  assert.equal((await submitOrder(send, '', params, store)).status, 'FILLED');
  assert.equal(posts, 1); assert.equal(reads, 2);
  const pending = memory();
  const down = async (_, method) => { if (method === 'POST') posts++; throw new Error('offline'); };
  await assert.rejects(submitOrder(down, '', params, pending), /RECONCILIATION_REQUIRED/);
  const before = posts;
  await assert.rejects(submitOrder(down, '', params, pending), /RECONCILIATION_REQUIRED/);
  assert.equal(posts, before, 'restart must not resubmit uncertain intent');
  await assert.rejects(submitOrder(send, '', params, pending), /REFRESH_REQUIRED/);
  assert.equal(posts, before, 'reconciliation must force caller to refresh before another mutation');
  const stopStore = memory(); let stopPosts=0;
  const stopSend = async (_,method,endpoint) => { if(method==='POST'){stopPosts++;throw new Error('lost ACK');} return endpoint.endsWith('/account')?{balances:[]}:{orderId:3,status:'NEW'}; };
  assert.equal((await submitOrder(stopSend,'',{...params,type:'STOP_LOSS'},stopStore)).status,'NEW');
  assert.equal(stopPosts,1); assert(!stopStore.read(params.symbol));
  const partial = memory();
  const part = async (_, method, endpoint) => endpoint.endsWith('/account') ? {balances: []} : {orderId: 2, status: 'PARTIALLY_FILLED'};
  await assert.rejects(submitOrder(part, '', params, partial), /ORDER_STILL_ACTIVE/);
  assert(partial.read(params.symbol));
  let attempts=0;
  await assert.rejects(requestJson('mock', {}, async () => { attempts++; throw new Error('down'); }), /down/);
  assert.equal(attempts,2);
  attempts=0;
  await assert.rejects(requestJson('mock', {method:'POST'}, async () => { attempts++; throw new Error('down'); }), /down/);
  assert.equal(attempts,1);
  await assert.rejects(requestJson('mock', {}, async () => ({ok:true,text:async()=>'<html>'})), /INVALID_JSON/);
}
function policyTests() {
  const old = 1000, now = old + 131*3600000;
  const orders = [
    {orderId:1,side:'BUY',executedQty:10,cummulativeQuoteQty:100,time:old,clientOrderId:'proypers-gh-old'},
    {orderId:2,side:'SELL',executedQty:9.999,status:'FILLED',time:old+100,clientOrderId:'proypers-gh-exit-old'},
    {orderId:3,side:'BUY',executedQty:10,cummulativeQuoteQty:100,time:now,clientOrderId:'proypers-gh-new'}
  ];
  const trades = orders.map((o,i)=>({id:i,orderId:o.orderId,isBuyer:o.side==='BUY',qty:o.executedQty,quoteQty:o.cummulativeQuoteQty||99.99,time:o.time}));
  const position=resolveManagedResidual({buy:orders[2],orders,trades,ownedTotal:10.001,baseAsset:'ALT',forceReconstruct:true});
  assert.equal(position.startTime,now,'historical dust must not age a new base entry');
  const covered=resolveManagedResidual({buy:orders[2],orders:[orders[2],{side:'SELL',status:'NEW',time:now+1,origQty:2,executedQty:0,clientOrderId:'proypers-gh-protect-test'}],ownedTotal:10,baseAsset:'ALT'});
  assert.equal(covered.managedQty,10,'partial stop must not hide unprotected quantity');
  const snapshots = [100,100,100].map(mid=>({bid:mid,ask:mid+.01,mid,spreadPct:.0001}));
  assert.equal(evaluateMicrostructure(snapshots,{latencyMs:10,clockSkewMs:10},{continuationRequired:true}).code,'MOMENTUM_CONTINUATION_WEAK');
  assert.equal(evaluateSpotEntryBurstGate({v42Quality:{passCount:0,norm:0}}).code,'CORE_QUALITY_REQUIRED');
  const early={passCount:2,norm:.83,freshEnough:true,detail:{confirm:.1,r15:.01,extension:.02}};
  assert.equal(evaluateSpotEntryBurstGate({currentPct:7,v42Quality:early}).code,'EARLY_CONFIRMATION_ADMITTED');
  assert.equal(evaluateSpotEntryBurstGate({currentPct:9,v42Quality:early}).allow,false);
}
// Load production source in an isolated VM. No network and no secrets are used.
function engineWith(fetchImpl) {
  const filename=path.resolve(__dirname,'../scripts/github-spot-auto-exit-legacy.js');
  const req=createRequire(filename); const store=memory();
  const module={exports:{}};
  const logs=[];
  const context={module,process:{env:{BINANCE_API_KEY:'mock',BINANCE_SECRET:'mock',GITHUB_TOKEN:'mock',GITHUB_REPOSITORY:'mock/repo'},exit:()=>{throw new Error('unexpected exit');}},
    require:(name)=>name==='../services/spotOrderSafety'?{submitOrder:(send,base,p)=>submitOrder(send,base,p,store),requestJson:(url,o)=>requestJson(url,o,fetchImpl),journalStore:()=>store}:req(name),
    console:{log:x=>logs.push(x),warn:x=>logs.push(x),error:x=>logs.push(x)},fetch:fetchImpl,URLSearchParams,Date,AbortSignal};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  return {engine:module.exports,logs};
}
async function engineTests() {
  const reply=body=>({ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body});
  const now=Date.now();let created=0;
  const info=symbol=>({symbol,baseAsset:symbol.replace('USDT',''),status:'TRADING',isSpotTradingAllowed:true,orderTypes:['STOP_LOSS'],filters:[{filterType:'LOT_SIZE',minQty:'1',stepSize:'0.01'},{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'MIN_NOTIONAL',minNotional:'5'}]});
  const account={canTrade:true,balances:[{asset:'DUST',free:'.1',locked:'0'},{asset:'GOOD',free:'10',locked:'0'},{asset:'USDT',free:'0',locked:'0'}]};
  const fake=async (url,options={})=>{
    const u=new URL(url),symbol=u.searchParams.get('symbol'),p=u.pathname;
    if(u.hostname==='api.github.com') {
      if(u.searchParams.get('state')==='closed') return reply(['DUSTUSDT','GOODUSDT'].map(s=>({title:`[SPOT SIGNAL] ${s}`,state_reason:'completed',created_at:new Date(now).toISOString()})));
      return reply([]);
    }
    if(p.endsWith('/ping'))return reply({});
    if(p.endsWith('/apiRestrictions'))return reply({enableWithdrawals:false});
    if(p.endsWith('/account'))return reply(account);
    if(p.endsWith('/openOrders'))return reply([]);
    if(p.endsWith('/allOrders'))return reply([{side:'BUY',status:'FILLED',orderId:10,clientOrderId:'proypers-gh-test',time:now-10000,executedQty:symbol==='DUSTUSDT'?'.1':'10',cummulativeQuoteQty:symbol==='DUSTUSDT'?'1':'100'}]);
    if(p.endsWith('/exchangeInfo'))return reply({symbols:[info(symbol)]});
    if(p.endsWith('/ticker/price'))return reply(symbol?{price:'10'}:[{symbol:'GOODUSDT',price:'10'},{symbol:'DUSTUSDT',price:'10'}]);
    if(p.endsWith('/klines'))return reply([[now-1000,10,10,10,10]]);
    if(p.endsWith('/order')&&options.method==='POST'){created++;return reply({orderId:20,status:'NEW'});}
    throw new Error(`unmocked ${url}`);
  };
  const {engine,logs}=engineWith(fake);
  await assert.rejects(engine.main(),/EXIT_ENGINE_DEGRADED/);
  assert.equal(created,1,'dust must not prevent next symbol from receiving protection');
  assert(logs.some(x=>x.includes('NATIVE_STOP_ARMED symbol=GOODUSDT')));
  assert(!logs.some(x=>x.startsWith('EXIT_ENGINE_OK')));
  let deletes=0;
  const preflight=engineWith(async(url,options={})=>{if(options.method==='DELETE')deletes++;return reply(account);});
  await assert.rejects(preflight.engine.marketSell('https://mock',info('DUSTUSDT'),'DUSTUSDT',.1,'TIMEOUT_STALE',10,10),/quantity below minimum/);
  assert.equal(deletes,0,'dust must retain existing protection before a failed sell preflight');
  const scope=engineWith(async()=>{throw new Error('GitHub down');});
  await assert.rejects(scope.engine.managedSymbols('https://mock'),/EXIT_SCOPE_INCOMPLETE/);
}
function supervisorTests() {
  const filename=path.resolve(__dirname,'../scripts/github-spot-auto-exit.js'); const called=[];const messages=[];
  const processMock={execPath:'node',env:{},exitCode:0};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{__dirname:path.dirname(filename),process:processMock,console:{log:x=>messages.push(x),error:x=>messages.push(x)},require:name=>name==='child_process'?{spawnSync:(_,args)=>{called.push(path.basename(args[0]));return {status:called.length===1?2:0};}}:require(name)});
  assert(called.includes('github-spot-auto-exit-legacy-v10-aware.js'));assert.equal(called.length,5);assert.equal(processMock.exitCode,2);
  assert(!messages.some(x=>x.startsWith('AUTO_EXIT_V61_OK')));
}
(async()=>{supervisorTests();await orderTests();policyTests();await engineTests();console.log('spotSafetyRegression: OK (offline mocks, zero real orders)');})().catch(e=>{console.error(e);process.exitCode=1;});
