'use strict';

const CONTROL_DOC = 'real_spot_config/cost_governance';
const RUNS = 'spot_cost_governance_runs';

const PRICING = Object.freeze({
  source_date: '2026-07-18',
  currency: 'USD',
  cloud_run: {
    cpu_per_vcpu_second: 0.000011244,
    memory_per_gib_second: 0.000001235,
    assumed_vcpu: 1,
    assumed_memory_gib: 0.5,
    note: 'Estimate before Cloud Run free tier and region-specific billing adjustments.'
  },
  github_actions: {
    linux_2_core_per_minute: 0.006,
    included_minutes_free: 2000,
    included_minutes_pro: 3000,
    note: 'Public repositories using standard hosted runners are free. Private repositories consume included minutes first.'
  },
  cloud_build: {
    e2_standard_2_per_minute: 0.006,
    included_minutes: 2500
  },
  cloud_scheduler: {
    per_job_month: 0.10,
    included_jobs: 3,
    configured_jobs: 0,
    note: 'Current research scheduling is done by GitHub Actions, not Google Cloud Scheduler.'
  },
  firestore: {
    reads_per_100k: 0.03,
    writes_per_100k: 0.09,
    deletes_per_100k: 0.01,
    free_reads_day: 50000,
    free_writes_day: 20000,
    free_deletes_day: 20000,
    free_storage_gib: 1
  },
  artifact_registry: {
    storage_per_gib_month: 0.10,
    free_storage_gib: 0.5
  },
  cloud_logging: {
    ingestion_per_gib: 0.50,
    free_ingestion_gib_month: 50
  }
});

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 6) {
  return Number(n(value).toFixed(decimals));
}

function monthlyRuns(minutes) {
  return Math.ceil((30 * 24 * 60) / Math.max(1, minutes));
}

function estimateCloudRunCost(runs, secondsPerRun, pricing = PRICING) {
  const seconds = Math.max(0, runs) * Math.max(0, secondsPerRun);
  const cpu = seconds * pricing.cloud_run.assumed_vcpu * pricing.cloud_run.cpu_per_vcpu_second;
  const memory = seconds * pricing.cloud_run.assumed_memory_gib * pricing.cloud_run.memory_per_gib_second;
  return { seconds, cpu_usd: round(cpu), memory_usd: round(memory), total_usd: round(cpu + memory) };
}

function estimateGitHubActionsCost(totalMinutes, options = {}, pricing = PRICING) {
  const repositoryPublic = options.repositoryPublic === true;
  const plan = String(options.githubPlan || 'FREE').toUpperCase();
  const included = plan === 'PRO' ? pricing.github_actions.included_minutes_pro : pricing.github_actions.included_minutes_free;
  const billable = repositoryPublic ? 0 : Math.max(0, totalMinutes - included);
  return {
    repository_public: repositoryPublic,
    plan,
    total_minutes: round(totalMinutes, 2),
    included_minutes: repositoryPublic ? totalMinutes : included,
    billable_minutes: round(billable, 2),
    total_usd: round(billable * pricing.github_actions.linux_2_core_per_minute)
  };
}

function buildMonthlyEstimate(options = {}) {
  const discoveryEveryMinutes = Math.max(15, n(options.discoveryEveryMinutes, 30));
  const adaptiveEveryMinutes = Math.max(30, n(options.adaptiveEveryMinutes, 60));
  const quantEveryMinutes = Math.max(60, n(options.quantEveryMinutes, 120));
  const governanceEveryMinutes = Math.max(60, n(options.governanceEveryMinutes, 360));

  const tasks = [
    { id: 'discovery', runs: monthlyRuns(discoveryEveryMinutes), seconds: n(options.discoverySeconds, 8) },
    { id: 'adaptive', runs: monthlyRuns(adaptiveEveryMinutes), seconds: n(options.adaptiveSeconds, 12) },
    { id: 'quant', runs: monthlyRuns(quantEveryMinutes), seconds: n(options.quantSeconds, 90) },
    { id: 'governance', runs: monthlyRuns(governanceEveryMinutes), seconds: n(options.governanceSeconds, 3) }
  ].map((task) => ({ ...task, cloud_run: estimateCloudRunCost(task.runs, task.seconds) }));

  // One consolidated GitHub job every 30 minutes avoids paying the one-minute
  // rounding overhead for three independent scheduled jobs.
  const githubScheduledRuns = monthlyRuns(discoveryEveryMinutes);
  const githubMinutes = githubScheduledRuns * Math.max(1, n(options.githubMinutesPerRun, 1));
  const github = estimateGitHubActionsCost(githubMinutes, options);
  const cloudRunUsd = tasks.reduce((sum, task) => sum + task.cloud_run.total_usd, 0);
  const schedulerUsd = Math.max(0, n(PRICING.cloud_scheduler.configured_jobs) - PRICING.cloud_scheduler.included_jobs) * PRICING.cloud_scheduler.per_job_month;
  const fixedOtherUsd = Math.max(0, n(options.otherMonthlyUsd, 0));

  return {
    assumptions: {
      discovery_every_minutes: discoveryEveryMinutes,
      adaptive_every_minutes: adaptiveEveryMinutes,
      quant_every_minutes: quantEveryMinutes,
      governance_every_minutes: governanceEveryMinutes,
      cloud_run_vcpu: PRICING.cloud_run.assumed_vcpu,
      cloud_run_memory_gib: PRICING.cloud_run.assumed_memory_gib,
      github_job_consolidated: true
    },
    tasks,
    cloud_run_usd: round(cloudRunUsd),
    github_actions: github,
    cloud_scheduler_usd: round(schedulerUsd),
    other_monthly_usd: round(fixedOtherUsd),
    projected_monthly_usd: round(cloudRunUsd + github.total_usd + schedulerUsd + fixedOtherUsd)
  };
}

