'use strict';
// Durable reconciliation around the original entry strategy. This does not enable trading.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {atomic}=require('./journal.cjs');
const {protectionFits,isDust,closureProof}=require('./entry-reconciliation.cjs');
const PENDING=new Set(['BUY_INTENT','BUY_UNKNOWN','BUY_PENDING','BUY_FILLED','PROTECTION_PENDING','STOP_INTENT','STOP_UNKNOWN']);
function floor(value,stepText){const step=Number(stepText);if(!(step>0))throw new Error('INVALID_FILTER');const decimals=(String(stepText).replace(/0+$/,'').split('.')[1]||'').length;return Number((Math.floor((value+Number.EPSILON)/step)*step).toFixed(decimals));}
function lock(dir){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'execution.lock'),boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  let fd;
  for(let attempt=0;attempt<2;attempt++){
    try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,boot}));fs.fsyncSync(fd);break;}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      let old;try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error('EXECUTION_LOCK_REVIEW_REQUIRED');}
      if(!Number.isSafeInteger(old.pid)||old.pid<2)throw new Error('EXECUTION_LOCK_REVIEW_REQUIRED');
      if(old.boot===boot){try{process.kill(old.pid,0);throw new Error('EXECUTION_ALREADY_RUNNING');}catch(err){if(err.code!=='ESRCH')throw err;}}
      fs.unlinkSync(file);
    }
  }
  if(fd===undefined)throw new Error('EXECUTION_LOCK_FAILED');
  let released=false;
  return ()=>{if(released)return;released=true;fs.closeSync(fd);fs.unlinkSync(file);};
}
function createSafety({transport,dir,key,secret,context,repo,now=Date.now}){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const files=()=>fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>path.join(dir,n));
  const records=()=>files().map(f=>({file:f,...JSON.parse(fs.readFileSync(f,'utf8'))}));
  function save(record){const {file,...data}=record;atomic(file,{...data,updatedAt:new Date(now()).toISOString()});}
  function contextId(c){return crypto.createHash('sha256').update(`${c.lane}:${c.symbol}:${c.createdAt}`).digest('hex').slice(0,32);}
  function current(){if(!context)return null;return records().find(r=>r.id===contextId(context));}
  async function signed(method,endpoint,params={}){
    const q=new URLSearchParams(params);q.set('recvWindow','5000');q.set('timestamp',String(now()));
    q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));
    return transport(`https://api.binance.com${endpoint}?${q}`,{method,headers:{'X-MBX-APIKEY':key}});
  }
  async function get(endpoint,params={},privateRequest=true){
    const r=privateRequest?await signed('GET',endpoint,params):await transport(`https://api.binance.com${endpoint}?${new URLSearchParams(params)}`,{method:'GET'});
    if(!r.ok)throw new Error(`RECONCILIATION_HTTP_${r.status}`);return r.json();
  }
  async function find(symbol,id){
    const r=await signed('GET','/api/v3/order',{symbol,origClientOrderId:id});const body=await r.json();
    if(r.ok)return body;
    if(body.code===-2013)return null;
    throw new Error('ORDER_RECONCILIATION_FAILED');
  }
  function applyBuy(record,order){
    if(order.symbol!==record.symbol||!order.orderId||order.clientOrderId!==record.buyId)throw new Error('BUY_IDENTITY_MISMATCH');
    record.buy=order;
    if(['FILLED','EXPIRED','CANCELED'].includes(order.status))record.state=Number(order.executedQty)>0?'BUY_FILLED':'NO_FILL';
    else record.state='BUY_PENDING';
    save(record);
  }
  function applyStop(record,order){
    if(order.symbol!==record.symbol||!order.orderId||order.clientOrderId!==record.stopId||!['STOP_LOSS','STOP_LOSS_LIMIT'].includes(order.type)||order.side!=='SELL'||!(Number(order.origQty)>0)||Number(order.origQty)<Number(record.stopQty||0))throw new Error('STOP_IDENTITY_MISMATCH');
    record.stop=order;
    record.state=order.status==='FILLED'?'CLOSED':['NEW','PARTIALLY_FILLED'].includes(order.status)?'PROTECTED':'PROTECTION_PENDING';
    save(record);
  }
  function uncertain(status,body){return status>=500||[-1006,-1007].includes(body?.code);}
  async function recover(){
    for(const record of records().filter(r=>PENDING.has(r.state))){
      try{
        if(['BUY_INTENT','BUY_UNKNOWN','BUY_PENDING'].includes(record.state)){
          const order=await find(record.symbol,record.buyId);
          // Absence after an ambiguous dispatch is not proof of non-acceptance: never retry a BUY.
          if(!order)continue;applyBuy(record,order);
        }
        if(!['BUY_FILLED','PROTECTION_PENDING','STOP_INTENT','STOP_UNKNOWN'].includes(record.state))continue;
        const prior=await find(record.symbol,record.stopId);
        if(prior){applyStop(record,prior);if(['PROTECTED','CLOSED'].includes(record.state))continue;}
        // A stop can be recovered with the SAME client ID after checking free balance.
        // An already accepted stop reserves that balance and duplicate active IDs are rejected.
        // BUYs, unlike protective stops, are never resubmitted after an unknown outcome.
        const [ei,account]=await Promise.all([get('/api/v3/exchangeInfo',{symbol:record.symbol,showPermissionSets:'false'},false),get('/api/v3/account',{omitZeroBalances:'true'})]);
        const info=ei.symbols?.[0];if(!info||info.symbol!==record.symbol||info.status!=='TRADING'||info.isSpotTradingAllowed!==true)continue;
        const lot=info.filters.find(f=>f.filterType==='LOT_SIZE'),price=info.filters.find(f=>f.filterType==='PRICE_FILTER');
        if(!lot||!price)continue;
        const row=account.balances.find(r=>r.asset===info.baseAsset)||{};
        const total=Number(row.free||0)+Number(row.locked||0),free=Number(row.free||0);
        const quantity=floor(Math.min(Number(record.buy.executedQty),free),lot.stepSize);
        if(!(total>0)){record.state='CLOSED';save(record);continue;}
        const ticker=await get('/api/v3/ticker/price',{symbol:record.symbol},false);
        const currentPrice=Number((Array.isArray(ticker)?ticker.find(t=>t.symbol===record.symbol):ticker)?.price);
        if(isDust(info,total,currentPrice)){
          const [openOrders,orders,trades]=await Promise.all([get('/api/v3/openOrders',{symbol:record.symbol}),get('/api/v3/allOrders',{symbol:record.symbol,limit:'1000'}),get('/api/v3/myTrades',{symbol:record.symbol,limit:'1000'})]);
          const proof=closureProof({record,info,total,price:currentPrice,openOrders,orders,trades});
          if(proof){record.state='CLOSED';record.closure=proof;save(record);console.log('ENTRY_CLOSED_CONFIRMED_EXIT_WITH_DUST symbol='+record.symbol);}
          continue;
        }
        if(quantity<Number(lot.minQty))continue;
        const entry=Number(record.buy.cummulativeQuoteQty)/Number(record.buy.executedQty);
        const stopPrice=floor(entry*(1-record.stopPct),price.tickSize);
        const orderType=info.orderTypes.includes('STOP_LOSS')?'STOP_LOSS':info.orderTypes.includes('STOP_LOSS_LIMIT')?'STOP_LOSS_LIMIT':null;
        if(!orderType)continue;
        const limit=orderType==='STOP_LOSS_LIMIT'?floor(stopPrice*.994,price.tickSize):stopPrice;
        const nf=info.filters.find(f=>f.filterType==='NOTIONAL')||info.filters.find(f=>f.filterType==='MIN_NOTIONAL');
        if(!(stopPrice>0)||quantity*limit<Number(nf?.minNotional||0))continue;
        const p={symbol:record.symbol,side:'SELL',type:orderType,quantity:String(quantity),stopPrice:String(stopPrice),newOrderRespType:'RESULT',newClientOrderId:record.stopId};
        if(orderType==='STOP_LOSS_LIMIT')Object.assign(p,{price:String(limit),timeInForce:'GTC'});
        record.stopQty=quantity;record.state='STOP_INTENT';save(record);
        let r;
        try{r=await signed('POST','/api/v3/order',p);}catch{record.state='STOP_UNKNOWN';save(record);continue;}
        const body=await r.json();
        if(r.ok)applyStop(record,body);else{record.state=uncertain(r.status,body)?'STOP_UNKNOWN':'PROTECTION_PENDING';save(record);}
      }catch{ /* Persisted pending state is itself the global new-buy interlock. */ }
    }
    return {pending:records().filter(r=>PENDING.has(r.state)).length};
  }
  async function fetch(input,init={}){
    const url=new URL(typeof input==='string'?input:input.url),method=String(init.method||'GET').toUpperCase();
    const p=url.searchParams;
    if(!/^api[1-4]?\.binance\.com$/.test(url.hostname)||url.pathname!=='/api/v3/order'||method!=='POST')return transport(input,init);
    const buy=p.get('side')==='BUY';
    const stop=p.get('side')==='SELL'&&['STOP_LOSS','STOP_LOSS_LIMIT'].includes(p.get('type'));
    if(!buy&&!stop)return transport(input,init);
    let record=current();
    if(buy){
      if(!context||context.symbol!==p.get('symbol')||!['CORE','V10_HUNTER'].includes(context.lane))throw new Error('BUY_CONTEXT_REQUIRED');
      if(record||records().some(r=>PENDING.has(r.state)))throw new Error('BUY_REPLAY_OR_PENDING_RECOVERY_BLOCKED');
      if(p.get('type')!=='MARKET'||!(Number(p.get('quoteOrderQty'))>0&&Number(p.get('quoteOrderQty'))<=70))throw new Error('BUY_LIMIT_REFUSED');
      const id=contextId(context);
      const {classifySpotAsset}=require(path.join(repo,'backend/services/spotAssetClassification'));
      const lanePct=context.lane==='V10_HUNTER'?.012:.05;
      record={id,file:path.join(dir,id+'.json'),symbol:context.symbol,lane:context.lane,createdAt:context.createdAt,
        buyId:`proypers-gh-${context.lane==='V10_HUNTER'?'v10-':''}${id.slice(0,18)}`,
        stopId:`proypers-gh-protect-${id.slice(0,16)}`,stopPct:classifySpotAsset(context.symbol).is_leveraged?Math.min(lanePct,.03):lanePct,state:'BUY_INTENT'};
      const [ei,ticker]=await Promise.all([get('/api/v3/exchangeInfo',{symbol:record.symbol,showPermissionSets:'false'},false),get('/api/v3/ticker/price',{symbol:record.symbol},false)]);
      const info=ei.symbols?.find(s=>s.symbol===record.symbol),price=Number((Array.isArray(ticker)?ticker.find(t=>t.symbol===record.symbol):ticker)?.price);
      if(!protectionFits({info,price,quote:Number(p.get('quoteOrderQty')),stopPct:record.stopPct})){
        record.state='REJECTED';record.reason='PRE_BUY_NATIVE_PROTECTION_MINIMUM';save(record);
        return Response.json({code:-1013,msg:'PRE_BUY_NATIVE_PROTECTION_MINIMUM'},{status:400});
      }
      save(record);
    }else{
      if(!record?.buy||!['BUY_FILLED','PROTECTION_PENDING','STOP_INTENT','STOP_UNKNOWN','PROTECTED'].includes(record.state))throw new Error('NATIVE_STOP_WITHOUT_RECONCILED_BUY');
      if(['STOP_INTENT','STOP_UNKNOWN','PROTECTED'].includes(record.state)){
        const existing=await find(record.symbol,record.stopId);
        if(existing){applyStop(record,existing);if(['PROTECTED','CLOSED'].includes(record.state))return new Response(JSON.stringify(existing),{status:200});}
        if(['STOP_INTENT','STOP_UNKNOWN'].includes(record.state))throw new Error('STOP_RECONCILIATION_PENDING');
      }
      record.stopQty=Number(p.get('quantity'));record.state='STOP_INTENT';save(record);
    }
    const params=Object.fromEntries(p);delete params.signature;delete params.timestamp;
    params.newClientOrderId=buy?record.buyId:record.stopId;
    let r;
    try{r=await signed('POST','/api/v3/order',params);}catch(e){record.state=buy?'BUY_UNKNOWN':'STOP_UNKNOWN';save(record);throw new Error('ORDER_RESULT_UNKNOWN_RECONCILIATION_REQUIRED');}
    let body;try{body=await r.clone().json();}catch{record.state=buy?'BUY_UNKNOWN':'STOP_UNKNOWN';save(record);throw new Error('ORDER_RESULT_UNKNOWN_RECONCILIATION_REQUIRED');}
    if(r.ok){if(buy)applyBuy(record,body);else applyStop(record,body);}
    else{record.state=uncertain(r.status,body)?(buy?'BUY_UNKNOWN':'STOP_UNKNOWN'):(buy?'REJECTED':'PROTECTION_PENDING');save(record);}
    return r;
  }
  return {fetch,recover,current,records,pending:()=>records().filter(r=>PENDING.has(r.state)).length};
}
module.exports={createSafety,lock,PENDING};
