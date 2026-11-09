'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {allocate}=require('./accounting.cjs'),{reconcile,replay,valueFees,makeBinance}=require('./reconcile.cjs'),{buildReport}=require('./morning-report.cjs'),{parseEntryOutput}=require('./capture.cjs');
const at=Date.parse('2026-11-07T12:00:00Z'),symbol='BTCUSDT';
const order=(id,side,qty='1')=>({orderId:id,symbol,clientOrderId:'proypers-gh-'+id,side,type:'MARKET',status:'FILLED',executedQty:qty,managed:true,time:at});
const fill=(id,oid,qty,quote,commission='0',asset='USDT',time=at)=>({id,orderId:oid,qty,price:'100',quoteQty:quote,commission,commissionAsset:asset,time});
function rows(){return{symbol,orders:[order(10,'BUY'),order(11,'SELL')],fills:[fill(1,10,'1','100','0.1'),fill(2,11,'1','110','0.2','USDT',at+60000)]};}
test('exact FIFO net/gross fee and closed status',()=>{
 const r=allocate(rows()).trades[0];assert.equal(r.status,'CLOSED');assert.equal(r.net_pnl_usdt,'9.7');assert.equal(r.gross_pnl_usdt,'10.0');assert.equal(r.fees_usdt,'0.3');
});
test('base-asset buy fee reduces inventory without duplicate cost',()=>{
 const r=allocate({symbol,orders:[order(20,'BUY'),order(21,'SELL','0.99')],fills:[fill(3,20,'1','100','0.01','BTC'),fill(4,21,'0.99','108.9','0','USDT',at+60000)]}).trades[0];
 assert.equal(r.status,'CLOSED');assert.equal(r.net_pnl_usdt,'8.9');assert.equal(r.fees_usdt,'1.0');
});
test('partial sale has realized PnL but remains open',()=>{
 const r=allocate({symbol,orders:[order(30,'BUY','2'),order(31,'SELL')],fills:[fill(5,30,'2','200'),fill(6,31,'1','120','0.2','USDT',at+60000)]}).trades[0];
 assert.equal(r.status,'PARTIALLY_CLOSED');assert.equal(r.remaining_quantity,'1.0');assert.equal(r.net_pnl_usdt,'19.8');
});
test('FIFO across two entry orders is not double counted',()=>{
 const r=allocate({symbol,orders:[order(40,'BUY'),order(41,'BUY'),order(42,'SELL','2')],fills:[fill(7,40,'1','100'),fill(8,41,'1','100','0','USDT',at+10),fill(9,42,'2','220','0','USDT',at+60000)]});
 assert.equal(r.trades.length,2);assert.deepEqual(r.trades.map(x=>x.net_pnl_usdt),['10.0','10.0']);
});
test('missing fills and commissions cannot be silently marked verified',()=>{
 const r=allocate({symbol,orders:[order(50,'BUY')],fills:[fill(10,50,'0.5','50')]});
 assert.equal(r.trades[0].reconciliation_status,'REVIEW_REQUIRED');
 assert.throws(()=>allocate({symbol,orders:[order(51,'BUY')],fills:[fill(11,51,'1','100','0.01','BNB')]}),/UNVALUED_FEE/);
});
test('duplicate Binance trade id is refused',()=>{assert.throws(()=>allocate({symbol,orders:[order(52,'BUY','2')],fills:[fill(12,52,'1','100'),fill(12,52,'1','100')]}),/DUPLICATE_FILL_ID/);});
test('BNB fee uses historical Binance 1m reference',async()=>{
 const x=await valueFees({get:async()=>[[at,'0','0','0','600','0']]},symbol,[fill(13,55,'1','100','0.01','BNB')]);
 assert.equal(x[0].commission_usdt,'6.0');assert.match(x[0].fee_valuation_source,/BNBUSDT_1M_CLOSE/);
});
test('zero-trade daily report is explicit and mathematically defined',()=>{
 const r=buildReport([],{day:'2026-11-08',reconciliationRun:{ok:true,issues:[],at:new Date().toISOString()}});
 assert.equal(r.summary.closed,0);assert.match(r.text,/Win Rate \(cierres\): N\/D/);assert.match(r.text,/Profit Factor \(cierres\): N\/D/);
});
test('partially sold inventory recognizes only dated sale PnL',()=>{
 const r=allocate({symbol,orders:[order(60,'BUY','2'),order(61,'SELL')],fills:[fill(14,60,'2','200'),fill(15,61,'1','120','0.2','USDT',Date.parse('2026-11-08T12:00:00Z'))]}).trades[0];
 const report=buildReport([r],{day:'2026-11-08'});assert.equal(report.summary.closed,0);assert.equal(report.summary.net_pnl_usdt,'19.8');
});
test('entry metadata requires exact Binance order id',()=>{
 const output={stdout:'GROWTH_ENGINE_V1 lane=CORE equity_usdt=500\nAPPROVED_V61 symbol=BTCUSDT v61_score=0.5512 conviction_tier=HIGH\nORDER_CREATED symbol=BTCUSDT orderId=123 status=FILLED'};
 assert.equal(parseEntryOutput(output,symbol,123).entry_v61_decision.entry_score,0.5512);assert.equal(parseEntryOutput(output,symbol,124).entry_v61_decision,undefined);
});
test('read-only reconciliation and Firestore replay are deterministic',async()=>{
 const input=rows(),api={get:async endpoint=>endpoint.endsWith('allOrders')?input.orders:input.fills};
 const opts={api,symbols:[symbol],since:'2026-11-07T00:00:00Z',until:'2026-11-08T00:00:00Z',state:'/nonexistent-proypers-alpha-test'};
 const a=await reconcile(opts),b=await reconcile(opts);
 assert.equal(a.totals.closed_complete,1);assert.equal(a.trades[0].net_pnl_usdt,b.trades[0].net_pnl_usdt);
 assert.equal(replay(a.trades[0]).ok,true);
});
test('Binance transport never allows write endpoints or verbs',async()=>{
 const client=makeBinance({credentials:{key:'test',secret:'test'},transport:()=>{throw Error('NETWORK_SHOULD_NOT_BE_CALLED');}});
 await assert.rejects(client.get('/api/v3/order',{},true),/ENDPOINT_NOT_ALLOWED/);
});