function economicDecision({ realizedPnl30d, projectedMonthlyCost, monthlyBudgetUsd = 10, maxCostSharePct = 25 }) {
  const pnl = n(realizedPnl30d);
  const cost = Math.max(0, n(projectedMonthlyCost));
  const budget = Math.max(0, n(monthlyBudgetUsd, 10));
  const maxShare = Math.max(5, Math.min(80, n(maxCostSharePct, 25)));
  const net = pnl - cost;
  const costShare = pnl > 0 ? (cost / pnl) * 100 : null;
  const reasons = [];
  let mode = 'NORMAL';

  if (cost > budget) {
    mode = 'ECONOMY';
    reasons.push('PROJECTED_COST_ABOVE_BUDGET');
  }
  if (costShare !== null && costShare > maxShare) {
    mode = 'ECONOMY';
    reasons.push('INFRASTRUCTURE_COST_SHARE_TOO_HIGH');
  }
  if (pnl < 0 && cost > Math.max(1, budget * 0.5)) {
    mode = 'ECONOMY';
    reasons.push('NEGATIVE_PNL_WITH_MEANINGFUL_COST');
  }

  return {
    mode,
    realized_pnl_30d_usd: round(pnl),
    projected_monthly_cost_usd: round(cost),
    projected_net_after_infrastructure_usd: round(net),
    cost_share_of_positive_pnl_pct: costShare === null ? null : round(costShare, 2),
    monthly_budget_usd: budget,
    max_cost_share_pct: maxShare,
    research_frequency_multiplier: mode === 'ECONOMY' ? 2 : 1,
    real_exits_never_paused: true,
    real_entries_not_expanded: true,
    reasons
  };
}

async function loadRealizedPnl30d(db) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection('real_spot_execution_results').limit(1000).get();
  return snapshot.docs.reduce((sum, doc) => {
    const data = doc.data();
    const date = new Date(data.closed_at || data.created_at || 0).getTime();
    return date >= cutoff ? sum + n(data.net_pnl_usdt) : sum;
  }, 0);
}

async function runCostGovernance(db, options = {}) {
  const controlRef = db.doc(CONTROL_DOC);
  const current = await controlRef.get();
  const config = { ...(current.exists ? current.data() : {}), ...options };
  const estimate = buildMonthlyEstimate(config);
  const realizedPnl30d = await loadRealizedPnl30d(db);
  const decision = economicDecision({
    realizedPnl30d,
    projectedMonthlyCost: estimate.projected_monthly_usd,
    monthlyBudgetUsd: n(config.monthly_budget_usd, 10),
    maxCostSharePct: n(config.max_cost_share_pct, 25)
  });
  const createdAt = new Date().toISOString();
  const result = {
    id: `cost_${Date.now()}`,
    created_at: createdAt,
    pricing: PRICING,
    estimate,
    decision,
    actual_billing_connected: false,
    actual_billing_note: 'Public price-based estimate. Exact billed cost requires Google Cloud Billing Export and GitHub billing usage integration.',
    version: 'spot_cost_governance_v1'
  };
  await db.collection(RUNS).doc(result.id).set(result);
  await controlRef.set({
    ...config,
    last_run_at: createdAt,
    current_mode: decision.mode,
    projected_monthly_usd: estimate.projected_monthly_usd,
    projected_net_after_infrastructure_usd: decision.projected_net_after_infrastructure_usd,
    cost_share_pct: decision.cost_share_of_positive_pnl_pct,
    research_frequency_multiplier: decision.research_frequency_multiplier,
    actual_billing_connected: false,
    version: result.version
  }, { merge: true });
  return result;
}

module.exports = {
  PRICING,
  estimateCloudRunCost,
  estimateGitHubActionsCost,
  buildMonthlyEstimate,
  economicDecision,
  runCostGovernance
};
