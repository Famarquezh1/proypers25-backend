'use strict';
// Reconciliation for the staged exit chain. The underlying read-only transport is unchanged.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {atomic}=require('./journal.cjs');
const {planResidual}=require('./residual-sale.cjs');
const PENDING=new Set(['SELL_INTENT','SELL_UNKNOWN','SELL_PENDING','SELL_REVIEW','SELL_PARTIAL','SELL_RESIDUAL_PENDING','STOP_INTENT','STOP_UNKNOWN','STOP_REVIEW']);
const TERMINAL=new Set(['SELL_FILLED','SELL_COMPLETED','SELL_DUST','SELL_REMAINDER_PROTECTED','STOP_ACTIVE','STAGING_BLOCKED']);
function createExitSafety({transport,dir,key,secret,now=Date.now}){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const records=()=>fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>{
    const file=path.join(dir,n),r=JSON.parse(fs.readFileSync(file,'utf8'));
    if(r.version!==1||!r.symbol||!r.clientId||(!PENDING.has(r.state)&&!TERMINAL.has(r.state)))throw new Error('EXIT_STATE_REVIEW_REQUIRED');
    return {file,...r};
  });
  function save(r){const {file,...data}=r;atomic(file,{...data,updatedAt:new Date(now()).toISOString()});}
  async function signed(method,endpoint,params={}){
    const q=new URLSearchParams(params);q.set('recvWindow','5000');q.set('timestamp',String(now()));
    q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));
    return transport(`https://api.binance.com${endpoint}?${q}`,{method,headers:{'X-MBX-APIKEY':key}});
  }
  async function get(endpoint,params={},privateRequest=true){
    const response=privateRequest?await signed('GET',endpoint,params):await transport(`https://api.binance.com${endpoint}?${new URLSearchParams(params)}`,{method:'GET'});
    if(!response.ok)throw new Error('EXIT_RECOVERY_READ_FAILED');return response.json();
  }
  function apply(r,o){
    if(o.symbol!==r.symbol||o.clientOrderId!==r.clientId||!o.orderId||o.side!=='SELL'||o.type!==(r.orderType||'MARKET'))throw new Error('SELL_IDENTITY_MISMATCH');
    const executed=Number(o.executedQty),original=Number(o.origQty);
    if(!Number.isFinite(executed)||!Number.isFinite(original)||original<=0||original!==Number(r.quantity)||executed<0||executed>original)throw new Error('SELL_QUANTITY_INVALID');
    r.order=o;
    if(r.orderType&&r.orderType!=='MARKET'){
      if(Number(o.stopPrice)!==Number(r.stopPrice))throw new Error('STOP_PRICE_MISMATCH');
      r.state=o.status==='FILLED'?'SELL_FILLED':['NEW','PARTIALLY_FILLED'].includes(o.status)?'STOP_ACTIVE':'STOP_REVIEW';
    }else r.state=o.status==='FILLED'&&executed===original?'SELL_FILLED':
      ['NEW','PARTIALLY_FILLED','PENDING_NEW','PENDING_CANCEL'].includes(o.status)?'SELL_PENDING':
      ['CANCELED','EXPIRED','EXPIRED_IN_MATCH'].includes(o.status)&&executed<original?'SELL_PARTIAL':'SELL_REVIEW';
    save(r);
  }
  function finishParent(r){
    const child=records().find(c=>c.id===r.childId);
    if(child&&TERMINAL.has(child.state)){
      r.state=child.state==='SELL_DUST'?'SELL_DUST':child.state==='SELL_REMAINDER_PROTECTED'?'SELL_REMAINDER_PROTECTED':'SELL_COMPLETED';
      r.residualOutcome={recordId:child.id,state:child.state};save(r);
    }
  }
  async function recoverRecord(r,depth=0){
    if(depth>3)throw new Error('RESIDUAL_DEPTH_EXCEEDED');
    if(r.state==='SELL_RESIDUAL_PENDING'){
      const child=records().find(c=>c.id===r.childId);if(!child)throw new Error('RESIDUAL_RECORD_MISSING');
      if(PENDING.has(child.state))await recoverRecord(child,depth+1);finishParent(r);return;
    }
    const response=await signed('GET','/api/v3/order',{symbol:r.symbol,origClientOrderId:r.clientId});
    const order=await response.json();
    if(!response.ok)return; // Absence is never permission to resend an ambiguous order.
    apply(r,order);
    if(r.state!=='SELL_PARTIAL')return;
    const plan=await planResidual({record:r,get});
    r.remaining=plan.remaining;
    if(plan.kind==='DUST'){r.state='SELL_DUST';save(r);return;}
    if(plan.kind==='PROTECTED'){r.state='SELL_REMAINDER_PROTECTED';r.protectionOrderIds=plan.orderIds;save(r);return;}
    let child=records().find(c=>c.id===plan.id),created=false;
    if(!child){
      child={version:1,id:plan.id,file:path.join(dir,plan.id+'.json'),symbol:r.symbol,buyOrderId:r.buyOrderId,
        parentId:r.id,generation:Number(r.generation||0)+1,clientId:plan.clientId,quantity:String(plan.quantity),orderType:'MARKET',state:'SELL_INTENT'};
      save(child);created=true;
    }
    r.childId=child.id;r.state='SELL_RESIDUAL_PENDING';save(r);
    if(created){
      let submitted,body;try{
        submitted=await signed('POST','/api/v3/order',{symbol:r.symbol,side:'SELL',type:'MARKET',quantity:child.quantity,newClientOrderId:child.clientId,newOrderRespType:'FULL'});
        body=await submitted.json();
        if(submitted.ok)apply(child,body);else{child.state=submitted.status>=500||[-1006,-1007].includes(body?.code)?'SELL_UNKNOWN':'SELL_REVIEW';save(child);}
      }catch{child.state='SELL_UNKNOWN';save(child);}
    }
    if(PENDING.has(child.state))await recoverRecord(child,depth+1);
    finishParent(r);
  }
  async function recover(){
    for(const r of records().filter(r=>PENDING.has(r.state))){
      try{await recoverRecord(r);}catch{ /* Keep the durable interlock and never assume a fill. */ }
    }
    return {pending:records().filter(r=>PENDING.has(r.state)).length};
  }
  async function resumeConfirmedSell(order,transitionId){
    if(!transitionId||order.side!=='SELL'||order.type!=='MARKET'||!order.clientOrderId?.startsWith('proypers-gh-'))throw new Error('CONFIRMED_SELL_REQUIRED');
    const id=crypto.createHash('sha256').update(`${order.symbol}:${order.orderId}:reconciled-transition`).digest('hex').slice(0,32);
    let r=records().find(r=>r.id===id);
    if(!r){r={version:1,id,file:path.join(dir,id+'.json'),symbol:order.symbol,clientId:order.clientOrderId,quantity:order.origQty,orderType:'MARKET',transitionId,state:'SELL_INTENT'};save(r);apply(r,order);}
    if(PENDING.has(r.state))try{await recoverRecord(r);}catch{}
    const latest=records().find(r=>r.id===id);return {complete:TERMINAL.has(latest.state),state:latest.state,id};
  }
  async function fetch(input,init={}){
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    const method=String(init.method||input?.method||'GET').toUpperCase(),p=url.searchParams;
    if(!/^api[1-4]?\.binance\.com$/.test(url.hostname)||method==='GET')return transport(input,init);
    // A cancel-replace is not transactional. Preserve the old stop rather than cancel first.
    // Also reject bulk/OCO cancellation, amendments and BUYs inside the exit worker.
    if(url.pathname!=='/api/v3/order'||method!=='POST'||p.get('side')!=='SELL')throw new Error('EXIT_MUTATION_REFUSED_OLD_PROTECTION_RETAINED');
    const stop=['STOP_LOSS','STOP_LOSS_LIMIT'].includes(p.get('type'));
    if((!stop&&p.get('type')!=='MARKET')||p.has('quoteOrderQty')||!(Number(p.get('quantity'))>0)||!Number.isFinite(Number(p.get('quantity')))||
      stop&&!(Number(p.get('stopPrice'))>0))throw new Error('EXIT_ORDER_FORMAT_REFUSED');
    if(records().some(r=>PENDING.has(r.state)))throw new Error('SELL_RECOVERY_PENDING');
    const history=await signed('GET','/api/v3/allOrders',{symbol:p.get('symbol'),limit:'1000'});
    if(!history.ok)throw new Error('EXIT_POSITION_IDENTITY_REQUIRED');
    const orders=await history.json();if(!Array.isArray(orders))throw new Error('EXIT_POSITION_IDENTITY_REQUIRED');
    const buys=orders.filter(o=>o.symbol===p.get('symbol')&&o.side==='BUY'&&o.status==='FILLED'&&String(o.clientOrderId||'').startsWith('proypers-gh-'));
    buys.sort((a,b)=>Number(a.time)-Number(b.time));const buy=buys.at(-1);
    if(!buy?.orderId||!Number.isFinite(Number(buy.time)))throw new Error('EXIT_POSITION_IDENTITY_REQUIRED');
    if(orders.some(o=>o.side==='SELL'&&o.status==='FILLED'&&Number(o.time)>=Number(buy.time)))throw new Error('EXIT_AFTER_PRIOR_SELL_REQUIRES_REVIEW');
    if(!Number.isFinite(Number(buy.executedQty))||Number(buy.executedQty)<=0||!Number.isFinite(Number(p.get('quantity')))||Number(p.get('quantity'))>Number(buy.executedQty))throw new Error('EXIT_QUANTITY_EXCEEDS_MANAGED_BUY');
    const id=crypto.createHash('sha256').update(`${buy.symbol}:${buy.orderId}:${stop?`${p.get('type')}:${p.get('stopPrice')}:${p.get('quantity')}`:'MARKET_EXIT'}`).digest('hex').slice(0,32);
    const prior=records().find(r=>r.id===id);
    if(prior){
      if(['SELL_FILLED','STOP_ACTIVE'].includes(prior.state))return new Response(JSON.stringify(prior.order),{status:200});
      throw new Error('SELL_INTENT_ALREADY_EXISTS_REVIEW_REQUIRED');
    }
    const r={version:1,id,file:path.join(dir,id+'.json'),symbol:buy.symbol,buyOrderId:buy.orderId,
      clientId:stop?`proypers-gh-protect-${id.slice(0,16)}`:`proypers-gh-exit-${id.slice(0,19)}`,
      quantity:p.get('quantity'),orderType:p.get('type'),stopPrice:p.get('stopPrice'),state:stop?'STOP_INTENT':'SELL_INTENT'};
    save(r); // fsync before any order dispatch, survives process death.
    const params=Object.fromEntries(p);delete params.signature;delete params.timestamp;params.newClientOrderId=r.clientId;
    let response,body;
    try{response=await signed('POST','/api/v3/order',params);body=await response.clone().json();}
    catch{r.state=stop?'STOP_UNKNOWN':'SELL_UNKNOWN';save(r);throw new Error('SELL_RESULT_UNKNOWN');}
    if(response.ok){try{apply(r,body);}catch{r.state=stop?'STOP_UNKNOWN':'SELL_UNKNOWN';save(r);throw new Error('SELL_RESULT_UNKNOWN');}}
    else {
      if(response.status===403&&body?.msg==='VPS_STAGING_WRITE_BLOCKED'){
        r.state='STAGING_BLOCKED';r.transportOutcome='LOCAL_WRITE_DENIED_BEFORE_NETWORK';
      }else r.state=response.status>=500||[-1006,-1007].includes(body?.code)?(stop?'STOP_UNKNOWN':'SELL_UNKNOWN'):(stop?'STOP_REVIEW':'SELL_REVIEW');
      save(r);
    }
    return response;
  }
  return {fetch,recover,resumeConfirmedSell,records,pending:()=>records().filter(r=>PENDING.has(r.state)).length};
}
module.exports={createExitSafety};
