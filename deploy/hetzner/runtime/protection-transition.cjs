'use strict';
// Durable cancel/replace reconciliation. Caller holds the global execution lock.
// Binance does not guarantee atomic replacement; uncertain results never authorize a second SELL.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {atomic}=require('./journal.cjs');
const TERMINAL=new Set(['REPLACED','RESTORED','OLD_RETAINED','CLOSED','STAGING_BLOCKED']);
function createTransitions({transport,dir,key,secret,resumeSell,now=Date.now}) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  function records(){return fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>{
    const file=path.join(dir,n),r=JSON.parse(fs.readFileSync(file,'utf8'));
    if(r.version!==1||!r.id||!r.symbol||!r.old?.orderId||!r.nextId||!r.restoreId||!r.state)throw new Error('TRANSITION_STATE_INVALID');
    return {...r,file};
  });}
  function save(r){const {file,...data}=r;atomic(file,{...data,updatedAt:new Date(now()).toISOString()});}
  async function signed(method,endpoint,params){
    const q=new URLSearchParams(params);q.set('recvWindow','5000');q.set('timestamp',String(now()));
    q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));
    return transport(`https://api.binance.com${endpoint}?${q}`,{method,headers:{'X-MBX-APIKEY':key}});
  }
  async function find(symbol,selector){
    const response=await signed('GET','/api/v3/order',{symbol,...selector}),body=await response.json();
    if(response.ok)return body;if(body.code===-2013)return null;throw new Error('TRANSITION_QUERY_FAILED');
  }
  function valid(order,r,id){
    return order?.symbol===r.symbol&&String(order.clientOrderId)===id&&order.side==='SELL'&&
      order.type===(id===r.restoreId?r.old.type:r.params.type)&&Number(order.origQty)===Number(r.old.origQty)&&order.orderId;
  }
  async function reconcile(r){
    const [old,next,restore]=await Promise.all([find(r.symbol,{orderId:String(r.old.orderId)}),
      find(r.symbol,{origClientOrderId:r.nextId}),find(r.symbol,{origClientOrderId:r.restoreId})]);
    if(!old||old.symbol!==r.symbol||old.orderId!==r.old.orderId)throw new Error('OLD_STOP_IDENTITY_INVALID');
    for(const [order,id] of [[next,r.nextId],[restore,r.restoreId]])if(order&&!valid(order,r,id))throw new Error('NEW_STOP_IDENTITY_INVALID');
    if(old.status==='FILLED'&&!next&&!restore){r.state='CLOSED';save(r);return;}
    if(old.status==='CANCELED'&&r.kind==='EXIT'&&next&&!restore&&['CANCELED','EXPIRED','EXPIRED_IN_MATCH'].includes(next.status)&&resumeSell){
      const residual=await resumeSell(next,r.id);r.residual=residual;
      r.state=residual.complete?'CLOSED':'UNKNOWN';save(r);return;
    }
    if(old.status==='CANCELED'&&next&&!restore&&['NEW','PARTIALLY_FILLED','FILLED'].includes(next.status)){
      if(r.kind!=='EXIT'&&Number(next.stopPrice)!==Number(r.params.stopPrice))throw new Error('NEW_STOP_PRICE_INVALID');
      if(r.kind==='EXIT'&&next.status!=='FILLED'){r.state='UNKNOWN';save(r);return;}
      r.state=next.status==='FILLED'?'CLOSED':'REPLACED';r.confirmed=next;save(r);return;
    }
    if(old.status==='CANCELED'&&restore&&!next&&['NEW','PARTIALLY_FILLED','FILLED'].includes(restore.status)){
      if(Number(restore.stopPrice)!==Number(r.old.stopPrice))throw new Error('RESTORE_STOP_PRICE_INVALID');
      r.state=restore.status==='FILLED'?'CLOSED':'RESTORED';r.confirmed=restore;save(r);return;
    }
    if(['NEW','PARTIALLY_FILLED'].includes(old.status)&&!next&&!restore&&r.definitiveNoChange){r.state='OLD_RETAINED';save(r);return;}
    // Only a definitive new-order rejection permits restoration, never an ambiguous -2013 observation.
    if(old.status==='CANCELED'&&!next&&!restore&&r.definitiveNewFailed&&r.state!=='RESTORE_INTENT'&&r.state!=='RESTORE_UNKNOWN'){
      r.state='RESTORE_INTENT';save(r);
      const p={symbol:r.symbol,side:'SELL',type:r.old.type,quantity:r.old.origQty,stopPrice:r.old.stopPrice,
        newClientOrderId:r.restoreId,newOrderRespType:'RESULT'};
      if(r.old.type==='STOP_LOSS_LIMIT')Object.assign(p,{price:r.old.price,timeInForce:r.old.timeInForce||'GTC'});
      let response,body;try{response=await signed('POST','/api/v3/order',p);body=await response.json();}
      catch{r.state='RESTORE_UNKNOWN';save(r);return;}
      if(response.ok&&valid(body,r,r.restoreId)&&Number(body.stopPrice)===Number(r.old.stopPrice)&&['NEW','FILLED'].includes(body.status)){
        r.state=body.status==='FILLED'?'CLOSED':'RESTORED';r.confirmed=body;
      }else r.state='RESTORE_UNKNOWN';
      save(r);return;
    }
    // Includes races, partial fills, missing orders and inconsistent responses. New buys remain blocked.
    if(!['RESTORE_INTENT','RESTORE_UNKNOWN'].includes(r.state))r.state='UNKNOWN';save(r);
  }
  async function recover(){
    for(const r of records().filter(r=>!TERMINAL.has(r.state)))try{await reconcile(r);}catch{/* preserve interlock */}
    return {pending:records().filter(r=>!TERMINAL.has(r.state)).length};
  }
  async function replace({symbol,oldOrder,stopPrice,info,kind='STOP',managedQty}){
    if(!['STOP','EXIT'].includes(kind))throw new Error('TRANSITION_KIND_INVALID');
    if(records().some(r=>!TERMINAL.has(r.state)))throw new Error('TRANSITION_RECOVERY_PENDING');
    const old=await find(symbol,{orderId:String(oldOrder?.orderId)});
    if(!old||old.symbol!==symbol||old.side!=='SELL'||!['NEW','PARTIALLY_FILLED'].includes(old.status)||
      !['STOP_LOSS','STOP_LOSS_LIMIT'].includes(old.type)||!/^(proypers-gh-protect-|proypers-gh-orphan-)/.test(old.clientOrderId||'')||
      Number(old.orderListId??-1)!==-1)throw new Error('OLD_PROTECTION_REVIEW_REQUIRED');
    // A partially filled native order already owns/protects its remainder. Do not race it with a stale replacement quantity.
    if(old.status==='PARTIALLY_FILLED')return {state:'OLD_RETAINED',confirmed:old,reason:'PARTIAL_NATIVE_REMAINDER_RETAINED'};
    if(Number(old.executedQty)!==0)throw new Error('OLD_PROTECTION_QUANTITY_INVALID');
    const lot=info?.filters?.find(f=>f.filterType==='LOT_SIZE'),pf=info?.filters?.find(f=>f.filterType==='PRICE_FILTER');
    const nf=info?.filters?.find(f=>f.filterType==='NOTIONAL')||info?.filters?.find(f=>f.filterType==='MIN_NOTIONAL');
    const quantity=Number(old.origQty),tick=Number(pf?.tickSize),step=Number(lot?.stepSize);
    if(info?.symbol!==symbol||info.status!=='TRADING'||info.isSpotTradingAllowed!==true||!(quantity>0&&tick>0&&step>0)||
      !(Number.isFinite(Number(nf?.minNotional)))||quantity<Number(lot.minQty)||quantity>Number(lot.maxQty)||
      !(Number.isFinite(Number(lot.maxQty))&&Number(lot.maxQty)>0)||
      (kind==='STOP'&&!(Number.isFinite(stopPrice)&&stopPrice>Number(old.stopPrice)&&stopPrice>=Number(pf.minPrice)&&stopPrice<=Number(pf.maxPrice)))||
      (kind==='EXIT'&&!(Number.isFinite(managedQty)&&quantity<=managedQty)))
      throw new Error('REPLACEMENT_FILTERS_REFUSED_OLD_RETAINED');
    const aligned=(n,s)=>Math.abs(n/s-Math.round(n/s))<1e-6;
    if((kind==='STOP'&&!aligned(stopPrice,tick))||!aligned(quantity,step))throw new Error('REPLACEMENT_PRECISION_REFUSED');
    const limit=old.type==='STOP_LOSS_LIMIT'?Number((Math.floor(stopPrice*.994/tick)*tick).toPrecision(14)):stopPrice;
    if(kind==='STOP'&&(quantity*limit<Number(nf.minNotional)||nf.maxNotional&&quantity*limit>Number(nf.maxNotional)))throw new Error('REPLACEMENT_NOTIONAL_REFUSED_OLD_RETAINED');
    const ticker=await transport(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,{method:'GET'});
    if(!ticker.ok)throw new Error('TRANSITION_MARKET_DATA_FAILED');const market=Number((await ticker.json()).price);
    if(!(market>0)||(kind==='STOP'&&!(market>stopPrice)))throw new Error('REPLACEMENT_TRIGGER_ALREADY_CROSSED');
    if(kind==='EXIT'&&(quantity*market<Number(nf.minNotional)||nf.maxNotional&&quantity*market>Number(nf.maxNotional)))throw new Error('EXIT_NOTIONAL_REFUSED_OLD_RETAINED');
    const id=crypto.createHash('sha256').update(`${symbol}:${old.orderId}:${kind}:${kind==='EXIT'?'market':stopPrice}`).digest('hex').slice(0,32);
    const prior=records().find(r=>r.id===id);if(prior)return prior;
    const orphan=String(old.clientOrderId).startsWith('proypers-gh-orphan-');
    const prefix=orphan?'proypers-gh-orphan-':'proypers-gh-protect-';
    const r={version:1,id,file:path.join(dir,id+'.json'),symbol,old,kind,
      nextId:kind==='EXIT'?(orphan?`proypers-gh-orphan-exit-${id.slice(0,12)}`:`proypers-gh-exit-${id.slice(0,19)}`):`${prefix}${id.slice(0,16)}`,
      restoreId:`${prefix}r${id.slice(0,15)}`,state:'INTENT'};
    r.params={symbol,side:'SELL',type:old.type,quantity:old.origQty,stopPrice:String(stopPrice),
      cancelOrderId:String(old.orderId),cancelReplaceMode:'STOP_ON_FAILURE',cancelRestrictions:'ONLY_NEW',
      orderRateLimitExceededMode:'DO_NOTHING',newClientOrderId:r.nextId,newOrderRespType:'RESULT'};
    if(old.type==='STOP_LOSS_LIMIT')Object.assign(r.params,{price:String(limit),timeInForce:'GTC'});
    if(kind==='EXIT'){r.params.type='MARKET';delete r.params.stopPrice;delete r.params.price;delete r.params.timeInForce;}
    save(r);
    try{
      const response=await signed('POST','/api/v3/order/cancelReplace',r.params),body=await response.json();
      if(response.status===403&&body.msg==='VPS_STAGING_WRITE_BLOCKED'){r.state='STAGING_BLOCKED';save(r);return r;}
      const outcome=body.data||body;
      r.definitiveNoChange=outcome.cancelResult==='FAILURE'&&outcome.newOrderResult==='NOT_ATTEMPTED';
      r.definitiveNewFailed=outcome.cancelResult==='SUCCESS'&&outcome.newOrderResult==='FAILURE';
      r.state='UNKNOWN';save(r);await reconcile(r);
    }catch{if(!TERMINAL.has(r.state)){r.state='UNKNOWN';save(r);}}
    if(!TERMINAL.has(r.state))throw new Error('TRANSITION_RECOVERY_REQUIRED');
    return r;
  }
  async function exit(params){const result=await replace({...params,kind:'EXIT'});if(result.state!=='CLOSED')throw new Error('EXIT_NOT_CONFIRMED_OLD_PROTECTION_RECONCILED');return result;}
  async function tighten(params){const result=await replace(params);if(result.state!=='REPLACED')throw new Error('TIGHTEN_NOT_CONFIRMED_PROTECTION_RECONCILED');return result;}
  return {replace,tighten,exit,recover,records,pending:()=>records().filter(r=>!TERMINAL.has(r.state)).length};
}
module.exports={createTransitions};
