'use strict';

const axios = require('axios');
const { runCostGovernance } = require('./spotCostGovernance');

const CONTROL_DOC = 'real_spot_config/cost_governance';
const BALANCE_DOC = 'real_spot_config/balance';
const RUNS = 'spot_cost_governance_runs';
const VERSION = 'spot_profit_target_governance_v1';
const DEFAULT_MONTHLY_COST_FLOOR_CLP = 45000;
const DEFAULT_TARGET_NET_MARGIN_PCT = 20;
const DEFAULT_FALLBACK_CLP_PER_USD = 930;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 6) {
  return Number(n(value).toFixed(decimals));
}

async function loadClpPerUsd(config = {}, dependencies = {}) {
  const http = dependencies.http || axios;
  const configured = n(config.clp_per_usd, NaN);
  const configuredAt = new Date(config.clp_per_usd_updated_at || 0).getTime();
  const configuredFresh = Number.isFinite(configured) && configured > 0 &&
    Number.isFinite(configuredAt) && Date.now() - configuredAt <= 7 * 24 * 60 * 60 * 1000;

  try {
    const response = await http.get('https://mindicador.cl/api/dolar', { timeout: 10000 });
    const latest = Array.isArray(response.data?.serie) ? response.data.serie[0] : null;
    const rate = n(latest?.valor, NaN);
    if (Number.isFinite(rate) && rate > 0) {
      return {
        clp_per_usd: round(rate, 4),
        source: 'MINDICADOR_DOLAR_OBSERVADO',
        observed_at: latest?.fecha || new Date().toISOString(),
        live: true
      };
    }
  } catch (error) {
    if (configuredFresh) {
      return {
        clp_per_usd: round(configured, 4),
        source: 'CONFIGURED_RECENT_FX',
        observed_at: new Date(configuredAt).toISOString(),
        live: false,
        warning: error.message
      };
    }
  }

  return {
    clp_per_usd: round(Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FALLBACK_CLP_PER_USD, 4),
    source: Number.isFinite(configured) && configured > 0 ? 'CONFIGURED_FX' : 'SAFE_FALLBACK_FX',
    observed_at: configuredAt > 0 ? new Date(configuredAt).toISOString() : null,
    live: false
  };
}

function buildProfitTarget({
  baseEconomics = {},
  clpPerUsd,
  monthlyCostFloorClp = DEFAULT_MONTHLY_COST_FLOOR_CLP,
  targetNetMarginPct = DEFAULT_TARGET_NET_MARGIN_PCT,
  totalCapitalUsd = 0
} = {}) {
  const fx = Math.max(1, n(clpPerUsd, DEFAULT_FALLBACK_CLP_PER_USD));
  const floorClp = Math.max(0, n(monthlyCostFloorClp, DEFAULT_MONTHLY_COST_FLOOR_CLP));
  const marginPct = Math.max(1, Math.min(200, n(targetNetMarginPct, DEFAULT_TARGET_NET_MARGIN_PCT)));
  const measuredCostUsd = Math.max(0, n(baseEconomics.infrastructure_cost_30d_usd));
  const measuredCostClp = measuredCostUsd * fx;
  const effectiveCostClp = Math.max(floorClp, measuredCostClp);
  const effectiveCostUsd = effectiveCostClp / fx;
  const targetNetProfitClp = effectiveCostClp * (marginPct / 100);
  const targetTradingPnlClp = effectiveCostClp + targetNetProfitClp;
  const targetTradingPnlUsd = targetTradingPnlClp / fx;
  const realizedPnlUsd = n(baseEconomics.realized_pnl_30d_usd);
  const realizedPnlClp = realizedPnlUsd * fx;
  const netAfterInfrastructureClp = realizedPnlClp - effectiveCostClp;
  const remainingToTargetClp = Math.max(0, targetTradingPnlClp - realizedPnlClp);
  const progressPct = targetTradingPnlClp > 0 ? (realizedPnlClp / targetTradingPnlClp) * 100 : 0;
  const capital = Math.max(0, n(totalCapitalUsd));
  const requiredMonthlyReturnPct = capital > 0 ? (targetTradingPnlUsd / capital) * 100 : null;

  let status = 'COST_RECOVERY_REQUIRED';
  if (realizedPnlClp >= targetTradingPnlClp) status = 'PROFIT_TARGET_MET';
  else if (realizedPnlClp >= effectiveCostClp) status = 'COST_COVERED_PROFIT_PENDING';

  const warnings = [];
  if (requiredMonthlyReturnPct !== null && requiredMonthlyReturnPct > 100) {
    warnings.push('TARGET_REQUIRES_OVER_100_PERCENT_MONTHLY_RETURN_ON_CURRENT_CAPITAL');
  }
  if (capital > 0 && capital < targetTradingPnlUsd) {
    warnings.push('CURRENT_CAPITAL_IS_BELOW_MONTHLY_PROFIT_TARGET');
  }

  return {
    status,
    monthly_cost_floor_clp: round(floorClp, 0),
    measured_infrastructure_cost_clp: round(measuredCostClp, 0),
    effective_infrastructure_cost_clp: round(effectiveCostClp, 0),
    effective_infrastructure_cost_usd: round(effectiveCostUsd),
    target_net_profit_margin_pct: round(marginPct, 2),
    target_net_profit_clp: round(targetNetProfitClp, 0),
    target_trading_pnl_clp: round(targetTradingPnlClp, 0),
    target_trading_pnl_usd: round(targetTradingPnlUsd),
    realized_trading_pnl_30d_usd: round(realizedPnlUsd),
    realized_trading_pnl_30d_clp: round(realizedPnlClp, 0),
    net_after_infrastructure_30d_clp: round(netAfterInfrastructureClp, 0),
    remaining_to_profit_target_clp: round(remainingToTargetClp, 0),
    target_progress_pct: round(progressPct, 2),
    total_capital_usd: round(capital),
    required_monthly_return_on_current_capital_pct: requiredMonthlyReturnPct === null ? null : round(requiredMonthlyReturnPct, 2),
    commissions_and_slippage_included_in_realized_pnl: true,
    job_frequency_policy: 'FULL_FREQUENCY',
    research_frequency_multiplier: 1,
    jobs_reduced_for_cost: false,
    warnings,
    version: VERSION
  };
}

