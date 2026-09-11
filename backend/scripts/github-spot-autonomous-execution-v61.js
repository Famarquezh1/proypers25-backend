'use strict';

const crypto = require('crypto');
const fs = require('fs');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
let SYMBOL = String(process.env.SIGNAL_SYMBOL || '').toUpperCase();
let SIGNAL_PRICE = Number(process.env.SIGNAL_PRICE || 0);
let SIGNAL_PCT = Number(process.env.SIGNAL_PCT || 0);
let SIGNAL_CREATED_AT = process.env.SIGNAL_CREATED_AT || '';
const SIGNAL_V61_SCORE = Number(process.env.SIGNAL_V61_SCORE || NaN);

const MIN_USDT = 10;
const MAX_USDT = 100;
const BASE_POSITION_FRACTION = 0.15;
const MIN_POSITION_FRACTION = 0.08;
const MAX_POSITION_FRACTION = 0.20;
const V61_SIZE_SLOPE = 0.10;
const V61_SCORE_ANCHOR = 0.4487136592494857;
const MAX_SIGNAL_AGE_MS = 30 * 60 * 1000;
const MAX_PRICE_ADVANCE_FROM_SIGNAL = 0.03;
const HARD_STOP_PCT = 0.05;
const STOP_LIMIT_GAP_PCT = 0.006;
const BASES = ['https://api.binance.com','https://api1.binance.com','https://api2.binance.com','https://api3.binance.com','https://api4.binance.com'];

