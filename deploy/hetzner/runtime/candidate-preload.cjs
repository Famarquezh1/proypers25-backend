'use strict';
// Dormant candidate transport. Installation never selects or authorizes this transport.
const https=require('node:https'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {makeFetch}=require('./readonly.cjs');
const {authorization,assertExecutionLock}=require('./candidate-gate.cjs');
const {localContext}=require('./local-context.cjs');
function candidateFetch({read=makeFetch(),request=https.request,authorize=authorization,lock=assertExecutionLock,
  role=path.basename(process.argv[1]||''),lane=process.env.SIGNAL_LANE,key=process.env.BINANCE_API_KEY,secret=process.env.BINANCE_SECRET_KEY}={}){
  return async(input,init={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    const method=String(init.method||input?.method||'GET').toUpperCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port)throw new Error('CANDIDATE_TARGET_REFUSED');
    if(url.hostname==='api.github.com')return localContext(url,{...init,method});
    if(method==='GET')return read(input,init);
    authorize();lock();
    if(!['entry-safe.cjs','exit-worker.cjs'].includes(role)||!/^api[1-4]?\.binance\.com$/.test(url.hostname)||method!=='POST'||init.body||input instanceof Request&&input.body)throw new Error('CANDIDATE_WRITE_REFUSED');
    const p=url.searchParams,side=p.get('side'),type=p.get('type');
    const normal=url.pathname==='/api/v3/order',replacement=url.pathname==='/api/v3/order/cancelReplace';
    if(!normal&&!replacement)throw new Error('CANDIDATE_ENDPOINT_REFUSED');
    if(!/^[A-Z0-9]+USDT$/.test(p.get('symbol')||'')||!/^(proypers-gh-)[a-zA-Z0-9-]{1,24}$/.test(p.get('newClientOrderId')||'')||(p.get('newClientOrderId')||'').length>36)throw new Error('CANDIDATE_ORDER_IDENTITY_REFUSED');
    if(side==='BUY'){
      if(role!=='entry-safe.cjs'||lane!=='CORE'||!normal||type!=='MARKET'||p.has('quantity')||!(Number(p.get('quoteOrderQty'))>=5&&Number(p.get('quoteOrderQty'))<=70))throw new Error('CANDIDATE_BUY_REFUSED');
    }else if(side==='SELL'){
      if(!['MARKET','STOP_LOSS','STOP_LOSS_LIMIT'].includes(type)||!Number.isFinite(Number(p.get('quantity')))||!(Number(p.get('quantity'))>0))throw new Error('CANDIDATE_SELL_REFUSED');
      if(type!=='MARKET'&&!(Number(p.get('stopPrice'))>0))throw new Error('CANDIDATE_STOP_REFUSED');
      if(type==='STOP_LOSS_LIMIT'&&(!(Number(p.get('price'))>0)||p.get('timeInForce')!=='GTC'))throw new Error('CANDIDATE_STOP_REFUSED');
      if(replacement&&(p.get('cancelReplaceMode')!=='STOP_ON_FAILURE'||p.get('cancelRestrictions')!=='ONLY_NEW'||p.get('orderRateLimitExceededMode')!=='DO_NOTHING'||!p.get('cancelOrderId')))throw new Error('CANDIDATE_REPLACEMENT_REFUSED');
    }else throw new Error('CANDIDATE_SIDE_REFUSED');
    const headers=new Headers(init.headers||{});
    if(!key||!secret||headers.get('X-MBX-APIKEY')!==key)throw new Error('CANDIDATE_CREDENTIAL_IDENTITY_REFUSED');
    const signature=p.get('signature');p.delete('signature');
    const expected=crypto.createHmac('sha256',secret).update(p.toString()).digest('hex');
    if(!signature||signature.length!==64||!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new Error('CANDIDATE_SIGNATURE_REFUSED');
    p.set('signature',signature);
    return new Promise((resolve,reject)=>{
      const req=request(url,{method:'POST',family:4,headers:Object.fromEntries(headers),signal:init.signal||AbortSignal.timeout(15000)},response=>{
        const chunks=[];let size=0;
        response.on('data',b=>{size+=b.length;if(size>1048576)response.destroy(new Error('CANDIDATE_RESPONSE_LIMIT'));else chunks.push(b);});
        response.on('error',reject);response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:{'content-type':'application/json'}})));
      });req.on('error',reject);req.end();
    });
  };
}
if(process.env.PROYPERS_CANDIDATE_PRELOAD==='1'){
  const role=path.basename(process.argv[1]||'');
  if(role!=='github-spot-production-radar-v42-active.js')authorization();
  if(['entry-safe.cjs','exit-worker.cjs'].includes(role)){
    const dir=process.env.CREDENTIALS_DIRECTORY;
    process.env.BINANCE_API_KEY=fs.readFileSync(path.join(dir,'binance-key'),'utf8').trim();
    process.env.BINANCE_SECRET_KEY=fs.readFileSync(path.join(dir,'binance-secret'),'utf8').trim();
  }
  global.fetch=role==='github-spot-production-radar-v42-active.js'?makeFetch():candidateFetch();
}
module.exports={candidateFetch};
