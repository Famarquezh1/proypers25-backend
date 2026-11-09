'use strict';
// Read-only Binance GET-only acquisition ledger. Never sends POST/DELETE.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {allocate,d,mul,fmt}=require('./accounting.cjs'),{allCaptured}=require('./capture.cjs');
const ROOT=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25',COLLECTION='alpha_trades_mvp';
const h=v=>crypto.createHash('sha256').update(v).digest('hex');
function readJson(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}}
function readRows(p,rx){if(!fs.existsSync(p))return[];return fs.readdirSync(p).filter(n=>rx.test(n)).map(n=>readJson(path.join(p,n))).filter(Boolean);}
function symbolsFromState(state=ROOT){
 const ledger=readJson(path.join(state,'positions.json'))?.positions||{},rows=readRows(path.join(state,'execution-state'),/^[a-f0-9]{32}\.json$/);
 return [...new Set([...Object.keys(ledger),...rows.map(x=>x.symbol),...allCaptured(state).map(x=>x.symbol)].filter(x=>/^[A-Z0-9]+USDT$/.test(x)))].sort();
}
function credentials(){
 const dir=process.env.CREDENTIALS_DIRECTORY;
 const key=process.env.BINANCE_API_KEY||(dir&&fs.readFileSync(path.join(dir,'binance-key'),'utf8').trim());
 const secret=process.env.BINANCE_SECRET_KEY||(dir&&fs.readFileSync(path.join(dir,'binance-secret'),'utf8').trim());
 if(!key||!secret)throw Error('BINANCE_READ_CREDENTIALS_MISSING');return{key,secret};
}
function makeBinance({transport=global.fetch,credentials:creds=credentials(),base='https://api.binance.com'}={}){
 async function get(endpoint,params={},signed=true){
  if(!/^\/(api\/v3\/(account|allOrders|myTrades|klines|ticker\/price)|sapi\/v1\/account\/apiRestrictions)$/.test(endpoint))throw Error('ENDPOINT_NOT_ALLOWED');
  const q=new URLSearchParams(params);
  if(signed){q.set('recvWindow','5000');q.set('timestamp',String(Date.now()));q.set('signature',crypto.createHmac('sha256',creds.secret).update(q.toString()).digest('hex'));}
  const response=await transport(base+endpoint+'?'+q,{method:'GET',headers:signed?{'X-MBX-APIKEY':creds.key}:{}});
  if(!response.ok)throw Error('BINANCE_READ_HTTP_'+response.status+':'+endpoint);
  return response.json();
 }return{get};
}
async function pagedRange(api,endpoint,symbol,from,to){
 const result=[];let start=from;
 while(start<to){
  const end=Math.min(to,start+86400000-1);
  let page=await api.get(endpoint,{symbol,startTime:String(start),endTime:String(end),limit:'1000'});
  if(!Array.isArray(page))throw Error('BINANCE_HISTORY_INVALID');
  result.push(...page);
  let loops=0;
  while(page.length===1000){
   if(++loops>200)throw Error('BINANCE_HISTORY_PAGE_LIMIT');
   const last=page.at(-1),id=Number(endpoint.endsWith('myTrades')?last.id:last.orderId)+1;
   if(!Number.isSafeInteger(id))throw Error('INVALID_HISTORY_CURSOR');
   page=await api.get(endpoint,{symbol,...(endpoint.endsWith('myTrades')?{fromId:String(id)}:{orderId:String(id)}),limit:'1000'});
   if(!Array.isArray(page))throw Error('BINANCE_HISTORY_INVALID');
   const time=x=>Number(x.time??x.transactTime??x.updateTime);
   result.push(...page.filter(x=>time(x)>=start&&time(x)<=end));
   if(!page.length||time(page[0])>end||time(page.at(-1))>end)break;
  }
  start=end+1;
 }
 const key=x=>String(endpoint.endsWith('myTrades')?x.id:x.orderId);
 return [...new Map(result.map(x=>[key(x),x])).values()];
}
function ownedOrder(o){return /^(proypers-gh-|px25b_|px25x_|px25lr_|px25xec_|px25ghxec_)/.test(String(o.clientOrderId||''));}
async function valueFees(api,symbol,fills){
 const cache=new Map(),base=symbol.slice(0,-4),out=[];
 for(const f of fills){
  const asset=f.commissionAsset,fee=Number(f.commission??0);
  if(!(fee>=0))throw Error('INVALID_COMMISSION');
  if(!fee||asset==='USDT'||asset===base){out.push(f);continue;}
  const minute=Math.floor(Number(f.time)/60000)*60000,pair=asset+'USDT',key=pair+':'+minute;
  if(!cache.has(key)){
   const k=await api.get('/api/v3/klines',{symbol:pair,interval:'1m',startTime:String(minute),endTime:String(minute+59999),limit:'1'},false);
   if(!Array.isArray(k)||k.length!==1||!(Number(k[0][4])>0))throw Error('UNVALUED_COMMISSION:'+asset+':'+f.id);
   cache.set(key,String(k[0][4]));
  }
  out.push({...f,commission_usdt:fmt(mul(d(f.commission),d(cache.get(key)))),fee_valuation_source:'BINANCE_'+pair+'_1M_CLOSE:'+new Date(minute).toISOString()});
 }
 return out;
}
function reasonsFromState(state=ROOT){
 const out=[];for(const name of ['exit-decisions.jsonl','exit-decisions.jsonl.previous']){
  const p=path.join(state,name);if(!fs.existsSync(p))continue;
  for(const row of fs.readFileSync(p,'utf8').split('\n')){try{const j=JSON.parse(row);if(j.phase==='DECISION_BEFORE_DISPATCH'&&j.buyOrderId&&j.reason)out.push(j);}catch{}}
 }return out;
}
function exitReason(trade,orders,decisions){
 if(!trade.exit_timestamp)return null;
 const found=decisions.filter(x=>x.symbol===trade.symbol&&String(x.buyOrderId)===trade.buy_order_id).sort((a,b)=>Date.parse(a.at||0)-Date.parse(b.at||0));
 if(found.length)return found.at(-1).reason;
 const sells=orders.filter(x=>trade.sell_order_ids.includes(String(x.orderId)));
 return sells.length&&sells.every(x=>['STOP_LOSS','STOP_LOSS_LIMIT'].includes(x.type))?'NATIVE_PROTECTIVE_STOP':null;
}
async function reconcile({api=makeBinance(),state=ROOT,symbols,since=process.env.ALPHA_SINCE||'2026-10-30T00:00:00Z',until=new Date().toISOString(),db=null,write=false}={}){
 const start=Date.parse(since),end=Date.parse(until);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>365*86400000)throw Error('INVALID_RANGE');
 const list=symbols?.length?symbols:symbolsFromState(state);
 if(!list.length||list.some(x=>!/^[A-Z0-9]+USDT$/.test(x)))throw Error('NO_VALID_MANAGED_SYMBOLS');
 if(write&&!db)throw Error('FIRESTORE_REQUIRED');
 const metadata=Object.fromEntries(allCaptured(state).filter(x=>x.buy_order_id).map(x=>[String(x.buy_order_id),x])),decisions=reasonsFromState(state);
 const trades=[],issues=[];
 for(const symbol of list){try{
  const [rawOrders,rawFills]=await Promise.all([pagedRange(api,'/api/v3/allOrders',symbol,start,end),pagedRange(api,'/api/v3/myTrades',symbol,start,end)]);
  const orders=rawOrders.map(x=>({...x,managed:ownedOrder(x)})),fills=await valueFees(api,symbol,rawFills);
  const result=allocate({symbol,orders,fills,metadataByOrder:metadata});
  if(orders.some(x=>!x.managed&&Number(x.executedQty)>0))result.anomalies.push('FOREIGN_SYMBOL_HISTORY_PRESENT_REVIEW');
  for(const trade of result.trades){
   trade.exit_reason=exitReason(trade,orders,decisions);
   trade.anomalies=[...new Set([...result.anomalies,...(trade.anomalies||[]),
    ...(!trade.strategy_hash?['STRATEGY_HASH_MISSING']:[]),
    ...(!trade.radar_signal?['ORIGIN_SIGNAL_MISSING']:[]),
    ...(trade.capital_at_entry_usdt===null?['CAPITAL_AT_ENTRY_MISSING']:[]),
    ...(!trade.exit_reason&&trade.exit_timestamp?['EXIT_REASON_UNVERIFIED']:[])])];
   trade.reconciliation_status=trade.anomalies.some(x=>/^(INCOMPLETE_ORDER|FOREIGN_|SELL_WITHOUT|UNVALUED_)/.test(x))?'REVIEW_REQUIRED':'COMPLETE';
   trade.reconciled_at=new Date().toISOString();trade.scope_since=since;trade.scope_until=until;
   trade.orders=orders.filter(x=>x.managed&&(String(x.orderId)===trade.buy_order_id||trade.sell_order_ids.includes(String(x.orderId))));
   trade.replay={account_id:trade.account_id,orders,fills};
   trade.firestore_id=h(trade.trade_id);
   if(write){if(Buffer.byteLength(JSON.stringify(trade))>800000)throw Error('FIRESTORE_DOCUMENT_TOO_LARGE:'+trade.trade_id);await db.collection(COLLECTION).doc(trade.firestore_id).set(trade);}
   trades.push(trade);
  }
 }catch(e){issues.push({symbol,error:e.message});}}
 return{at:new Date().toISOString(),scope:{since,until,symbols:list},trades,issues,
  totals:{identified:trades.length,accounting_complete:trades.filter(x=>x.reconciliation_status==='COMPLETE').length,
  closed_complete:trades.filter(x=>x.status==='CLOSED'&&x.reconciliation_status==='COMPLETE').length}};
}
function replay(trade){
 if(!trade.replay?.orders||!trade.replay?.fills)throw Error('REPLAY_EVIDENCE_MISSING');
 const r=allocate({symbol:trade.symbol,orders:trade.replay.orders,fills:trade.replay.fills,accountId:trade.replay.account_id||'spot-primary'});
 const found=r.trades.find(x=>x.trade_id===trade.trade_id);if(!found)throw Error('REPLAY_NOT_FOUND');
 for(const k of ['net_pnl_usdt','gross_pnl_usdt','fees_usdt','remaining_quantity','status'])if(found[k]!==trade[k])throw Error('REPLAY_MISMATCH:'+k);
 return{ok:true,trade_id:trade.trade_id};
}
if(require.main===module){
 const args=process.argv.slice(2),getArg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 (async()=>{
  if(args.includes('--replay')){const db=require('../firebase-admin-config'),snap=await db.collection(COLLECTION).doc(getArg('--replay')).get();if(!snap.exists)throw Error('TRADE_NOT_FOUND');console.log(JSON.stringify(replay(snap.data())));return;}
  const write=args.includes('--write-firestore'),db=write?require('../firebase-admin-config'):null;
  const r=await reconcile({symbols:getArg('--symbols')?.split(','),since:getArg('--since'),db,write});
  if(write){const dir=path.join(ROOT,'alpha-mvp');fs.mkdirSync(dir,{recursive:true,mode:0o700});
   fs.writeFileSync(path.join(dir,'reconcile-last.json'),JSON.stringify({at:r.at,ok:r.issues.length===0,issues:r.issues,scope:r.scope,totals:r.totals}),{mode:0o600});}
  console.log(JSON.stringify({scope:r.scope,totals:r.totals,issues:r.issues}));
  if(r.issues.length)process.exitCode=2;
 })().catch(e=>{console.error('ALPHA_RECONCILE_ERROR:'+e.message);process.exitCode=2;});
}
module.exports={reconcile,replay,makeBinance,pagedRange,valueFees,symbolsFromState,exitReason,ownedOrder,COLLECTION};
