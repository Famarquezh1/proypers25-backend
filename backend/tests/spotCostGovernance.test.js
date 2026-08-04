'use strict';

const assert = require('assert');
const {
  estimateCloudRunCost,
  estimateGitHubActionsCost,
  estimateCloudBuildCost,
  estimateFirestoreCost,
  buildMonthlyEstimate,
  economicDecision,
  buildInfrastructureEconomics,
  safeBigQueryIdentifier,
  loadBillingCost30d
} = require('../services/spotCostGovernance');

const cloudRun = estimateCloudRunCost(100, 10);
assert(cloudRun.total_usd > 0);
assert(cloudRun.total_usd < 1);

const publicActions = estimateGitHubActionsCost(5000, { repositoryPublic: true });
assert.strictEqual(publicActions.total_usd, 0);

const privateFreeActions = estimateGitHubActionsCost(2500, { repositoryPublic: false, githubPlan: 'FREE' });
assert.strictEqual(privateFreeActions.billable_minutes, 500);
assert.strictEqual(privateFreeActions.total_usd, 3);

const cloudBuild = estimateCloudBuildCost({ deploymentsPerMonth: 8, cloudBuildMinutesPerDeployment: 8 });
assert.strictEqual(cloudBuild.total_minutes, 64);
assert.strictEqual(cloudBuild.total_usd, 0);

const firestore = estimateFirestoreCost({ firestoreReadsMonth: 1600000, firestoreWritesMonth: 700000 });
assert(firestore.total_usd > 0);

const estimate = buildMonthlyEstimate({
  repositoryPublic: false,
  githubPlan: 'FREE',
  discoveryEveryMinutes: 30,
  adaptiveEveryMinutes: 60,
  quantEveryMinutes: 120,
  githubMinutesPerRun: 1,
  configuredSchedulerJobs: 1
});
assert.strictEqual(estimate.assumptions.github_job_consolidated, true);
assert.strictEqual(estimate.assumptions.configured_scheduler_jobs, 1);
assert.strictEqual(estimate.github_actions.total_minutes, 1440);
assert.strictEqual(estimate.github_actions.total_usd, 0);
assert.strictEqual(estimate.cloud_scheduler_usd, 0);

const normal = economicDecision({
  realizedPnl30d: 20,
  effectiveInfrastructureCost30d: 2,
  projectedMonthlyCost: 3,
  monthlyBudgetUsd: 10,
  maxCostSharePct: 25,
  costSource: 'GCP_BIGQUERY_BILLING_EXPORT'
});
assert.strictEqual(normal.mode, 'NORMAL');
assert.strictEqual(normal.realized_net_after_infrastructure_30d_usd, 18);
assert.strictEqual(normal.cost_source, 'GCP_BIGQUERY_BILLING_EXPORT');

const economy = economicDecision({
  realizedPnl30d: 20,
  effectiveInfrastructureCost30d: 8,
  projectedMonthlyCost: 8,
  monthlyBudgetUsd: 10,
  maxCostSharePct: 25
});
assert.strictEqual(economy.mode, 'ECONOMY');
assert.strictEqual(economy.research_frequency_multiplier, 2);
assert.strictEqual(economy.real_exits_never_paused, true);

const tradeEconomics = buildInfrastructureEconomics({
  realizedPnl30d: 3,
  grossPnl30d: 3.2,
  closedTrades30d: 4,
  effectiveCost30d: 1.2,
  projectedMonthlyCost: 1.5,
  positionSizeUsd: 10,
  costSource: 'PUBLIC_PRICE_ESTIMATE'
});
assert.strictEqual(tradeEconomics.infrastructure_cost_per_closed_trade_usd, 0.3);
assert.strictEqual(tradeEconomics.minimum_return_per_trade_to_cover_infrastructure_pct, 3);
assert.strictEqual(tradeEconomics.net_after_infrastructure_30d_usd, 1.8);

assert.strictEqual(safeBigQueryIdentifier('billing-project.dataset.gcp_billing_export_v1_*'), 'billing-project.dataset.gcp_billing_export_v1_*');
assert.throws(() => safeBigQueryIdentifier('dataset.table`; DROP TABLE x;--'), /INVALID_BILLING_EXPORT_TABLE/);

(async () => {
  const external = await loadBillingCost30d({
    actual_billing_30d_usd: 4.25,
    actual_billing_updated_at: new Date().toISOString()
  });
  assert.strictEqual(external.connected, true);
  assert.strictEqual(external.source, 'EXTERNAL_BILLING_VALUE');
  assert.strictEqual(external.cost_30d_usd, 4.25);

  const fallback = await loadBillingCost30d({ billing_export_enabled: false });
  assert.strictEqual(fallback.connected, false);
  assert.strictEqual(fallback.source, 'ESTIMATE');

  console.log('Spot cost governance tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
