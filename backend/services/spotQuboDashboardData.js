'use strict';

const db = require('../firebase-admin-config');

const SHADOW_COLLECTION = 'spot_qubo_shadow_decisions';
const STATUS_COLLECTION = 'spot_qubo_optimizer_status';

async function getSpotQuboDashboardData() {
  const [statusDoc, decisionsSnapshot] = await Promise.all([
    db.collection(STATUS_COLLECTION).doc('current').get(),
    db.collection(SHADOW_COLLECTION).orderBy('created_at', 'desc').limit(30).get()
  ]);

  const decisions = decisionsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const latest = decisions[0] || null;
  const settled = decisions.filter((item) => item.status === 'SETTLED' && item.outcome);

  const latestOutcome = settled[0]?.outcome || null;

  return {
    ok: true,
    mode: 'SHADOW_ONLY',
    real_execution_enabled: false,
    no_order_created: true,
    external_credentials_required: false,
    paid_quantum_service_required: false,
    status: statusDoc.exists ? statusDoc.data() : null,
    latest,
    latest_outcome: latestOutcome,
    recent: decisions.slice(0, 10),
    sample_counts: {
      total: decisions.length,
      open: decisions.filter((item) => item.status === 'OPEN').length,
      settled: settled.length
    },
    generated_at: new Date().toISOString()
  };
}

module.exports = { getSpotQuboDashboardData };
