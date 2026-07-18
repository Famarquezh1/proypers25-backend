'use strict';

const assert = require('assert');
const {
  estimateCloudRunCost,
  estimateGitHubActionsCost,
  buildMonthlyEstimate,
  economicDecision
} = require('../services/spotCostGovernance');

const cloudRun = estimateCloudRunCost(100, 10);
assert(cloudRun.total_usd > 0);
assert(cloudRun.total_usd < 1);

const publicActions = estimateGitHubActionsCost(5000, { repositoryPublic: true });
assert.strictEqual(publicActions.total_usd, 0);

const privateFreeActions = estimateGitHubActionsCost(2500, { repositoryPublic: false, githubPlan: 'FREE' });
assert.strictEqual(privateFreeActions.billable_minutes, 500);
assert.strictEqual(privateFreeActions.total_usd, 3);

const estimate = buildMonthlyEstimate({
  repositoryPublic: false,
  githubPlan: 'FREE',
  discoveryEveryMinutes: 30,
  adaptiveEveryMinutes: 60,
  quantEveryMinutes: 120,
  githubMinutesPerRun: 1
});
assert.strictEqual(estimate.assumptions.github_job_consolidated, true);
assert.strictEqual(estimate.github_actions.total_minutes, 1440);
assert.strictEqual(estimate.github_actions.total_usd, 0);

const normal = economicDecision({
  realizedPnl30d: 20,
  projectedMonthlyCost: 2,
  monthlyBudgetUsd: 10,
  maxCostSharePct: 25
});
assert.strictEqual(normal.mode, 'NORMAL');
assert.strictEqual(normal.projected_net_after_infrastructure_usd, 18);

const economy = economicDecision({
  realizedPnl30d: 20,
  projectedMonthlyCost: 8,
  monthlyBudgetUsd: 10,
  maxCostSharePct: 25
});
assert.strictEqual(economy.mode, 'ECONOMY');
assert.strictEqual(economy.research_frequency_multiplier, 2);
assert.strictEqual(economy.real_exits_never_paused, true);

console.log('Spot cost governance tests passed');
