'use strict';

const axios = require('axios');

const CONTROL_DOC = 'real_spot_config/cost_governance';
const RUNS = 'spot_cost_governance_runs';
const VERSION = 'spot_cost_governance_v2_infrastructure_economics';
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

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
    configured_jobs: 1,
    note: 'The real Spot cycle is triggered by Google Cloud Scheduler.'
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

function estimateCloudBuildCost(options = {}, pricing = PRICING) {
  const deployments = Math.max(0, n(options.deploymentsPerMonth, 8));
  const minutesPerDeployment = Math.max(0, n(options.cloudBuildMinutesPerDeployment, 8));
  const totalMinutes = deployments * minutesPerDeployment;
  const billableMinutes = Math.max(0, totalMinutes - pricing.cloud_build.included_minutes);
  return {
    deployments_per_month: deployments,
    minutes_per_deployment: minutesPerDeployment,
    total_minutes: round(totalMinutes, 2),
    included_minutes: pricing.cloud_build.included_minutes,
    billable_minutes: round(billableMinutes, 2),
    total_usd: round(billableMinutes * pricing.cloud_build.e2_standard_2_per_minute)
  };
}

function estimateFirestoreCost(options = {}, pricing = PRICING) {
  const reads = Math.max(0, n(options.firestoreReadsMonth, 0));
  const writes = Math.max(0, n(options.firestoreWritesMonth, 0));
  const deletes = Math.max(0, n(options.firestoreDeletesMonth, 0));
  const freeReads = pricing.firestore.free_reads_day * 30;
  const freeWrites = pricing.firestore.free_writes_day * 30;
  const freeDeletes = pricing.firestore.free_deletes_day * 30;
  const billableReads = Math.max(0, reads - freeReads);
  const billableWrites = Math.max(0, writes - freeWrites);
  const billableDeletes = Math.max(0, deletes - freeDeletes);
  return {
    reads,
    writes,
    deletes,
    billable_reads: billableReads,
    billable_writes: billableWrites,
    billable_deletes: billableDeletes,
    total_usd: round(
      (billableReads / 100000) * pricing.firestore.reads_per_100k +
      (billableWrites / 100000) * pricing.firestore.writes_per_100k +
      (billableDeletes / 100000) * pricing.firestore.deletes_per_100k
    )
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

  const githubScheduledRuns = monthlyRuns(discoveryEveryMinutes);
  const githubMinutes = githubScheduledRuns * Math.max(1, n(options.githubMinutesPerRun, 1));
  const github = estimateGitHubActionsCost(githubMinutes, options);
  const cloudBuild = estimateCloudBuildCost(options);
  const firestore = estimateFirestoreCost(options);
  const cloudRunUsd = tasks.reduce((sum, task) => sum + task.cloud_run.total_usd, 0);
  const configuredSchedulerJobs = Math.max(0, n(options.configuredSchedulerJobs, PRICING.cloud_scheduler.configured_jobs));
  const schedulerUsd = Math.max(0, configuredSchedulerJobs - PRICING.cloud_scheduler.included_jobs) * PRICING.cloud_scheduler.per_job_month;
  const artifactStorageGib = Math.max(0, n(options.artifactRegistryStorageGib, 0.5));
  const artifactRegistryUsd = Math.max(0, artifactStorageGib - PRICING.artifact_registry.free_storage_gib) * PRICING.artifact_registry.storage_per_gib_month;
  const loggingGib = Math.max(0, n(options.cloudLoggingIngestionGib, 0));
  const cloudLoggingUsd = Math.max(0, loggingGib - PRICING.cloud_logging.free_ingestion_gib_month) * PRICING.cloud_logging.ingestion_per_gib;
  const fixedOtherUsd = Math.max(0, n(options.otherMonthlyUsd, 0));

  const projected = cloudRunUsd + github.total_usd + cloudBuild.total_usd + firestore.total_usd + schedulerUsd + artifactRegistryUsd + cloudLoggingUsd + fixedOtherUsd;
  return {
    assumptions: {
      discovery_every_minutes: discoveryEveryMinutes,
      adaptive_every_minutes: adaptiveEveryMinutes,
      quant_every_minutes: quantEveryMinutes,
      governance_every_minutes: governanceEveryMinutes,
      cloud_run_vcpu: PRICING.cloud_run.assumed_vcpu,
      cloud_run_memory_gib: PRICING.cloud_run.assumed_memory_gib,
      github_job_consolidated: true,
      configured_scheduler_jobs: configuredSchedulerJobs
    },
    tasks,
    cloud_run_usd: round(cloudRunUsd),
    github_actions: github,
    cloud_build: cloudBuild,
    firestore,
    cloud_scheduler_usd: round(schedulerUsd),
    artifact_registry_usd: round(artifactRegistryUsd),
    cloud_logging_usd: round(cloudLoggingUsd),
    other_monthly_usd: round(fixedOtherUsd),
    projected_monthly_usd: round(projected)
  };
}

function economicDecision({ realizedPnl30d, effectiveInfrastructureCost30d, projectedMonthlyCost, monthlyBudgetUsd = 10, maxCostSharePct = 25, costSource = 'ESTIMATE' }) {
  const pnl = n(realizedPnl30d);
  const cost = Math.max(0, n(effectiveInfrastructureCost30d, projectedMonthlyCost));
  const budget = Math.max(0, n(monthlyBudgetUsd, 10));
  const maxShare = Math.max(5, Math.min(80, n(maxCostSharePct, 25)));
  const net = pnl - cost;
  const costShare = pnl > 0 ? (cost / pnl) * 100 : null;
  const reasons = [];
  let mode = 'NORMAL';

  if (cost > budget) {
    mode = 'ECONOMY';
    reasons.push('INFRASTRUCTURE_COST_ABOVE_BUDGET');
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
    cost_source: costSource,
    realized_pnl_30d_usd: round(pnl),
    effective_infrastructure_cost_30d_usd: round(cost),
    projected_monthly_cost_usd: round(projectedMonthlyCost),
    realized_net_after_infrastructure_30d_usd: round(net),
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

function buildInfrastructureEconomics({ realizedPnl30d = 0, grossPnl30d = 0, closedTrades30d = 0, effectiveCost30d = 0, projectedMonthlyCost = 0, positionSizeUsd = 10, costSource = 'ESTIMATE' } = {}) {
  const trades = Math.max(0, Math.floor(n(closedTrades30d)));
  const cost = Math.max(0, n(effectiveCost30d, projectedMonthlyCost));
  const size = Math.max(0, n(positionSizeUsd, 10));
  const costPerTrade = trades > 0 ? cost / trades : null;
  const requiredReturnPct = costPerTrade !== null && size > 0 ? (costPerTrade / size) * 100 : null;
  return {
    cost_source: costSource,
    gross_pnl_30d_usd: round(grossPnl30d),
    realized_pnl_30d_usd: round(realizedPnl30d),
    infrastructure_cost_30d_usd: round(cost),
    net_after_infrastructure_30d_usd: round(n(realizedPnl30d) - cost),
    closed_trades_30d: trades,
    infrastructure_cost_per_closed_trade_usd: costPerTrade === null ? null : round(costPerTrade),
    configured_position_size_usd: round(size),
    minimum_return_per_trade_to_cover_infrastructure_pct: requiredReturnPct === null ? null : round(requiredReturnPct, 4),
    monthly_gross_pnl_required_for_infrastructure_break_even_usd: round(cost),
    projected_monthly_cost_usd: round(projectedMonthlyCost)
  };
}

async function loadRealizedPerformance30d(db) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection('real_spot_execution_results').limit(1000).get();
  return snapshot.docs.reduce((summary, doc) => {
    const data = doc.data();
    const date = new Date(data.closed_at || data.created_at || 0).getTime();
    if (date < cutoff || data.pnl_verified === false) return summary;
    summary.closed_trades += 1;
    summary.gross_pnl_usd += n(data.gross_pnl_usdt, n(data.net_pnl_usdt));
    summary.realized_pnl_usd += n(data.net_pnl_usdt);
    return summary;
  }, { closed_trades: 0, gross_pnl_usd: 0, realized_pnl_usd: 0 });
}

function safeBigQueryIdentifier(value) {
  const text = String(value || '').trim();
  if (!text || !/^[A-Za-z0-9_.\-*]+$/.test(text)) throw new Error('INVALID_BILLING_EXPORT_TABLE');
  return text;
}

async function metadataAccessToken(dependencies = {}) {
  const http = dependencies.http || axios;
  const response = await http.get(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    timeout: 5000
  });
  if (!response.data?.access_token) throw new Error('GCP_METADATA_ACCESS_TOKEN_MISSING');
  return response.data.access_token;
}

async function queryBigQueryBilling30d(config = {}, dependencies = {}) {
  const exportEnabled = config.billing_export_enabled === true || String(process.env.GCP_BILLING_EXPORT_ENABLED || '').toLowerCase() === 'true';
  const table = config.billing_export_table || process.env.GCP_BILLING_EXPORT_TABLE;
  if (!exportEnabled || !table) {
    return { connected: false, source: 'ESTIMATE', reason: 'BILLING_EXPORT_NOT_CONFIGURED' };
  }

  const billingProject = String(config.billing_export_project_id || process.env.GCP_BILLING_EXPORT_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || 'proypers2025');
  const targetProject = String(config.billing_target_project_id || process.env.GCP_BILLING_TARGET_PROJECT_ID || 'proypers2025');
  const location = config.billing_export_location || process.env.GCP_BILLING_EXPORT_LOCATION || undefined;
  const safeTable = safeBigQueryIdentifier(table);
  const token = await metadataAccessToken(dependencies);
  const http = dependencies.http || axios;
  const query = `SELECT ROUND(COALESCE(SUM(cost), 0) + COALESCE(SUM((SELECT SUM(c.amount) FROM UNNEST(credits) c)), 0), 8) AS net_cost_usd FROM \`${safeTable}\` WHERE project.id = @targetProject AND usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)`;
  const body = {
    query,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [{ name: 'targetProject', parameterType: { type: 'STRING' }, parameterValue: { value: targetProject } }]
  };
  if (location) body.location = location;
  const response = await http.post(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(billingProject)}/queries`, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 30000
  });
  if (response.data?.jobComplete === false) throw new Error('BILLING_QUERY_NOT_COMPLETE');
  const value = response.data?.rows?.[0]?.f?.[0]?.v;
  const cost = n(value, NaN);
  if (!Number.isFinite(cost)) throw new Error('BILLING_QUERY_COST_MISSING');
  return {
    connected: true,
    source: 'GCP_BIGQUERY_BILLING_EXPORT',
    cost_30d_usd: round(Math.max(0, cost)),
    billing_export_project_id: billingProject,
    billing_target_project_id: targetProject,
    billing_export_table: safeTable,
    measured_at: new Date().toISOString()
  };
}

async function loadBillingCost30d(config = {}, dependencies = {}) {
  const externalCost = n(config.actual_billing_30d_usd, NaN);
  const externalUpdatedAt = new Date(config.actual_billing_updated_at || 0).getTime();
  const freshExternal = Number.isFinite(externalCost) && externalCost >= 0 && Number.isFinite(externalUpdatedAt) && Date.now() - externalUpdatedAt <= 72 * 60 * 60 * 1000;
  if (freshExternal) {
    return {
      connected: true,
      source: 'EXTERNAL_BILLING_VALUE',
      cost_30d_usd: round(externalCost),
      measured_at: new Date(externalUpdatedAt).toISOString()
    };
  }
  try {
    return await queryBigQueryBilling30d(config, dependencies);
  } catch (error) {
    return {
      connected: false,
      source: 'ESTIMATE',
      reason: 'BILLING_EXPORT_QUERY_FAILED',
      error: error.response?.data?.error?.message || error.message
    };
  }
}

async function runCostGovernance(db, options = {}, dependencies = {}) {
  const controlRef = db.doc(CONTROL_DOC);
  const current = await controlRef.get();
  const config = { ...(current.exists ? current.data() : {}), ...options };
  const [performance, billing] = await Promise.all([
    loadRealizedPerformance30d(db),
    loadBillingCost30d(config, dependencies)
  ]);
  const estimate = buildMonthlyEstimate(config);
  const effectiveCost = billing.connected === true ? n(billing.cost_30d_usd) : estimate.projected_monthly_usd;
  const costSource = billing.connected === true ? billing.source : 'PUBLIC_PRICE_ESTIMATE';
  const positionSize = n(config.position_size_usd, n(config.max_position_usdt, 10));
  const economics = buildInfrastructureEconomics({
    realizedPnl30d: performance.realized_pnl_usd,
    grossPnl30d: performance.gross_pnl_usd,
    closedTrades30d: performance.closed_trades,
    effectiveCost30d: effectiveCost,
    projectedMonthlyCost: estimate.projected_monthly_usd,
    positionSizeUsd: positionSize,
    costSource
  });
  const decision = economicDecision({
    realizedPnl30d: performance.realized_pnl_usd,
    effectiveInfrastructureCost30d: effectiveCost,
    projectedMonthlyCost: estimate.projected_monthly_usd,
    monthlyBudgetUsd: n(config.monthly_budget_usd, 10),
    maxCostSharePct: n(config.max_cost_share_pct, 25),
    costSource
  });
  const createdAt = new Date().toISOString();
  const result = {
    id: `cost_${Date.now()}`,
    created_at: createdAt,
    pricing: PRICING,
    estimate,
    billing,
    performance,
    economics,
    decision,
    actual_billing_connected: billing.connected === true,
    actual_billing_note: billing.connected === true
      ? 'The 30-day infrastructure cost was read from the configured billing source.'
      : 'Fallback estimate based on configured public prices. Exact billing requires a fresh external value or Google Cloud Billing Export access.',
    version: VERSION
  };
  await db.collection(RUNS).doc(result.id).set(result);
  await controlRef.set({
    ...config,
    last_run_at: createdAt,
    current_mode: decision.mode,
    cost_source: costSource,
    projected_monthly_usd: estimate.projected_monthly_usd,
    effective_infrastructure_cost_30d_usd: economics.infrastructure_cost_30d_usd,
    realized_pnl_30d_usd: economics.realized_pnl_30d_usd,
    realized_net_after_infrastructure_30d_usd: economics.net_after_infrastructure_30d_usd,
    closed_trades_30d: economics.closed_trades_30d,
    infrastructure_cost_per_closed_trade_usd: economics.infrastructure_cost_per_closed_trade_usd,
    minimum_return_per_trade_to_cover_infrastructure_pct: economics.minimum_return_per_trade_to_cover_infrastructure_pct,
    projected_net_after_infrastructure_usd: decision.projected_net_after_infrastructure_usd,
    cost_share_pct: decision.cost_share_of_positive_pnl_pct,
    research_frequency_multiplier: decision.research_frequency_multiplier,
    actual_billing_connected: billing.connected === true,
    actual_billing_last_error: billing.error || null,
    version: VERSION
  }, { merge: true });
  return result;
}

module.exports = {
  PRICING,
  VERSION,
  estimateCloudRunCost,
  estimateGitHubActionsCost,
  estimateCloudBuildCost,
  estimateFirestoreCost,
  buildMonthlyEstimate,
  economicDecision,
  buildInfrastructureEconomics,
  safeBigQueryIdentifier,
  queryBigQueryBilling30d,
  loadBillingCost30d,
  loadRealizedPerformance30d,
  runCostGovernance
};
