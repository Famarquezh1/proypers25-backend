'use strict';
// Bounded maintenance verification: authenticated GETs only, no order dispatch.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const state='/var/lib/proypers25/execution-state',runtime='/opt/proypers25/runtime';
const helper=require(process.env.PROYPERS_ENTRY_HELPER||path.join(runtime,'entry-reconciliation.cjs'));
const key=fs.readFileSync('/etc/proypers25/binance-key','utf8').trim(),secret=fs.readFileSync('/etc/proypers25/binance-secret','utf8').trim();
const readonly=require(path.join(runtime,'readonly.cjs')).makeFetch();let requests=0;
const transport=(input,init={})=>{if((init.method||'GET')!=='GET')throw new Error('MAINTENANCE_WRITE_REFUSED');if(++requests>25)throw new Error('MAINTENANCE_READ_BUDGET');return readonly(input,init);};
async function get(endpoint,params={},signed=true){const q=new URLSearchParams(params);if(signed){q.set('recvWindow','5000');q.set('timestamp',String(Date.now()));q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));}const r=await transport('https://api.binance.com'+endpoint+'?'+q,{method:'GET',headers:signed?{'X-MBX-APIKEY':key}:{}});if(!r.ok)throw new Error('MAINTENANCE_HTTP_'+r.status);return r.json();}
(async()=>{
  const {PENDING,createSafety}=require(path.join(runtime,'execution-safety.cjs'));
  const pending=fs.readdirSync(state).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>({file:path.join(state,n),...JSON.parse(fs.readFileSync(path.join(state,n),'utf8'))})).filter(r=>PENDING.has(r.state));
  if(pending.length!==1||pending[0].symbol!=='SOXLBUSDT'||pending[0].state!=='PROTECTION_PENDING')throw new Error('UNEXPECTED_PENDING_STATE');
  const r=pending[0],symbol=r.symbol;
  const [ei,ticker,account,openOrders,orders,trades]=await Promise.all([get('/api/v3/exchangeInfo',{symbol,showPermissionSets:'false'},false),get('/api/v3/ticker/price',{symbol},false),get('/api/v3/account',{omitZeroBalances:'true'}),get('/api/v3/openOrders',{symbol}),get('/api/v3/allOrders',{symbol,limit:'1000'}),get('/api/v3/myTrades',{symbol,limit:'1000'})]);
  const info=ei.symbols?.find(s=>s.symbol===symbol),row=account.balances.find(b=>b.asset===info?.baseAsset)||{},total=Number(row.free||0)+Number(row.locked||0);
  const proof=helper.closureProof({record:r,info,total,price:Number(ticker.price),openOrders,orders,trades});
  if(!proof)throw new Error('REAL_CLOSURE_PROOF_REFUSED');
  const quote=Number(r.buy.cummulativeQuoteQty),entry=quote/Number(r.buy.executedQty);
  if(helper.protectionFits({info,quote,price:entry,stopPct:r.stopPct}))throw new Error('REAL_MINIMUM_REPLAY_MISMATCH');
  console.log('REAL_ENTRY_RECONCILIATION_VERIFIED',JSON.stringify({symbol,reason:proof.reason,residualQuantity:total,minimumReplayRejected:true,realOrdersSent:0}));
  if(process.argv.includes('--apply')){
    if(!fs.existsSync('/var/lib/proypers25/BUY_PAUSED'))throw new Error('MAINTENANCE_PAUSE_REQUIRED');
    const owner=fs.statSync(r.file),safety=createSafety({transport,dir:state,key,secret});
    const result=await safety.recover();
    fs.chownSync(r.file,owner.uid,owner.gid);fs.chmodSync(r.file,0o600);
    const after=JSON.parse(fs.readFileSync(r.file,'utf8'));
    if(result.pending!==0||after.state!=='CLOSED'||after.closure?.reason!==proof.reason)throw new Error('MAINTENANCE_RECONCILIATION_INCOMPLETE');
    console.log('ENTRY_JOURNAL_RECONCILED pending=0 realOrdersSent=0');
  }
})().catch(e=>{console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:'MAINTENANCE_VERIFICATION_FAILED');process.exitCode=2;});