function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
function v61PositionFraction(){
  if(!Number.isFinite(SIGNAL_V61_SCORE)) return BASE_POSITION_FRACTION;
  const quality=clamp(SIGNAL_V61_SCORE - V61_SCORE_ANCHOR + 0.5,0,1);
  return clamp(BASE_POSITION_FRACTION + (quality - 0.5) * V61_SIZE_SLOPE,MIN_POSITION_FRACTION,MAX_POSITION_FRACTION);
}
function writeOutput(name,value){const file=process.env.GITHUB_OUTPUT;if(file)fs.appendFileSync(file,`${name}=${String(value).replace(/[\r\n]+/g,' ')}\n`);}
function finish(outcome,reason='',orderId=''){writeOutput('outcome',outcome);writeOutput('reason',reason);writeOutput('order_id',orderId);writeOutput('symbol',SYMBOL);}
function technicalFail(message){finish('technical_failure',message);console.error(`TECHNICAL_FAILURE: ${message}`);process.exit(2);}
function decline(reason){finish('declined',reason);console.log(`SIGNAL_DECLINED symbol=${SYMBOL||'unknown'} reason=${reason}`);process.exit(0);}
function validateInputs(){
  if(!API_KEY||!API_SECRET) technicalFail('BINANCE_API_KEY/BINANCE_SECRET_KEY missing in GitHub Actions Secrets');
  if(!/^[A-Z0-9]{2,20}USDT$/.test(SYMBOL)) technicalFail('Invalid or missing signal symbol');
  if(!(SIGNAL_PRICE>0)) technicalFail('Invalid signal price');
  if(!(SIGNAL_PCT>=1&&SIGNAL_PCT<18)) decline('Signal is outside Early Momentum band');
  const created=Date.parse(SIGNAL_CREATED_AT); if(!Number.isFinite(created)) technicalFail('Signal timestamp missing or invalid');
  if(Date.now()-created>MAX_SIGNAL_AGE_MS) decline('Signal is stale (>30 minutes)');
}
async function request(base,path,options={}){const response=await fetch(`${base}${path}`,options);const text=await response.text();let body;try{body=text?JSON.parse(text):{};}catch{body={raw:text};}if(!response.ok){const error=new Error(`HTTP ${response.status}: ${body.msg||body.raw||response.statusText}`);error.status=response.status;error.body=body;throw error;}return body;}
async function signed(base,method,path,params={}){const query=new URLSearchParams({...params,recvWindow:'5000',timestamp:String(Date.now())}).toString();const signature=crypto.createHmac('sha256',API_SECRET).update(query).digest('hex');return request(base,`${path}?${query}&signature=${signature}`,{method,headers:{'X-MBX-APIKEY':API_KEY}});}
async function chooseBase(){const failures=[];for(const base of BASES){try{await request(base,'/api/v3/ping');await signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'});return base;}catch(error){failures.push(`${base}=${error.status||error.message}`);}}technicalFail(`Binance private API unreachable from local runner (${failures.join(', ')})`);}
function balanceRow(account,asset){return (account.balances||[]).find(x=>x.asset===asset)||{};}
function freeBalance(account,asset){return Number(balanceRow(account,asset).free||0);}
function totalBalance(account,asset){const row=balanceRow(account,asset);return Number(row.free||0)+Number(row.locked||0);}
function decimalPlaces(step){const text=String(step);return text.includes('.')?(text.replace(/0+$/,'').split('.')[1]||'').length:0;}
function floorToStep(value,stepSize){const step=Number(stepSize);if(!(step>0))return Number(value);return Number((Math.floor((Number(value)+Number.EPSILON)/step)*step).toFixed(decimalPlaces(stepSize)));}
async function placeNativeProtection(base,order,entryPrice){
  const exchangeInfo=await request(base,`/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`);const info=exchangeInfo.symbols?.[0];
  if(!info||info.status!=='TRADING'||info.isSpotTradingAllowed!==true)throw new Error(`${SYMBOL} is not active Spot`);
  const account=await signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'});const lot=info.filters?.find(f=>f.filterType==='LOT_SIZE');const priceFilter=info.filters?.find(f=>f.filterType==='PRICE_FILTER');if(!lot||!priceFilter)throw new Error(`filters missing for ${SYMBOL}`);
  const executedQty=Number(order.executedQty||0),free=freeBalance(account,info.baseAsset),quantity=floorToStep(Math.min(executedQty,free),lot.stepSize);if(!(quantity>=Number(lot.minQty||0)))throw new Error(`protection quantity below minimum for ${SYMBOL}`);
  const stopPrice=floorToStep(entryPrice*(1-HARD_STOP_PCT),priceFilter.tickSize);if(!(stopPrice>0))throw new Error(`stop price invalid for ${SYMBOL}`);const clientId=`proypers-gh-protect-${Date.now()}`;let protectionOrder;
  if((info.orderTypes||[]).includes('STOP_LOSS')) protectionOrder=await signed(base,'POST','/api/v3/order',{symbol:SYMBOL,side:'SELL',type:'STOP_LOSS',quantity:String(quantity),stopPrice:String(stopPrice),newOrderRespType:'RESULT',newClientOrderId:clientId});
  else if((info.orderTypes||[]).includes('STOP_LOSS_LIMIT')){const limitPrice=floorToStep(stopPrice*(1-STOP_LIMIT_GAP_PCT),priceFilter.tickSize);protectionOrder=await signed(base,'POST','/api/v3/order',{symbol:SYMBOL,side:'SELL',type:'STOP_LOSS_LIMIT',timeInForce:'GTC',quantity:String(quantity),stopPrice:String(stopPrice),price:String(limitPrice),newOrderRespType:'RESULT',newClientOrderId:clientId});}
  else throw new Error(`${SYMBOL} does not support STOP_LOSS orders`);
  if(!protectionOrder?.orderId)throw new Error(`native protection returned no orderId for ${SYMBOL}`);console.log(`NATIVE_STOP_ARMED symbol=${SYMBOL} orderId=${protectionOrder.orderId} stop=${stopPrice} quantity=${quantity}`);
}
async function main(){
  validateInputs();const base=await chooseBase();
  const [ticker,account,restrictions,exchangeInfo]=await Promise.all([
    request(base,`/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),
    signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'}),
    signed(base,'GET','/sapi/v1/account/apiRestrictions'),
    request(base,`/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`)
  ]);
  if(account.canTrade!==true)technicalFail('Binance account cannot trade');
  if(restrictions.enableWithdrawals!==false)technicalFail('API withdrawals are not locked; execution refused');
  const info=exchangeInfo.symbols?.[0];
  if(!info||info.status!=='TRADING'||info.isSpotTradingAllowed!==true)decline(`${SYMBOL} is not active Spot TRADING`);
  const currentPct=Number(ticker.priceChangePercent||0),currentPrice=Number(ticker.lastPrice||0),quoteVolume=Number(ticker.quoteVolume||0);
  if(!(currentPct>=1&&currentPct<18))decline(`Opportunity no longer in Early Momentum band (${currentPct}%)`);
  if(!(quoteVolume>=200000))decline(`Liquidity dropped below minimum (${quoteVolume} USDT)`);
  if(!(currentPrice>0))technicalFail('Current price unavailable');
  const advance=(currentPrice-SIGNAL_PRICE)/SIGNAL_PRICE;if(advance>MAX_PRICE_ADVANCE_FROM_SIGNAL)decline(`Price advanced ${(advance*100).toFixed(2)}% after alert; anti-chase blocked`);
  const usdtFree=freeBalance(account,'USDT');const fraction=v61PositionFraction();const quoteOrderQty=Math.min(MAX_USDT,Math.floor(usdtFree*fraction*100)/100);
  if(quoteOrderQty<MIN_USDT)decline(`Insufficient free USDT for minimum acquisition (${usdtFree} USDT free)`);
  const baseAsset=info.baseAsset;const existingAssetQty=totalBalance(account,baseAsset);if(existingAssetQty>0&&existingAssetQty*currentPrice>=MIN_USDT)decline(`${baseAsset} already has >= ${MIN_USDT} USDT equivalent balance; duplicate acquisition blocked`);
  console.log(`APPROVED_V61 symbol=${SYMBOL} signal_pct=${SIGNAL_PCT} current_pct=${currentPct} v61_score=${Number.isFinite(SIGNAL_V61_SCORE)?SIGNAL_V61_SCORE:'fallback'} position_fraction=${fraction.toFixed(4)} usdt_free=${usdtFree} quote_order_qty=${quoteOrderQty}`);
  const order=await signed(base,'POST','/api/v3/order',{symbol:SYMBOL,side:'BUY',type:'MARKET',quoteOrderQty:quoteOrderQty.toFixed(2),newOrderRespType:'FULL',newClientOrderId:`proypers-gh-${Date.now()}`});
  if(!order?.orderId)technicalFail('Binance returned no orderId');const executedQty=Number(order.executedQty||0),quoteFilled=Number(order.cummulativeQuoteQty||0),entryPrice=executedQty>0?quoteFilled/executedQty:currentPrice;console.log(`ORDER_CREATED symbol=${SYMBOL} orderId=${order.orderId} status=${order.status} quoteOrderQty=${quoteOrderQty}`);
  let protectedNow=false,protectionError='';for(let attempt=1;attempt<=2&&!protectedNow;attempt+=1){try{await placeNativeProtection(base,order,entryPrice);protectedNow=true;}catch(error){protectionError=error.message||String(error);if(attempt<2)await new Promise(r=>setTimeout(r,1500));}}
  if(!protectedNow){finish('executed_protection_pending',protectionError,order.orderId);console.warn(`BUY_EXECUTED_PROTECTION_PENDING symbol=${SYMBOL} orderId=${order.orderId} reason=${protectionError}`);return;}
  finish('executed','',order.orderId);
}
main().catch(error=>technicalFail(error.message||String(error)));
