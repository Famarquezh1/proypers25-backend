'use strict';

const db = require('../firebase-admin-config');
const {
  runSpotPaperExecutionCycle,
  getSpotPaperExecutionDiagnostic
} = require('../services/binanceSpotPaperExecutor');

async function main() {
  const result = await runSpotPaperExecutionCycle(db, {
    maxDocs: 250,
    now: new Date(),
    real_execution: false,
    enableRealTrading: false,
    usePrivateBinanceApi: false,
    signedRequest: false
  });

  const diagnostic = await getSpotPaperExecutionDiagnostic(db, { maxDocs: 250 });

  console.log(JSON.stringify({
    ok: true,
    paper_only: true,
    no_real_orders: true,
    generated_at: new Date().toISOString(),
    latest_scan_id: result.latest_scan_id || null,
    positions_closed: Number(result.positions_closed || 0),
    intents_created: Number(result.intents_created || 0),
    intents_rejected: Number(result.intents_rejected || 0),
    opened_symbols: Array.isArray(result.opened_symbols) ? result.opened_symbols : [],
    diagnostic
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[SPOT_PAPER_VALIDATION_RUNNER] Failed:', error.message);
    process.exit(1);
  });
