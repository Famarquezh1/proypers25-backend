/**
 * Local Development Runner for Velas Prediction Cycle
 *
 * This script allows running the prediction cycle locally without deploying to Cloud Run.
 * It simulates the HTTP request environment and executes runPredictionCycle.
 *
 * Usage:
 *   npm run local:run
 *
 * This is ONLY for local development and debugging.
 * It does NOT modify production behavior or Cloud Run configuration.
 */

const { runPredictionCycle } = require('../tasks/velasScheduler');

async function runLocalPredictionCycle() {
  try {
    console.log('[LOCAL_RUN_START]', new Date().toISOString());
    console.log('[LOCAL_ENVIRONMENT]', {
      nodeVersion: process.version,
      nodeEnv: process.env.NODE_ENV || 'development',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: process.platform
    });

    // Execute the prediction cycle
    console.log('[LOCAL_RUN_EXECUTING] runPredictionCycle()');
    const result = await runPredictionCycle({
      cycleType: 'prediction_cycle',
      maxSymbols: process.env.LOCAL_MAX_SYMBOLS ? Number(process.env.LOCAL_MAX_SYMBOLS) : undefined,
      concurrency: process.env.LOCAL_CONCURRENCY ? Number(process.env.LOCAL_CONCURRENCY) : undefined,
      source: 'local',
      isManual: true
    });

    console.log('[LOCAL_RUN_COMPLETED]', {
      timestamp: new Date().toISOString(),
      result: result || 'undefined',
      status: 'success'
    });

  } catch (error) {
    console.error('[LOCAL_RUN_ERROR]', {
      timestamp: new Date().toISOString(),
      message: error?.message || 'Unknown error',
      stack: error?.stack || 'No stack trace',
      code: error?.code || 'unknown',
      status: 'failed'
    });
    process.exit(1);
  }
}

// Execute immediately
if (require.main === module) {
  console.log('[LOCAL_RUN_INIT] Initializing local prediction cycle runner...');
  console.log('[LOCAL_RUN_ENVIRONMENT]', {
    LOCAL_MAX_SYMBOLS: process.env.LOCAL_MAX_SYMBOLS || 'all',
    LOCAL_CONCURRENCY: process.env.LOCAL_CONCURRENCY || 'default'
  });

  runLocalPredictionCycle().then(() => {
    console.log('[LOCAL_RUN_EXIT] Process completed successfully');
    process.exit(0);
  }).catch((err) => {
    console.error('[LOCAL_RUN_EXIT_ERROR]', err);
    process.exit(1);
  });
}

module.exports = { runLocalPredictionCycle };
