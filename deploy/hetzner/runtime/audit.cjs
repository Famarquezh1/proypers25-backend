'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {makeFetch}=require('./readonly.cjs');
const transport=makeFetch();
function coverage(account, orders, info, prices) {
  const result=[];
  for(const balance of account.balances||[]) {
    const quantity=Number(balance.free)+Number(balance.locked);
    if(!Number.isFinite(quantity)||Number(balance.free)<0||Number(balance.locked)<0)throw new Error('INVALID_BALANCE');
    if(!(quantity>0)||balance.asset==='USDT')continue;
    const symbol=info.find(s=>s.baseAsset===balance.asset&&s.quoteAsset==='USDT'&&s.status==='TRADING'&&s.isSpotTradingAllowed===true);
    if(!symbol){result.push({asset:balance.asset,status:'UNVALUED_REQUIRES_REVIEW'});continue;}
    const price=Number(prices.find(p=>p.symbol===symbol.symbol)?.price);
    const lot=symbol.filters.find(f=>f.filterType==='LOT_SIZE');
    const minimum=symbol.filters.find(f=>f.filterType==='NOTIONAL')||symbol.filters.find(f=>f.filterType==='MIN_NOTIONAL');
    const step=Number(lot?.stepSize);
    if(!(price>0&&step>0&&Number.isFinite(Number(minimum?.minNotional)))){result.push({symbol:symbol.symbol,status:'FILTER_REVIEW_REQUIRED'});continue;}
    const tradable=Math.floor((quantity+Number.EPSILON)/step)*step;
    const dust=tradable<Number(lot.minQty)||tradable*price<Number(minimum.minNotional);
    const stops=orders.filter(o=>o.symbol===symbol.symbol&&o.side==='SELL'&&
      ['NEW','PARTIALLY_FILLED'].includes(o.status)&&['STOP_LOSS','STOP_LOSS_LIMIT'].includes(o.type)&&Number(o.stopPrice)>0);
    const protectedQuantity=stops.reduce((n,o)=>n+Math.max(0,Number(o.origQty)-Number(o.executedQty)),0);
    result.push({symbol:symbol.symbol,quantity,tradable,protectedQuantity,
      status:dust?'DUST':protectedQuantity+step*0.01>=tradable?'NATIVE_STOP_PRESENT':'UNPROTECTED_OR_PARTIAL',
      // Presence does not guarantee execution through gaps or establish stop adequacy.
      stopAdequacy:'OWNER_STRATEGY_RECONCILIATION_REQUIRED'});
  }
  return result;
}
async function audit() {
  const dir=process.env.CREDENTIALS_DIRECTORY;
  if(!dir)throw new Error('CREDENTIALS_REQUIRED');
  const key=fs.readFileSync(path.join(dir,'binance-key'),'utf8').trim();
  const secret=fs.readFileSync(path.join(dir,'binance-secret'),'utf8').trim();
  async function get(endpoint,params={},signed=false) {
    const query=new URLSearchParams(params);
    if(signed){query.set('recvWindow','5000');query.set('timestamp',String(Date.now()));query.set('signature',crypto.createHmac('sha256',secret).update(query.toString()).digest('hex'));}
    const r=await transport(`https://api.binance.com${endpoint}?${query}`,{method:'GET',headers:signed?{'X-MBX-APIKEY':key}:{}});
    if(!r.ok)throw new Error(`AUDIT_HTTP_${r.status}`);
    return r.json();
  }
  const clock=await get('/api/v3/time');
  if(Math.abs(Date.now()-Number(clock.serverTime))>3000)throw new Error('CLOCK_SKEW');
  const [account,permissions,orders,market,prices]=await Promise.all([
    get('/api/v3/account',{omitZeroBalances:'true'},true),get('/sapi/v1/account/apiRestrictions',{},true),
    get('/api/v3/openOrders',{},true),get('/api/v3/exchangeInfo'),get('/api/v3/ticker/price')]);
  if(permissions.enableWithdrawals!==false||permissions.ipRestrict!==true)throw new Error('CREDENTIAL_SECURITY_REQUIREMENT');
  if(!Array.isArray(orders)||!Array.isArray(account.balances)||!Array.isArray(market.symbols)||!Array.isArray(prices))throw new Error('INVALID_AUDIT_RESPONSE');
  const positions=coverage(account,orders,market.symbols,prices);
  const review=positions.filter(p=>!['DUST','NATIVE_STOP_PRESENT'].includes(p.status));
  return {at:new Date().toISOString(),mode:'STAGING_READ_ONLY',tradingActivated:false,
    security:{withdrawalsDisabled:true,ipRestricted:true,reading:permissions.enableReading===true,
      spotPermission:permissions.enableSpotAndMarginTrading===true,futuresPermission:permissions.enableFutures===true,
      transferPermission:permissions.permitsUniversalTransfer===true},
    positions,openOrderCount:orders.length,reviewRequired:review.length,
    liveReady:false,protectionReconciled:false};
}
module.exports={audit,coverage};
