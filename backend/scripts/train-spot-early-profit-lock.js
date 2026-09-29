'use strict';

const {
  CURRENT_CORE_POLICY,
  CURRENT_V61_POLICY,
  metrics,
  buildDataset
} = require('./train-spot-exit-policy-v2');

function ordered(rows){return [...rows].sort((a,b)=>Date.parse(a.execution_at||a.created_at)-Date.parse(b.execution_at||b.created_at))}
function split(rows){
  const all=ordered(rows), a=Math.floor(all.length*.60), b=Math.floor(all.length*.80);
  return {discovery:all.slice(0,a),validation:all.slice(a,b),holdout:all.slice(b)};
}
function summarize(rows,policy){
  const normal=metrics(rows,policy,CURRENT_V61_POLICY,{feePct:.002,decisionStepBars:1});
  const fee=metrics(rows,policy,CURRENT_V61_POLICY,{feePct:.0035,decisionStepBars:1});
  const c10=metrics(rows,policy,CURRENT_V61_POLICY,{feePct:.0025,decisionStepBars:2});
  return {normal,fee,c10};
}
function delta(a,b){
  return {
    mean_return_pct:a.normal.mean_return_pct-b.normal.mean_return_pct,
    positive_rate:a.normal.positive_rate-b.normal.positive_rate,
    profit_factor:a.normal.profit_factor-b.normal.profit_factor,
    worst_return_pct:a.normal.worst_return_pct-b.normal.worst_return_pct,
    fee_mean_return_pct:a.fee.mean_return_pct-b.fee.mean_return_pct,
    cadence10_mean_return_pct:a.c10.mean_return_pct-b.c10.mean_return_pct
  };
}
function pass(d,n){
  return n>=25 &&
    d.mean_return_pct>0 &&
    d.fee_mean_return_pct>=0 &&
    d.cadence10_mean_return_pct>=0 &&
    d.positive_rate>=-0.02 &&
    d.profit_factor>=-0.05 &&
    d.worst_return_pct>=-0.50;
}

(async()=>{
  const repo=process.env.GITHUB_REPOSITORY||process.env.GH_REPOSITORY||'Famarquezh1/proypers25-backend';
  const ds=await buildDataset(repo);
  if(ds.rows.length<120) throw new Error('Insufficient CORE history');
  const s=split(ds.rows);

  const candidates=[];
  for(const trigger of [0.02,0.025,0.03,0.035,0.04]){
    for(const lock of [0,0.002,0.003,0.005]){
      const policy={...CURRENT_CORE_POLICY,break_even_trigger_pct:trigger,break_even_lock_pct:lock};
      const bv=summarize(s.validation,CURRENT_CORE_POLICY), bh=summarize(s.holdout,CURRENT_CORE_POLICY);
      const cv=summarize(s.validation,policy), ch=summarize(s.holdout,policy);
      const dv=delta(cv,bv), dh=delta(ch,bh);
      candidates.push({trigger,lock,policy,validation:{baseline:bv,candidate:cv,delta:dv,pass:pass(dv,s.validation.length)},holdout:{baseline:bh,candidate:ch,delta:dh,pass:pass(dh,s.holdout.length)}});
    }
  }
  candidates.sort((x,y)=>{
    const xp=Number(x.validation.pass&&x.holdout.pass), yp=Number(y.validation.pass&&y.holdout.pass);
    if(yp!==xp) return yp-xp;
    const xs=Math.min(x.validation.delta.mean_return_pct,x.holdout.delta.mean_return_pct);
    const ys=Math.min(y.validation.delta.mean_return_pct,y.holdout.delta.mean_return_pct);
    return ys-xs;
  });
  const best=candidates[0]||null;
  const promote=Boolean(best&&best.validation.pass&&best.holdout.pass);
  console.log(JSON.stringify({
    ok:true,
    research_only:true,
    family:'EARLY_PROFIT_LOCK',
    rows:ds.rows.length,
    matched_unique_exits:ds.matched_exit_count,
    chronological_blocks:{discovery:s.discovery.length,validation:s.validation.length,holdout:s.holdout.length},
    current_policy:{break_even_trigger_pct:CURRENT_CORE_POLICY.break_even_trigger_pct,break_even_lock_pct:CURRENT_CORE_POLICY.break_even_lock_pct},
    best,
    top:candidates.slice(0,10),
    production_decision:promote?'PROMOTE_EARLY_PROFIT_LOCK':'DO_NOT_PROMOTE',
    promote
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});