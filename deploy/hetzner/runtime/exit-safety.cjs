'use strict';
// Reconciliation for the staged exit chain. The underlying read-only transport is unchanged.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {atomic}=require('./journal.cjs');
const PENDING=new Set(['SELL_INTENT','SELL_UNKNOWN','SELL_PENDING','SELL_REVIEW']);
function createExitSafety({transport,dir,key,secret,now=Date.now}){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const records=()=>fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>{
    const file=path.join(dir,n),r=JSON.parse(fs.readFileSync(file,'utf8'));
    if(r.version!==1||!r.symbol||!r.clientId||(!PENDING.has(r.state)&&r.state!=='SELL_FILLED'))throw new Error('EXIT_STATE_REVIEW_REQUIRED');
    return {file,...r};
  });
  function save(r){const {file,...data}=r;atomic(file,{...data,updatedAt:new Date(now()).toISOString()});}
  async function signed(method,endpoint,params={}){
    const q=new URLSearchParams(params);q.set('recvWindow','5000');q.set('timestamp',String(now()));
    q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));
    return transport(`https://api.binance.com${endpoint}?${q}`,{method,headers:{'X-MBX-APIKEY':key}});
  }
  function apply(r,o){
    if(o.symbol!==r.symbol||o.clientOrderId!==r.clientId||!o.orderId||o.side!=='SELL'||o.type!=='MARKET')throw new Error('SELL_IDENTITY_MISMATCH');
    const executed=Number(o.executedQty),original=Number(o.origQty);
    if(!Number.isFinite(executed)||!Number.isFinite(original)||original<=0||original!==Number(r.quantity)||executed<0||executed>original)throw new Error('SELL_QUANTITY_INVALID');
    r.order=o;
    // Partial terminal fills remain blocked for review, rather than silently selling the remainder again.
    r.state=o.status==='FILLED'&&executed===original?'SELL_FILLED':
      ['NEW','PARTIALLY_FILLED','PENDING_NEW','PENDING_CANCEL'].includes(o.status)?'SELL_PENDING':'SELL_REVIEW';
    save(r);
  }
  async function recover(){
    for(const r of records().filter(r=>PENDING.has(r.state))){
      try{
        const response=await signed('GET','/api/v3/order',{symbol:r.symbol,origClientOrderId:r.clientId});
        const order=await response.json();
        if(response.ok)apply(r,order);
        // -2013, timeouts, malformed responses and other errors never permit resubmission.
      }catch{ /* Keep the durable interlock. */ }
    }
    return {pending:records().filter(r=>PENDING.has(r.state)).length};
  }
  async function fetch(input,init={}){
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    const method=String(init.method||input?.method||'GET').toUpperCase(),p=url.searchParams;
    if(!/^api[1-4]?\.binance\.com$/.test(url.hostname)||method==='GET')return transport(input,init);
    // A cancel-replace is not transactional. Preserve the old stop rather than cancel first.
    // Also reject bulk/OCO cancellation, amendments and BUYs inside the exit worker.
    if(url.pathname!=='/api/v3/order'||method!=='POST'||p.get('side')!=='SELL')throw new Error('EXIT_MUTATION_REFUSED_OLD_PROTECTION_RETAINED');
    if(['STOP_LOSS','STOP_LOSS_LIMIT'].includes(p.get('type'))) {
      // Initial and replacement stop dispatch remains behind the immutable staging barrier.
      return transport(input,init);
    }
    if(p.get('type')!=='MARKET'||p.has('quoteOrderQty')||!(Number(p.get('quantity'))>0))throw new Error('EXIT_ORDER_FORMAT_REFUSED');
    if(records().some(r=>PENDING.has(r.state)))throw new Error('SELL_RECOVERY_PENDING');
    const history=await signed('GET','/api/v3/allOrders',{symbol:p.get('symbol'),limit:'1000'});
    if(!history.ok)throw new Error('EXIT_POSITION_IDENTITY_REQUIRED');
    const orders=await history.json();if(!Array.isArray(orders))throw new Error('EXIT_POSITION_IDENTITY_REQUIRED');
    const buys=orders.filter(o=>o.symbol===p.get('symbol')&&o.side==='BUY'&&o.status==='FILLED'&&String(o.clientOrderId||'').startsWith('proypers-gh-'));
    buys.sort((a,b)=>Number(a.time)-Number(b.time));const buy=buys.at(-1);
    if(!buy?.orderId||!Number.isFinite(Number(buy.time)))throw new Error('EXIT_POSITION_IDENTITY_REQUIRED');
    if(orders.some(o=>o.side==='SELL'&&o.status==='FILLED'&&Number(o.time)>=Number(buy.time)))throw new Error('EXIT_AFTER_PRIOR_SELL_REQUIRES_REVIEW');
    if(!Number.isFinite(Number(buy.executedQty))||Number(buy.executedQty)<=0||!Number.isFinite(Number(p.get('quantity')))||Number(p.get('quantity'))>Number(buy.executedQty))throw new Error('EXIT_QUANTITY_EXCEEDS_MANAGED_BUY');
    const id=crypto.createHash('sha256').update(`${buy.symbol}:${buy.orderId}:MARKET_EXIT`).digest('hex').slice(0,32);
    const prior=records().find(r=>r.id===id);
    if(prior){
      if(prior.state==='SELL_FILLED')return new Response(JSON.stringify(prior.order),{status:200});
      throw new Error('SELL_INTENT_ALREADY_EXISTS_REVIEW_REQUIRED');
    }
    const r={version:1,id,file:path.join(dir,id+'.json'),symbol:buy.symbol,buyOrderId:buy.orderId,
      clientId:`proypers-gh-exit-${id.slice(0,19)}`,quantity:p.get('quantity'),state:'SELL_INTENT'};
    save(r); // fsync before any order dispatch, survives process death.
    const params=Object.fromEntries(p);delete params.signature;delete params.timestamp;params.newClientOrderId=r.clientId;
    let response,body;
    try{response=await signed('POST','/api/v3/order',params);body=await response.clone().json();}
    catch{r.state='SELL_UNKNOWN';save(r);throw new Error('SELL_RESULT_UNKNOWN');}
    if(response.ok){try{apply(r,body);}catch{r.state='SELL_UNKNOWN';save(r);throw new Error('SELL_RESULT_UNKNOWN');}}
    else {r.state=response.status>=500||[-1006,-1007].includes(body?.code)?'SELL_UNKNOWN':'SELL_REVIEW';save(r);}
    return response;
  }
  return {fetch,recover,records,pending:()=>records().filter(r=>PENDING.has(r.state)).length};
}
module.exports={createExitSafety};
