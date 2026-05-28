#!/usr/bin/env node

const { FieldValue } = require('firebase-admin/firestore');
const db = require('../firebase-admin-config');
const { getExecutionHaltDiagnostic } = require('../lib/executionHaltDiagnostic');

const MANUAL_RESET_REASON = 'halt_stale_safe_to_resume';

function formatValue(value) {
  return value == null ? 'null' : value;
}

async function main() {
  const report = await getExecutionHaltDiagnostic(db);

  console.log('=== EXECUTION HALT PRECHECK ===');
  console.log(`runtime_status: ${formatValue(report.runtime_status)}`);
  console.log(`halted_reason: ${formatValue(report.halted_reason)}`);
  console.log(`diagnosis: ${formatValue(report.diagnosis)}`);
  console.log(`safe_to_resume_boolean: ${formatValue(report.reset_requirements?.safe_to_resume_boolean)}`);
  console.log(`requires_manual_reset: ${formatValue(report.reset_requirements?.requires_manual_reset)}`);

  if (report.diagnosis !== 'halt_stale' || report.reset_requirements?.safe_to_resume_boolean !== true) {
    console.error('\nABORTED: preconditions not met for controlled reset.');
    console.error(`- diagnosis must be "halt_stale", got: ${formatValue(report.diagnosis)}`);
    console.error(
      `- safe_to_resume_boolean must be true, got: ${formatValue(report.reset_requirements?.safe_to_resume_boolean)}`
    );
    process.exit(1);
  }

  const runtimeRef = db.collection('system_runtime_config').doc('bot_execution');
  const botConfigRef = db.collection('binance_bot_config').doc('global');

  await Promise.all([
    runtimeRef.set({
      execution_enabled: true,
      auto_trade_mode: true,
      status: 'ACTIVE',
      runtime_status: 'ACTIVE',
      halted_reason: null,
      runtime_halted_reason: null,
      halted_at: null,
      halt_source: null,
      manual_reset_at: FieldValue.serverTimestamp(),
      manual_reset_reason: MANUAL_RESET_REASON,
      max_concurrent_trades: 1,
      consecutive_losses: {
        current_count: 0,
        last_loss_ts: null,
        symbols_involved: [],
        origins_involved: []
      },
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true }),
    botConfigRef.set({
      execution_enabled: true,
      max_concurrent_trades: 1,
      updated_at: new Date().toISOString()
    }, { merge: true })
  ]);

  const runtimeSnap = await runtimeRef.get();
  const runtimeData = runtimeSnap.exists ? (runtimeSnap.data() || {}) : {};

  console.log('\n=== EXECUTION RUNTIME RESET APPLIED ===');
  console.log(`execution_enabled: ${formatValue(runtimeData.execution_enabled)}`);
  console.log(`auto_trade_mode: ${formatValue(runtimeData.auto_trade_mode)}`);
  console.log(`runtime_status: ${formatValue(runtimeData.runtime_status || runtimeData.status)}`);
  console.log(`runtime_halted_reason: ${formatValue(runtimeData.runtime_halted_reason || runtimeData.halted_reason)}`);
  console.log(`max_concurrent_trades: ${formatValue(runtimeData.max_concurrent_trades)}`);
}

main().catch((error) => {
  console.error('\nRESET_FAILED:', error?.message || error);
  process.exit(1);
});
