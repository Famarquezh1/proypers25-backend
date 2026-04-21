/**
 * IMPULSE TRADING SCHEDULER
 *
 * Orquesta el sistema completo:
 * 1. Detecta impulsos
 * 2. Filtra ruido
 * 3. Genera señales
 * 4. Ejecuta trades
 * 5. Gestiona riesgo
 *
 * Se ejecuta cada 15 minutos via Cloud Scheduler
 */

const admin = require('firebase-admin');
const { generateImpulseSignals } = require('./services/impulseSignalGenerator');
const { processImpulseSignals, updateOpenTrades } = require('./services/impulseExecutionEngine');
const { logRiskMetrics, validateTrade } = require('./services/impulseRiskManager');

const db = admin.firestore();

// List of symbols to monitor (25 major pairs)
const SYMBOLS = [
  'BNBUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'LITUSDT', 'BCUSDT', 'MATICUSDT', 'AVAXUSDT',
  'LINKUSDT', 'UNIUSDT', 'SUSHIUSDT', 'AAVEUSDT', 'CRVUSDT',
  'COMPUSDT', 'YEFIUSDT', 'SNXUSDT', 'ZECUSDT', 'ALGOUSDT',
  'GTUSDT', 'THETAUSDT', 'FILUSDT', 'AXSUSDT', 'SANDUSDT'
];

/**
 * Main impulse cycle
 */
async function runImpulseCycle() {
  const cycleStartTime = Date.now();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`[IMPULSE_CYCLE] Starting at ${new Date().toISOString()}`);
  console.log(`${'='.repeat(70)}`);

  try {
    // Step 1: Log current risk metrics
    console.log(`\n[STEP_1] Portfolio Status`);
    await logRiskMetrics();

    // Step 2: Update open trades (check TP/SL/Trailing)
    console.log(`\n[STEP_2] Updating Open Trades`);
    const closedTrades = await updateOpenTrades();
    console.log(`[STEP_2] Closed trades: ${closedTrades.length}`);

    // Step 3: Generate impulse signals
    console.log(`\n[STEP_3] Detecting Impulses`);
    const signals = await generateImpulseSignals(SYMBOLS);
    console.log(`[STEP_3] Impulse signals generated: ${signals.length}`);

    if (signals.length === 0) {
      console.log(`[IMPULSE_CYCLE] No impulses detected in this cycle`);
      return {
        timestamp: cycleStartTime,
        signals_generated: 0,
        trades_executed: 0,
        trades_closed: 0,
        duration_ms: Date.now() - cycleStartTime
      };
    }

    // Step 4: Process signals (execute trades)
    console.log(`\n[STEP_4] Processing Signals`);
    const executedTrades = await processImpulseSignals();
    console.log(`[STEP_4] Trades executed: ${executedTrades.length}`);

    const cycleDuration = Date.now() - cycleStartTime;
    console.log(`\n[IMPULSE_CYCLE] Completed in ${cycleDuration}ms`);
    console.log(`${'='.repeat(70)}\n`);

    return {
      timestamp: cycleStartTime,
      signals_generated: signals.length,
      trades_executed: executedTrades.length,
      trades_closed: closedTrades.length,
      duration_ms: cycleDuration
    };

  } catch (error) {
    console.error(`[IMPULSE_CYCLE] ERROR:`, error.message);
    console.error(error);

    return {
      timestamp: cycleStartTime,
      error: error.message,
      duration_ms: Date.now() - cycleStartTime
    };
  }
}

/**
 * HTTP endpoint for Cloud Scheduler
 */
async function handleSchedulerRequest(req, res) {
  try {
    console.log(`[SCHEDULER] Request received from Cloud Scheduler`);

    const result = await runImpulseCycle();

    res.status(200).json({
      status: 'success',
      cycle_result: result
    });

  } catch (error) {
    console.error(`[SCHEDULER] Error:`, error.message);

    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
}

module.exports = {
  runImpulseCycle,
  handleSchedulerRequest
};
