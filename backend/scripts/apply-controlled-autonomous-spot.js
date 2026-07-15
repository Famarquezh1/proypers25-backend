'use strict';

const db = require('../firebase-admin-config');

const EXPECTED_CONFIRMATION = 'ACTIVAR_SPOT_CONTROLADO';

async function main() {
  const confirmation = String(process.env.CONFIRM_AUTONOMOUS_SPOT || '');
  if (confirmation !== EXPECTED_CONFIRMATION) {
    throw new Error(`Confirmation required: set CONFIRM_AUTONOMOUS_SPOT=${EXPECTED_CONFIRMATION}`);
  }

  const controlRef = db.collection('real_spot_config').doc('control');
  const current = await controlRef.get();
  const currentData = current.exists ? current.data() : {};

  const safeConfig = {
    enabled: true,
    kill_switch: false,
    mode: 'REAL_SPOT_CONTROLLED_V1',
    new_entries_enabled: true,
    real_sells_enabled: true,
    auto_order_execution: true,
    spot_only: true,
    futures_allowed: false,
    margin_allowed: false,
    leverage_allowed: false,
    withdrawals_allowed: false,
    max_position_usdt: 10,
    max_total_capital_usdt: 10,
    max_open_positions: 1,
    autonomy_enabled: true,
    autonomy_stage: 'CONTROLLED_10_USDT',
    adaptive_position_usdt: 10,
    activation_source: 'github_actions_manual_confirmation',
    activated_at: new Date().toISOString(),
    previous_safety_state: {
      enabled: currentData.enabled === true,
      kill_switch: currentData.kill_switch === true,
      max_position_usdt: Number(currentData.max_position_usdt || 0),
      max_total_capital_usdt: Number(currentData.max_total_capital_usdt || 0),
      max_open_positions: Number(currentData.max_open_positions || 0)
    }
  };

  await controlRef.set(safeConfig, { merge: true });

  console.log(JSON.stringify({
    ok: true,
    path: 'real_spot_config/control',
    applied: {
      enabled: true,
      kill_switch: false,
      new_entries_enabled: true,
      real_sells_enabled: true,
      auto_order_execution: true,
      spot_only: true,
      max_position_usdt: 10,
      max_total_capital_usdt: 10,
      max_open_positions: 1
    }
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[AUTONOMOUS_SPOT_ACTIVATION] Failed:', error.message);
    process.exit(1);
  });