async function runProfitTargetGovernance(db, options = {}, dependencies = {}) {
  if (!db) throw new Error('profit_target_governance_requires_db');
  const controlRef = db.doc(CONTROL_DOC);
  const balanceRef = db.doc(BALANCE_DOC);
  const [controlSnap, balanceSnap] = await Promise.all([controlRef.get(), balanceRef.get()]);
  const current = controlSnap.exists ? controlSnap.data() : {};
  const config = {
    ...current,
    ...options,
    monthly_cost_floor_clp: n(options.monthly_cost_floor_clp, n(current.monthly_cost_floor_clp, DEFAULT_MONTHLY_COST_FLOOR_CLP)),
    target_net_profit_margin_pct: n(options.target_net_profit_margin_pct, n(current.target_net_profit_margin_pct, DEFAULT_TARGET_NET_MARGIN_PCT)),
    research_frequency_multiplier: 1,
    job_frequency_policy: 'FULL_FREQUENCY'
  };

  const base = await runCostGovernance(db, config, dependencies);
  const fx = await loadClpPerUsd(config, dependencies);
  const balance = balanceSnap.exists ? balanceSnap.data() : {};
  const totalCapitalUsd = Math.max(0,
    n(balance.total_usdt, n(balance.available_usdt) + n(balance.in_positions_usdt))
  );
  const profitTarget = buildProfitTarget({
    baseEconomics: base.economics || {},
    clpPerUsd: fx.clp_per_usd,
    monthlyCostFloorClp: config.monthly_cost_floor_clp,
    targetNetMarginPct: config.target_net_profit_margin_pct,
    totalCapitalUsd
  });

  const reasons = [];
  if (profitTarget.status !== 'PROFIT_TARGET_MET') reasons.push(profitTarget.status);
  reasons.push(...profitTarget.warnings);
  const decision = {
    ...(base.decision || {}),
    mode: profitTarget.status,
    reasons,
    research_frequency_multiplier: 1,
    job_frequency_policy: 'FULL_FREQUENCY',
    jobs_reduced_for_cost: false,
    real_exits_never_paused: true,
    real_entries_not_expanded: true
  };
  const result = {
    ...base,
    fx,
    profit_target: profitTarget,
    decision,
    version: VERSION
  };

  await db.collection(RUNS).doc(base.id).set({
    fx,
    profit_target: profitTarget,
    decision,
    version: VERSION
  }, { merge: true });
  await controlRef.set({
    monthly_cost_floor_clp: profitTarget.monthly_cost_floor_clp,
    target_net_profit_margin_pct: profitTarget.target_net_profit_margin_pct,
    target_net_profit_clp: profitTarget.target_net_profit_clp,
    target_trading_pnl_clp: profitTarget.target_trading_pnl_clp,
    target_trading_pnl_usd: profitTarget.target_trading_pnl_usd,
    realized_trading_pnl_30d_clp: profitTarget.realized_trading_pnl_30d_clp,
    net_after_infrastructure_30d_clp: profitTarget.net_after_infrastructure_30d_clp,
    remaining_to_profit_target_clp: profitTarget.remaining_to_profit_target_clp,
    target_progress_pct: profitTarget.target_progress_pct,
    required_monthly_return_on_current_capital_pct: profitTarget.required_monthly_return_on_current_capital_pct,
    current_mode: profitTarget.status,
    research_frequency_multiplier: 1,
    job_frequency_policy: 'FULL_FREQUENCY',
    jobs_reduced_for_cost: false,
    clp_per_usd: fx.clp_per_usd,
    clp_per_usd_source: fx.source,
    clp_per_usd_updated_at: fx.observed_at || new Date().toISOString(),
    profit_target_warnings: profitTarget.warnings,
    profit_target_last_run_at: new Date().toISOString(),
    version: VERSION
  }, { merge: true });
  return result;
}

module.exports = {
  VERSION,
  DEFAULT_MONTHLY_COST_FLOOR_CLP,
  DEFAULT_TARGET_NET_MARGIN_PCT,
  loadClpPerUsd,
  buildProfitTarget,
  runProfitTargetGovernance
};
