'use strict';

const fs = require('fs');
const path = require('path');
const {
  CURRENT_CORE_POLICY,
  CURRENT_V61_POLICY,
  metrics,
  buildDataset
} = require('./train-spot-exit-policy-v2');

const OUTPUT = process.env.CORE_EXIT_INTENSIVE_OUTPUT || path.join(process.cwd(), 'spot-core-exit-intensive-report.json');

function n(v, fallback = 0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function round(v, d = 6) { const f = 10 ** d; return Math.round(n(v) * f) / f; }
function mean(xs = []) { return xs.length ? xs.reduce((s, x) => s + n(x), 0) / xs.length : 0; }

function coreGrid() {
  const out = [];
  for (const hard of [0.04, 0.05]) {
    for (const beTrigger of [0.04, 0.05, 0.06]) {
      for (const beLock of [0.001, 0.002, 0.003]) {
        for (const trailTrigger of [0.06, 0.08, 0.10]) {
          for (const trailDistance of [0.04, 0.05, 0.06]) {
            if (trailDistance >= trailTrigger) continue;
            for (const timeout of [12, 18, 24]) {
              for (const takeProfit of [0, 0.05, 0.08]) {
                out.push({
                  hard_stop_pct: hard,
                  break_even_trigger_pct: beTrigger,
                  break_even_lock_pct: beLock,
                  trailing_trigger_pct: trailTrigger,
                  trailing_distance_pct: trailDistance,
                  stale_timeout_hours: timeout,
                  stale_max_gain_pct: CURRENT_CORE_POLICY.stale_max_gain_pct,
                  take_profit_pct: takeProfit
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}
function ordered(rows) {
  return [...rows].sort((a,b)=>Date.parse(a.execution_at||a.created_at)-Date.parse(b.execution_at||b.created_at));
}
function splitRows(rows) {
  const all=ordered(rows), h=Math.floor(all.length*0.80), dev=all.slice(0,h), holdout=all.slice(h), d=dev.length;
  const a=Math.floor(d*.50), b=Math.floor(d*.66), c=Math.floor(d*.83);
  const folds=[
    {name:'WF1',rows:dev.slice(a,b)},
    {name:'WF2',rows:dev.slice(b,c)},
    {name:'WF3',rows:dev.slice(c)}
  ].filter(x=>x.rows.length>=15);
  return {dev,holdout,folds};
}
function delta(candidate,baseline){
  return {
    mean_return_pct:round(candidate.mean_return_pct-baseline.mean_return_pct,4),
    positive_rate:round(candidate.positive_rate-baseline.positive_rate,4),
    profit_factor:round(candidate.profit_factor-baseline.profit_factor,4),
    worst_return_pct:round(candidate.worst_return_pct-baseline.worst_return_pct,4)
  };
}
function scenarios(rows,core){
  return {
    normal:metrics(rows,core,CURRENT_V61_POLICY,{feePct:.002,decisionStepBars:1}),
    fee_stress:metrics(rows,core,CURRENT_V61_POLICY,{feePct:.0035,decisionStepBars:1}),
    cadence_10m:metrics(rows,core,CURRENT_V61_POLICY,{feePct:.0025,decisionStepBars:2}),
    cadence_15m:metrics(rows,core,CURRENT_V61_POLICY,{feePct:.0025,decisionStepBars:3})
  };
}
function compare(rows,core){
  const baseline=scenarios(rows,CURRENT_CORE_POLICY), candidate=scenarios(rows,core);
  return {
    samples:rows.length,baseline,candidate,
    deltas:{
      normal:delta(candidate.normal,baseline.normal),
      fee_stress:delta(candidate.fee_stress,baseline.fee_stress),
      cadence_10m:delta(candidate.cadence_10m,baseline.cadence_10m),
      cadence_15m:delta(candidate.cadence_15m,baseline.cadence_15m)
    }
  };
}
function robust(comparisons){
  const m=mean(comparisons.map(x=>x.deltas.normal.mean_return_pct));
  const fee=mean(comparisons.map(x=>x.deltas.fee_stress.mean_return_pct));
  const c10=mean(comparisons.map(x=>x.deltas.cadence_10m.mean_return_pct));
  const c15=mean(comparisons.map(x=>x.deltas.cadence_15m.mean_return_pct));
  const pos=mean(comparisons.map(x=>x.deltas.normal.positive_rate));
  const pf=mean(comparisons.map(x=>x.deltas.normal.profit_factor));
  const worst=Math.min(...comparisons.map(x=>x.deltas.normal.mean_return_pct));
  const tail=Math.min(...comparisons.map(x=>x.deltas.normal.worst_return_pct));
  return {
    score:round(m+.45*fee+.55*c10+.35*c15+.60*pos+.05*pf+.08*worst+.03*tail,6),
    avg_normal_mean_delta_pct:round(m,4),
    avg_fee_stress_mean_delta_pct:round(fee,4),
    avg_cadence_10m_mean_delta_pct:round(c10,4),
    avg_cadence_15m_mean_delta_pct:round(c15,4),
    avg_positive_rate_delta:round(pos,4),
    avg_profit_factor_delta:round(pf,4),
    worst_fold_mean_delta_pct:round(worst,4),
    worst_tail_delta_pct:round(tail,4)
  };
}
function devGate(r){
  return r.avg_normal_mean_delta_pct>=.05 &&
    r.avg_fee_stress_mean_delta_pct>=0 &&
    r.avg_cadence_10m_mean_delta_pct>=0 &&
    r.avg_cadence_15m_mean_delta_pct>=-.05 &&
    r.avg_positive_rate_delta>=-.02 &&
    r.worst_fold_mean_delta_pct>=-.20 &&
    r.worst_tail_delta_pct>=-.50;
}
function holdoutGate(h){
  const d=h.deltas;
  return h.samples>=25 &&
    d.normal.mean_return_pct>=.08 &&
    d.fee_stress.mean_return_pct>=.03 &&
    d.cadence_10m.mean_return_pct>=.03 &&
    d.cadence_15m.mean_return_pct>=-.05 &&
    d.normal.positive_rate>=-.02 &&
    d.normal.profit_factor>=-.10 &&
    d.normal.worst_return_pct>=-.50;
}
function differs(a,b){
  return ['hard_stop_pct','break_even_trigger_pct','break_even_lock_pct','trailing_trigger_pct','trailing_distance_pct','stale_timeout_hours','take_profit_pct']
    .some(k=>n(a[k])!==n(b[k]));
}

async function main(){
  const repo=process.env.GITHUB_REPOSITORY||process.env.GH_REPOSITORY||'';
  if(!repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required');
  const started=Date.now(), dataset=await buildDataset(repo);
  if(dataset.rows.length<120) throw new Error('Insufficient CORE history');
  const split=splitRows(dataset.rows);
  if(split.holdout.length<25||split.folds.length<3) throw new Error('Insufficient chronological evidence');
  const grid=coreGrid(), ranked=[];
  for(const policy of grid){
    const comparisons=split.folds.map(f=>compare(f.rows,policy));
    const r=robust(comparisons);
    if(devGate(r)) ranked.push({policy,robust:r,comparisons});
  }
  ranked.sort((a,b)=>b.robust.score-a.robust.score);
  const finalists=ranked.slice(0,12);
  let selected=null;
  const evaluated=[];
  for(const x of finalists){
    const holdout=compare(split.holdout,x.policy), passed=holdoutGate(holdout);
    const row={...x,holdout,passed_for_production:passed};
    evaluated.push(row);
    if(!selected&&passed&&differs(x.policy,CURRENT_CORE_POLICY)) selected=row;
  }
  const report={
    ok:true,
    version:'SPOT_CORE_EXIT_INTENSIVE_V4_2026_09_19',
    generated_at:new Date().toISOString(),
    runtime_seconds:round((Date.now()-started)/1000,2),
    reconstructed_core_trades:dataset.rows.length,
    matched_unique_exits:dataset.matched_exit_count,
    candidates_tested:grid.length,
    development_rows:split.dev.length,
    walk_forward_folds:split.folds.map(x=>({name:x.name,samples:x.rows.length})),
    untouched_holdout_rows:split.holdout.length,
    current_core_policy:CURRENT_CORE_POLICY,
    current_v61_policy:CURRENT_V61_POLICY,
    viable_development_candidates:ranked.length,
    finalists:evaluated,
    selected_core_policy:selected?selected.policy:null,
    selected_development:selected?selected.robust:null,
    selected_holdout:selected?selected.holdout:null,
    promotion_recommendation:selected?'PROMOTE':'KEEP_CURRENT'
  };
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    ok:true,version:report.version,runtime_seconds:report.runtime_seconds,
    reconstructed_core_trades:report.reconstructed_core_trades,
    candidates_tested:report.candidates_tested,
    viable_development_candidates:report.viable_development_candidates,
    holdout_rows:report.untouched_holdout_rows,
    current_core_policy:report.current_core_policy,
    selected_core_policy:report.selected_core_policy,
    selected_development:report.selected_development,
    selected_holdout:report.selected_holdout,
    recommendation:report.promotion_recommendation
  }));
}
if(require.main===module) main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
module.exports={coreGrid,splitRows,robust,devGate,holdoutGate};
