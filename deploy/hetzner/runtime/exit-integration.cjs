'use strict';
const Module=require('node:module'),path=require('node:path');
function transform(source,name) {
  const replace=(old,next)=>{if(!source.includes(old))throw new Error('EXIT_INTEGRATION_SOURCE_MISMATCH');source=source.replace(old,next);};
  if(name==='github-spot-auto-exit-legacy-v10-aware.js')replace('eval(source);',
    `source = require(${JSON.stringify(__filename)}).transform(source, 'github-spot-auto-exit-legacy.js');\neval(source);`);
  if(name==='github-spot-v61-protect.js')replace(
    "if(open)await cancel(base,symbol,open);const refreshed=await signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'}),free=freeBalance(refreshed,info.baseAsset);await place(base,info,symbol,Math.min(qty,free),desired);",
    "if(open){await module.__protectionTransitions.tighten({symbol,oldOrder:open,stopPrice:desired,info});}else{const refreshed=await signed(base,'GET','/api/v3/account',{omitZeroBalances:'true'}),free=freeBalance(refreshed,info.baseAsset);await place(base,info,symbol,Math.min(qty,free),desired);}");
  if(name==='github-spot-auto-exit-legacy.js'){
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
module.exports={install,transform};
