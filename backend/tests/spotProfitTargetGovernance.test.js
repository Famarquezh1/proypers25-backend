'use strict';

const assert = require('assert');
const {
  buildProfitTarget,
  loadClpPerUsd,
  DEFAULT_MONTHLY_COST_FLOOR_CLP
} = require('../services/spotProfitTargetGovernance');

const target = buildProfitTarget({
  baseEconomics: {
    infrastructure_cost_30d_usd: 20,
    realized_pnl_30d_usd: 60
  },
  clpPerUsd: 900,
  monthlyCostFloorClp: 45000,
  targetNetMarginPct: 20,
  totalCapitalUsd: 14
});
assert.strictEqual(target.monthly_cost_floor_clp, 45000);
assert.strictEqual(target.effective_infrastructure_cost_clp, 45000);
assert.strictEqual(target.target_net_profit_clp, 9000);
assert.strictEqual(target.target_trading_pnl_clp, 54000);
assert.strictEqual(target.realized_trading_pnl_30d_clp, 54000);
assert.strictEqual(target.status, 'PROFIT_TARGET_MET');
assert.strictEqual(target.research_frequency_multiplier, 1);
assert.strictEqual(target.jobs_reduced_for_cost, false);
assert.ok(target.required_monthly_return_on_current_capital_pct > 400);
assert.ok(target.warnings.includes('TARGET_REQUIRES_OVER_100_PERCENT_MONTHLY_RETURN_ON_CURRENT_CAPITAL'));

const deficit = buildProfitTarget({
  baseEconomics: {
    infrastructure_cost_30d_usd: 55,
    realized_pnl_30d_usd: 10
  },
  clpPerUsd: 900,
  monthlyCostFloorClp: DEFAULT_MONTHLY_COST_FLOOR_CLP,
  targetNetMarginPct: 20,
  totalCapitalUsd: 100
});
assert.strictEqual(deficit.effective_infrastructure_cost_clp, 49500);
assert.strictEqual(deficit.status, 'COST_RECOVERY_REQUIRED');
assert.ok(deficit.remaining_to_profit_target_clp > 0);

(async () => {
  const fx = await loadClpPerUsd({}, {
    http: {
      get: async () => ({ data: { serie: [{ fecha: '2026-08-03T04:00:00.000Z', valor: 928.42 }] } })
    }
  });
  assert.strictEqual(fx.clp_per_usd, 928.42);
  assert.strictEqual(fx.source, 'MINDICADOR_DOLAR_OBSERVADO');
  assert.strictEqual(fx.live, true);
  console.log('spotProfitTargetGovernance.test.js PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
