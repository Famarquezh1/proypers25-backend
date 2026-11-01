'use strict';
const Module=require('node:module'),path=require('node:path');
function untradeableResidual({info,quantity,price,hasProtection=false}) {
  if(hasProtection)return false;
  const lot=info?.filters?.find(f=>f.filterType==='LOT_SIZE');
  const nf=info?.filters?.find(f=>f.filterType==='NOTIONAL'||f.filterType==='MIN_NOTIONAL');
  const step=Number(lot?.stepSize),min=Number(lot?.minQty),notional=Number(nf?.minNotional);
  if(!Number.isFinite(quantity)||quantity<0||!Number.isFinite(price)||price<=0||!(step>0)||!(min>0)||!Number.isFinite(notional)||notional<0)throw new Error('RESIDUAL_FILTER_REVIEW_REQUIRED');
  const qty=Math.floor((quantity+Number.EPSILON)/step)*step;
  return qty<min||qty*price<notional;
}
function transform(source,name) {
  const replace=(old,next)=>{if(!source.includes(old))throw new Error('EXIT_INTEGRATION_SOURCE_MISMATCH');source=source.replace(old,next);};
  if(name==='github-spot-auto-exit-legacy-v10-aware.js')replace('eval(source);',
    `source = require(${JSON.stringify(__filename)}).transform(source, 'github-spot-auto-exit-legacy.js');\neval(source);`);
  if(name==='github-spot-v61-protect.js')replace(
    "if(open)await cancel(base,symbol,open);const refreshed=await signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'}),free=freeBalance(refreshed,info.baseAsset);await place(base,info,symbol,Math.min(qty,free),desired);",
    "if(open){await module.__protectionTransitions.tighten({symbol,oldOrder:open,stopPrice:desired,info});}else{const refreshed=await signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'}),free=freeBalance(refreshed,info.baseAsset);await place(base,info,symbol,Math.min(qty,free),desired);}");
  if(name==='github-spot-auto-exit-legacy.js'){
    replace("const { latestOpenProtection, latestFilledExit, resolveManagedResidual } = require('../services/spotManagedResidual');",
      `const { latestOpenProtection, latestFilledExit } = require('../services/spotManagedResidual');\nconst { resolveManagedResidual } = require(${JSON.stringify(path.join(__dirname,'position-cohort.cjs'))});`);
    replace('      baseAsset: info.baseAsset,\n      forceReconstruct:', '      baseAsset: info.baseAsset,\n      info,\n      forceReconstruct:');
    replace('    if (reason) {\n      if (openProtect',
      `    if (reason) {\n      require(${JSON.stringify(path.join(__dirname,'position-cohort.cjs'))}).recordExitDecision({symbol,reason,buyOrderId:currentBaseBuy.orderId,oldNativeOrderId:openProtect?.orderId||null,entryPrice:effectiveEntryPrice,startTime:effectiveStartTime,ageHours,gainPct,recentHigh,stopPrice,cohortStartTime:managed.cohort?.startTime||null,historicalDustQuantity:managed.cohort?.dustQuantity||0});\n      if (openProtect`);
    replace('    const managedQty = managed.managedQty;',
      `    const managedQty = managed.managedQty;\n    if (require(${JSON.stringify(__filename)}).untradeableResidual({info,quantity:Math.min(managedQty,ownedTotal),price:currentPrice,hasProtection:Boolean(openProtect)})) { console.warn('EXIT_DUST_RECONCILED symbol='+symbol); continue; }`);
    replace("      if (openProtect) await cancelProtection(base, symbol, openProtect);\n      try {\n        await marketSell",
      "      if (openProtect) { await module.__protectionTransitions.exit({symbol,oldOrder:openProtect,info,managedQty}); soldCount += 1; continue; }\n      try {\n        await marketSell");
    replace("      if (openProtect) await cancelProtection(base, symbol, openProtect);\n      const refreshed = await signed",
      "      if (openProtect) { await module.__protectionTransitions.tighten({symbol,oldOrder:openProtect,info,stopPrice}); protectedCount += 1; continue; }\n      const refreshed = await signed");
  }
  if(name==='github-spot-orphan-protect.js'){
    replace("        if (orphanStop) await cancelOrder(base, symbol, orphanStop.orderId);\n        const exitReason",
      "        if (orphanStop) { await module.__protectionTransitions.exit({symbol,oldOrder:orphanStop,info,managedQty:orphanQty}); sold += 1; continue; }\n        const exitReason");
    replace("        if (orphanStop) await cancelOrder(base, symbol, orphanStop.orderId);\n        const afterCancel",
      "        if (orphanStop) { await module.__protectionTransitions.tighten({symbol,oldOrder:orphanStop,info,stopPrice:decision.stopPrice}); updated += 1; continue; }\n        const afterCancel");
  }
  return source;
}
function install(transitions) {
  const original=Module.prototype._compile;
  const names=new Set(['github-spot-v61-protect.js','github-spot-auto-exit-legacy.js','github-spot-auto-exit-legacy-v10-aware.js','github-spot-orphan-protect.js']);
  Module.prototype._compile=function(source,filename){
    const name=path.basename(filename);
    if(names.has(name)){source=transform(source.replace(/\r\n/g,'\n'),name);this.__protectionTransitions=transitions;}
    return original.call(this,source,filename);
  };
}
module.exports={install,transform,untradeableResidual};