test('sell with opening BUY outside the queried history is not silently omitted',async()=>{
 const orphanSell=order(96,'SELL');
 const orphanFill=fill(997,96,'1','120','0.1','USDT',at+60000);
 const api={get:async endpoint=>endpoint.endsWith('allOrders')?[orphanSell]:[orphanFill]};
 const r=await reconcile({api,symbols:[symbol],since:'2026-11-07T00:00:00Z',until:'2026-11-08T00:00:00Z',state:'/nonexistent-alpha-check'});
 assert.equal(r.totals.closed_complete,0);
 assert.equal(r.trades.length,0);
 assert.equal(r.issues.length,1);
 assert.match(r.issues[0].details.join(','),/SELL_WITHOUT_MANAGED_INVENTORY/);
});

test('external Binance activity forces an incomplete reconciliation instead of a green result',async()=>{
 const foreign={...order(98,'BUY'),clientOrderId:'manual-from-outside'};
 const base=rows();
 const api={get:async endpoint=>endpoint.endsWith('allOrders')?[...base.orders,foreign]:[...base.fills,fill(998,98,'1','100','0','USDT',at+120000)]};
 const r=await reconcile({api,symbols:[symbol],since:'2026-11-07T00:00:00Z',until:'2026-11-08T00:00:00Z',state:'/nonexistent-alpha-check'});
 assert.equal(r.issues.length,1);
 assert.equal(r.totals.closed_complete,0);
 assert.equal(r.trades[0].reconciliation_status,'REVIEW_REQUIRED');
});

test('entry strategy hash is captured against executed BUY, even when original signal is older',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {captureOnce,allCaptured}=require('./capture.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'px25-alpha-test-')),state=path.join(root,'state'),repo=path.join(root,'repo'),runtime=path.join(root,'runtime');
 try{
  const inputs=['backend/scripts/github-spot-production-radar-v42.js','backend/scripts/github-spot-manual-execution-v10-aware.js','backend/scripts/github-spot-manual-execution.js','backend/scripts/github-spot-auto-exit-legacy-v10-aware.js','backend/scripts/github-spot-auto-exit-legacy.js','backend/config/spot-qubo-production-v5.json','backend/config/spot-exit-policy-v2.json','backend/config/spot-growth-engine-v1.json'];
  for(const f of inputs){const p=path.join(repo,f);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'test content');}
  for(const f of ['engine.cjs','exit-integration.cjs','entry-safe.cjs','exit-safe.cjs']){fs.mkdirSync(runtime,{recursive:true});fs.writeFileSync(path.join(runtime,f),'test content');}
  const createdAt=new Date(Date.now()-200000).toISOString(),buyTime=Date.now()-5000;
  const folder=path.join(state,'execution-state');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'a'.repeat(32)+'.json'),JSON.stringify({symbol,lane:'CORE',createdAt,buy:{orderId:123,time:buyTime}}));
  fs.writeFileSync(path.join(state,'radar-last.json'),JSON.stringify({at:new Date(Date.parse(createdAt)+50000).toISOString(),signal:{symbol,mode:'PRODUCTION_V42_QUBO_V5',v42_norm:0.84,utility:0.71}}));
  fs.writeFileSync(path.join(state,'github-spot-manual-execution-v10-aware.js.last.json'),JSON.stringify({stdout:'APPROVED_V61 symbol=BTCUSDT v61_score=0.553322\nORDER_CREATED symbol=BTCUSDT orderId=123 status=FILLED'}));
  captureOnce({state,repo,runtimeDir:runtime});
  const e=allCaptured(state)[0];assert.match(e.strategy_hash,/^[a-f0-9]{64}$/);
  assert.equal(e.v42_prediction,0.84);assert.equal(e.qubo_decision.qubo_score,0.71);
  assert.equal(e.entry_v61_decision.entry_score,0.553322);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
