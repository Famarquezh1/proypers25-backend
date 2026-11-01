'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root='/var/lib/proypers25',report=JSON.parse(fs.readFileSync(root+'/analysis/first15-20261101.json','utf8'));
const key=fs.readFileSync('/etc/proypers25/binance-key','utf8').trim(),secret=fs.readFileSync('/etc/proypers25/binance-secret','utf8').trim();
const transport=require('/opt/proypers25/runtime/readonly.cjs').makeFetch();
const strategy='/opt/proypers25/repo/backend/services/';
const {resolveManagedResidual}=require(strategy+'spotManagedResidual.js');
const {reconstructInventory,isProypersSpotBuyOrder}=require(strategy+'spotOrphanProtection.js');
const transitions=fs.readdirSync(root+'/transition-state').filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(root+'/transition-state/'+n,'utf8')));
async function get(endpoint,symbol){const q=new URLSearchParams({symbol,limit:'1000',recvWindow:'5000',timestamp:String(Date.now())});q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));const r=await transport('https://api.binance.com'+endpoint+'?'+q,{headers:{'X-MBX-APIKEY':key}});if(!r.ok)throw new Error('CONTEXT_HTTP_'+r.status);return r.json();}
(async()=>{
  const rows=[];
  for(const symbol of [...new Set(report.lots.map(l=>l.symbol))]){
    const [all,trades]=await Promise.all([get('/api/v3/allOrders',symbol),get('/api/v3/myTrades',symbol)]);
    for(const lot of report.lots.filter(l=>l.symbol===symbol)){
      const saleIds=new Set(lot.sellOrders.map(s=>String(s.orderId)));
      const tr=transitions.find(r=>r.symbol===symbol&&saleIds.has(String(r.confirmed?.orderId)));
      const orders=all.filter(o=>Number(o.time)<=lot.exitAt&&!saleIds.has(String(o.orderId))&&Number(o.updateTime||o.time)<=lot.exitAt);
      if(tr){const i=orders.findIndex(o=>String(o.orderId)===String(tr.old.orderId));if(i>=0)orders[i]=tr.old;else orders.push(tr.old);}
      orders.sort((a,b)=>Number(a.time)-Number(b.time));const observed=orders.slice(-100);
      const buys=observed.filter(isProypersSpotBuyOrder).sort((a,b)=>Number(a.updateTime||a.time)-Number(b.updateTime||b.time));
      const buy=buys.at(-1);
      const prior=trades.filter(t=>Number(t.time)<=lot.exitAt&&!saleIds.has(String(t.orderId)));
      const inventory=reconstructInventory(prior,symbol.slice(0,-4));
      const managed=resolveManagedResidual({buy,orders:observed,trades:prior,ownedTotal:inventory.quantity,baseAsset:symbol.slice(0,-4),forceReconstruct:buys.length>1});
      rows.push({symbol,buyAt:new Date(lot.buyAt).toISOString(),minutes:lot.durationMinutes,historicalBuyCount:buys.length,latestBuyMatchesLot:buy?.orderId===lot.buyOrderId,
        reconstructedStart:managed.startTime?new Date(managed.startTime).toISOString():null,reconstructedAgeHours:managed.startTime?(lot.exitAt-managed.startTime)/3600000:null,
        reconstructedEntryDifferencePct:managed.entryPrice?(managed.entryPrice/lot.entry-1)*100:null,residualMode:managed.residualMode,reconstructionActive:managed.active,
        canceledProtectionStopVsEntryPct:tr?(Number(tr.old.stopPrice)/lot.entry-1)*100:null,oldProtectionCreated:tr?.old?.time?new Date(Number(tr.old.time)).toISOString():null,
        transitionKind:tr?.kind||null,historyAtLimit:all.length===1000||trades.length===1000});
    }
  }
  fs.writeFileSync(root+'/analysis/first15-exit-context-20261101.json',JSON.stringify({at:new Date().toISOString(),assumption:'Replay of original residual resolver using last 100 order records available by exit; inventory reconstructed from last 1000 fills, transfers not reconstructed',rows}),{mode:0o600});
  console.log('FIRST15_EXIT_CONTEXT',JSON.stringify(rows));
})().catch(e=>{console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:'EXIT_CONTEXT_FAILED');process.exitCode=2;});
