'use strict';

const assert=require('assert');
const {coreGrid,splitRows,devGate,holdoutGate}=require('../scripts/train-spot-core-exit-intensive-v4');

(function grid(){
  const g=coreGrid();
  assert(g.length>500);
  assert(g.length<2000);
  assert(g.every(p=>p.hard_stop_pct<=0.05));
  assert(g.some(p=>p.hard_stop_pct===0.05&&p.break_even_trigger_pct===0.05&&p.break_even_lock_pct===0.002&&p.trailing_trigger_pct===0.08&&p.trailing_distance_pct===0.06&&p.stale_timeout_hours===18&&p.take_profit_pct===0));
})();

(function split(){
  const rows=Array.from({length:174},(_,i)=>({execution_at:new Date(Date.UTC(2026,8,1)+i*3600000).toISOString()}));
  const s=splitRows(rows);
  assert.strictEqual(s.holdout.length,35);
  assert.strictEqual(s.folds.length,3);
})();

(function gates(){
  const good={avg_normal_mean_delta_pct:.1,avg_fee_stress_mean_delta_pct:.08,avg_cadence_10m_mean_delta_pct:.07,avg_cadence_15m_mean_delta_pct:.02,avg_positive_rate_delta:.01,worst_fold_mean_delta_pct:0,worst_tail_delta_pct:0};
  assert(devGate(good));
  const h={samples:35,deltas:{normal:{mean_return_pct:.1,positive_rate:0,profit_factor:0,worst_return_pct:0},fee_stress:{mean_return_pct:.08},cadence_10m:{mean_return_pct:.07},cadence_15m:{mean_return_pct:.01}}};
  assert(holdoutGate(h));
})();

console.log('spot core exit intensive tests passed');
