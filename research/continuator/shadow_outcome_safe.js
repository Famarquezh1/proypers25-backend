'use strict';
// Research-only: no order placement or production imports.
const COST_PCT=0.20;
function eligibleBars(rows, decisionMs) {
  return rows.filter(r=>Number(r[0])>=decisionMs && Number(r[0])>=0 && Number(r[6])<=Date.now());
}
function closedReference(rows,decisionMs) {
  const closed=rows.filter(r=>Number(r[6])<decisionMs).sort((a,b)=>Number(a[0])-Number(b[0]));
  return closed.length?Number(closed.at(-1)[4]):0;
}
function outcome(rows,entry,decisionMs,tpPct=3,slPct=-1,costPct=COST_PCT) {
  if(!(entry>0))return {status:'NO_ENTRY'};
  const bars=eligibleBars(rows,decisionMs);
  if(!bars.length)return {status:'NO_BARS'};
  let max=-Infinity,min=Infinity;
  for(const bar of bars){
    const high=Number(bar[2]),low=Number(bar[3]);
    if(!Number.isFinite(high)||!Number.isFinite(low))return {status:'BAD_BAR'};
    max=Math.max(max,high);min=Math.min(min,low);
    const tp=(high/entry-1)*100>=tpPct;
    const sl=(low/entry-1)*100<=slPct;
    if(tp&&sl)return {status:'AMBIGUOUS_SAME_BAR',net_pct:null,hit3before1:null};
    if(sl)return {status:'SL_HIT',net_pct:+(slPct-costPct).toFixed(3),hit3before1:false};
    if(tp)return {status:'TP_HIT',net_pct:+(tpPct-costPct).toFixed(3),hit3before1:true};
  }
  const terminal=(Number(bars.at(-1)[4])/entry-1)*100;
  return {status:'TIMEOUT',net_pct:+(terminal-costPct).toFixed(3),hit3before1:false};
}
module.exports={closedReference,outcome,eligibleBars};
