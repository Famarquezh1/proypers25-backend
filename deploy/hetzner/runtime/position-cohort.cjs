'use strict';
const fs=require('node:fs'),path=require('node:path');
function filters(info){
  const lot=info?.filters?.find(f=>f.filterType==='LOT_SIZE');
  const nf=info?.filters?.find(f=>f.filterType==='NOTIONAL'||f.filterType==='MIN_NOTIONAL');
  const step=Number(lot?.stepSize),min=Number(lot?.minQty),notional=Number(nf?.minNotional);
  if(!(step>0&&min>0)||!Number.isFinite(notional)||notional<0)throw new Error('COHORT_FILTER_REVIEW_REQUIRED');
  return {step,min,notional};
}
function splitInventory({trades,orders,baseAsset,info}){
  const f=filters(info),rows=[...trades].sort((a,b)=>Number(a.time)-Number(b.time)||Number(a.id)-Number(b.id));
  let quantity=0,cost=0,startTime=null,dustQuantity=0,dustCost=0,lastBuy=null;
  const protectedAt=time=>orders.some(o=>o.side==='SELL'&&['STOP_LOSS','STOP_LOSS_LIMIT'].includes(o.type)&&String(o.clientOrderId||'').startsWith('proypers-gh-protect-')&&
    Number(o.time)>=Number(startTime)&&Number(o.time)<=time&&(['NEW','PARTIALLY_FILLED'].includes(o.status)||Number(o.updateTime)>time));
  for(const t of rows){
    const qty=Number(t.qty),quote=Number(t.quoteQty??qty*Number(t.price)),fee=Number(t.commission||0),time=Number(t.time);
    if(!(qty>0&&quote>0&&Number.isFinite(fee)&&fee>=0&&Number.isFinite(time)))throw new Error('COHORT_TRADE_REVIEW_REQUIRED');
    if(t.isBuyer===true){
      const price=quote/qty,rounded=Math.floor((quantity+f.step*1e-10)/f.step)*f.step;
      // Roll lifecycle identity only at a distinct BUY, never between fills of one order.
      if(quantity>0&&String(t.orderId)!==String(lastBuy)&&(rounded<f.min||rounded*price<f.notional)&&!protectedAt(time)){
        dustQuantity+=quantity;dustCost+=cost;quantity=0;cost=0;startTime=null;
      }
      const acquired=qty-(t.commissionAsset===baseAsset?fee:0),spend=quote+(t.commissionAsset==='USDT'?fee:0);
      if(!(acquired>0))throw new Error('COHORT_COMMISSION_REVIEW_REQUIRED');
      if(!(quantity>1e-12))startTime=time;
      quantity+=acquired;cost+=spend;lastBuy=t.orderId;
    }else if(t.isBuyer===false){
      let dispose=qty+(t.commissionAsset===baseAsset?fee:0);
      // Historical residual remains in the cost ledger; FIFO consumes it before the active cohort.
      if(dustQuantity>0){const used=Math.min(dispose,dustQuantity);dustCost-=dustCost*used/dustQuantity;dustQuantity-=used;dispose-=used;}
      if(quantity>0){const used=Math.min(dispose,quantity);cost-=cost*used/quantity;quantity-=used;}
      if(!(quantity>1e-12)){quantity=0;cost=0;startTime=null;}
    }else throw new Error('COHORT_TRADE_SIDE_REQUIRED');
  }
  return {quantity,costQuote:cost,entryPrice:quantity>0?cost/quantity:0,startTime,dustQuantity,dustCostQuote:dustCost,totalQuantity:quantity+dustQuantity,totalCostQuote:cost+dustCost};
}
function resolveManagedResidual(options){
  const repo=process.env.PROYPERS_REPO||path.resolve(__dirname,'../../..');
  const original=require(path.join(repo,'backend/services/spotManagedResidual.js'));
  const result=original.resolveManagedResidual(options);
  if(!result.active||!options.forceReconstruct||!options.trades?.length)return result;
  const trades=original.managedTradesOnly(options.trades,options.orders);
  if(!trades.some(t=>t.isBuyer===true&&String(t.orderId)===String(options.buy.orderId)))throw new Error('COHORT_BUY_HISTORY_REQUIRED');
  const cohort=splitInventory({...options,trades});
  const tolerance=Math.max(filters(options.info).step*1.1,Number(options.ownedTotal)*.05);
  if(Math.abs(cohort.totalQuantity-Number(options.ownedTotal))>tolerance)throw new Error('COHORT_BALANCE_REVIEW_REQUIRED');
  if(!(cohort.quantity>0&&cohort.entryPrice>0&&cohort.startTime))return result;
  // Keep original inventory/protection quantities; only use the operational cohort for age and price identity.
  return {...result,entryPrice:cohort.entryPrice,startTime:cohort.startTime,cohort,
    originalStartTime:result.startTime,reason:'ACTIVE_COHORT_RECONCILED'};
}
function recordExitDecision(data){
  try{
    const dir=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25',file=path.join(dir,'exit-decisions.jsonl');
    if(fs.existsSync(file)&&fs.statSync(file).size>2*1024*1024)fs.renameSync(file,file+'.previous');
    const fd=fs.openSync(file,'a',0o600);
    try{fs.writeFileSync(fd,JSON.stringify({at:new Date().toISOString(),phase:'DECISION_BEFORE_DISPATCH',component:'LEGACY_CORE_EXIT',...data})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }catch{console.warn('EXIT_DECISION_LOG_FAILED');}
}
module.exports={splitInventory,resolveManagedResidual,recordExitDecision};
