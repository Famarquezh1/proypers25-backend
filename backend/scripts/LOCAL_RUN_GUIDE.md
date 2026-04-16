# Local Prediction Cycle Runner

## Overview

The `localRun.js` script allows you to execute the Velas prediction cycle locally without deploying to Cloud Run. This enables:

- **Fast debugging** - test changes in seconds instead of waiting for 18-minute builds
- **Direct console output** - see all debug logs immediately
- **Quick iteration** - perfect for testing timeout fixes and signal flow

## Prerequisites

1. **Node.js** installed locally
2. **Backend dependencies** installed:
   ```bash
   cd backend
   npm install
   ```
3. **Firebase credentials** - the script uses the existing `firebase-admin-config.js` authentication

## Usage

### Quick Start

From the `backend/` directory:

```bash
npm run local:run
```

### With Environment Options

Control the prediction cycle parameters:

```bash
# Limit to 3 symbols for quick testing
LOCAL_MAX_SYMBOLS=3 npm run local:run

# Control concurrency (default is based on SCAN_CONCURRENCY from env)
LOCAL_CONCURRENCY=2 npm run local:run

# Combine options
LOCAL_MAX_SYMBOLS=5 LOCAL_CONCURRENCY=3 npm run local:run
```

## Debug Output

The script produces the following log hierarchy:

### Startup Logs
```
[LOCAL_RUN_INIT] Initializing local prediction cycle runner...
[LOCAL_RUN_ENVIRONMENT] Configuration parameters
[LOCAL_RUN_START] Cycle initiated with timestamp
[LOCAL_ENVIRONMENT] Node.js environment details
```

### Execution Logs

For each symbol being processed:
```
[DEBUG_FETCH_CANDLES] Binance candle fetching
[DEBUG_AFTER_FETCH_CANDLES_CALL] Fetch result status
[DEBUG_SKIP_REASON] (if signal is skipped) exact reason
[DEBUG_BEFORE_QUALITY_GATE] Pre-gate metrics (confidence, quantum, timing)
[DEBUG_QUALITY_GATE_RESULTS] Gate pass/fail decisions
[DEBUG_SIGNAL_EMITTED_AFTER_GATES] Final signal emission decision
[DEBUG_BEFORE_RETURN] Final state summary
```

### Completion Logs
```
[LOCAL_RUN_COMPLETED] Success with timestamp
[LOCAL_RUN_EXIT] Process exit

OR

[LOCAL_RUN_ERROR] Failed with error details
[LOCAL_RUN_EXIT_ERROR] Exit with error code
```

## What It Executes

```
npm run local:run
        ↓
localRun.js
        ↓
runPredictionCycle() from velasScheduler.js
        ↓
For each symbol: prediccionVelas()
        ↓
Fetch candles (12000ms timeout)
        ↓
Extract spot price
        ↓
Calculate confidence/quantum/timing
        ↓
Quality gates evaluation
        ↓
Signal emission decision
        ↓
Save prediction to Firestore (if signal emitted)
```

## Real-Time Analysis

While the script runs, you can search logs for:

- **Timeout issues**: Search for `DEBUG_TIMEOUT_APPLIED`
- **Fetch failures**: Search for `DEBUG_FETCH_CANDLES_FAILED`
- **Skipped signals**: Search for `DEBUG_SKIP_REASON`
- **Gate decisions**: Search for `DEBUG_QUALITY_GATE_RESULTS`
- **Low confidence**: Search for `low_confidence_penalty`
- **Context filter blocks**: Search for `event_context_filter_enforce`

## What It Does NOT Do

- ❌ Deploy to Cloud Run
- ❌ Modify production code or config
- ❌ Require CRON_SECRET validation
- ❌ Use Cloud Run environment
- ❌ Publish to Cloud Logging (logs are printed locally only)

## Troubleshooting

### Error: "Cannot find module 'firebase-admin-config'"

The script runs from `backend/` directory context. Make sure you're running from the backend directory:

```bash
cd backend
npm run local:run
```

### Error: Firebase credentials not found

Ensure you have valid Firebase service account credentials in `backend/serviceAccountKey.json` or proper `FIREBASE_*` environment variables set.

### Slow startup or timeout errors

If individual symbols take >30 seconds, it indicates:
- Binance API is slow or rate-limited
- Network latency issues
- Try with fewer symbols:
  ```bash
  LOCAL_MAX_SYMBOLS=1 npm run local:run
  ```

### No signals emitted

If you see `DEBUG_SKIP_REASON` logs with:
- `low_confidence_penalty` - confidence score is too low
- `event_context_filter_enforce` - event context filter is blocking
- `quality_gate` - pre-learning quality gate failed

This is expected behavior during market conditions. Check the scores in `DEBUG_BEFORE_QUALITY_GATE` logs.

## Integration with Development Workflow

1. **Make code changes** in files like `prediccionVelas.js`
2. **Run locally** to test immediately:
   ```bash
   npm run local:run
   ```
3. **Check logs** for issues
4. **Iterate** - no rebuild needed
5. **Deploy** only after local validation

## File Locations

| File | Purpose |
|------|---------|
| `backend/scripts/localRun.js` | Local runner entry point |
| `backend/tasks/velasScheduler.js` | Prediction cycle logic |
| `backend/scripts/prediccionVelas.js` | Individual prediction engine |
| `backend/routes/velasCron.js` | HTTP endpoint definition |

## Notes

- The local runner executes the **exact same logic** as the Cloud Run endpoint
- It uses the **same configuration and timeouts**
- All changes made locally appear in logs immediately
- Perfect for validating timeout fixes, signal flow, and debug output
