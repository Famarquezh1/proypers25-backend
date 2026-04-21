# IMPULSE TRADING ENGINE - IMPLEMENTATION GUIDE

## Overview

Complete redesign of proypers25 trading system to detect REAL market impulses (≥0.5-1% moves) instead of micro-noise.

**Key Differences from Old System:**
- Old: Generated signals constantly, 44% accuracy, 0% profitable
- New: Generates signals ONLY on real impulses, conservative execution
- Old: Operated on 3-minute micro-moves
- New: Operates on 15+ minute impulses with 0.5-1% targets

---

## Architecture

### Phase 1-3: Signal Generation
- **impulseDetector.js**: Detects real impulses (4 strict criteria)
- **noiseFilter.js**: Blocks noisy signals (3 additional filters)
- **impulseSignalGenerator.js**: Generates IMPULSE type signals

### Phase 4-5: Execution & Exit Management
- **impulseExecutionEngine.js**: Market entry, TP/SL, Trailing stops

### Phase 6: Risk Management
- **impulseRiskManager.js**: Portfolio tracking, halt conditions

### Phase 7-9: Orchestration
- **impulseScheduler.js**: Main cycle orchestrator
- **impulseSchedulerRoute.js**: HTTP endpoint for Cloud Scheduler

---

## Impulse Detection Criteria (ALL must pass)

1. **5-minute move ≥ 0.5%**
   - `abs((price_5m_ago - price_now) / price_5m_ago) * 100 >= 0.5`

2. **1-minute velocity ≥ 0.2%**
   - `abs((price_1m_ago - price_now) / price_1m_ago) * 100 >= 0.2`

3. **Volume ≥ 1.5x average**
   - `current_volume / average_volume_last_20 >= 1.5`

4. **Continuity: ≥2 consecutive candles in same direction**
   - Must have 2+ candles trending same direction

**Result: VERY FEW signals** (quality over quantity)

---

## Noise Filter (Blocks if ANY condition hits)

1. **15-minute move < 0.4%**: Blocks insufficient moves
2. **Volatility < 0.15%**: Blocks dead markets
3. **Spread > 0.30%**: Blocks illiquid pairs

**Result: Only real impulses execute**

---

## Signal Quality

Confidence = 0.6 + (strength_score * 0.3)
- Range: 0.6 - 0.9
- Requires: confidence ≥ 0.65 to execute

---

## Exit Strategy

### Take Profit (TP)
- Range: +0.6% to +1.0%
- Random between min/max based on signal strength

### Stop Loss (SL)
- Range: -0.4% to -0.6%
- Random between min/max

### Trailing Stop
- Activates when: unrealized PnL ≥ +0.3%
- Follows price at minimal distance

---

## Risk Controls

### Position Size
- Initial: 0.25x (VERY conservative)
- After 20+ trades: Can increase to 0.5x

### Trade Limits
- Max 2 concurrent trades (global)
- Max 1 trade per symbol
- 10-minute cooldown per symbol

### Halt Conditions
- Daily loss ≥ -2%: Stop all trading
- 3+ consecutive losses: Stop all trading
- Portfolio issues: Automatic halt

---

## Execution Flow (Every 15 minutes)

1. **Log Portfolio Metrics**
   - Open trades, PnL, win rate
   - Check halt conditions

2. **Update Open Trades**
   - Check TP/SL hits
   - Update trailing stops
   - Close winners/losers

3. **Generate New Signals**
   - Detect impulses in 25 symbols
   - Filter noise
   - Create IMPULSE signals

4. **Execute Trades**
   - Market entry
   - Set TP/SL
   - Record metrics

---

## Database Schema

### Collection: `high_conviction_impulse_signals`
```javascript
{
  symbol: "BNBUSDT",
  signal_type: "IMPULSE",
  direction: "UP" | "DOWN",
  confidence: 0.7,
  strength_score: 0.65,
  expected_move: { min: 0.5, max: 1.2 },
  impulse_metrics: {
    move_5m: 0.75,
    velocity_1m: 0.32,
    volume_ratio: 2.1,
    continuity_candles: 3
  },
  noise_metrics: {
    move_15m: 0.52,
    volatility: 0.45,
    spread: 0.08
  },
  entry_price: 630.45,
  created_at: Timestamp,
  status: "PENDING_EXECUTION" | "EXECUTED"
}
```

### Collection: `active_impulse_trades`
```javascript
{
  trade_id: "IMPULSE_1234567890",
  symbol: "BNBUSDT",
  direction: "UP",
  entry_price: 630.45,
  entry_time: Timestamp,
  quantity: 1.0,
  confidence: 0.7,
  tp_price: 635.34,
  tp_target_pct: 0.78,
  sl_price: 626.55,
  sl_target_pct: -0.62,
  trailing_activated: false,
  status: "OPEN" | "CLOSED",
  pnl_pct: 0.45,
  reason_exit: "TP_HIT" | "SL_HIT" | "TRAILING",
  exit_time: Timestamp,
  exit_price: 635.40,
  duration_ms: 45000,
  created_at: Timestamp,
  closed_at: Timestamp
}
```

---

## Deployment Instructions

### Step 1: Build & Push Container

```bash
cd C:\Desarrollo\proypers25\backend
gcloud builds submit --config cloudbuild.yaml --project proypers2025
```

### Step 2: Deploy to Cloud Run

```bash
gcloud run deploy proypers25-backend \
  --image southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest \
  --region southamerica-west1 \
  --project proypers2025 \
  --allow-unauthenticated \
  --timeout 600 \
  --memory 2Gi
```

### Step 3: Update Traffic

```bash
gcloud run services update-traffic proypers25-backend \
  --to-revisions LATEST=100 \
  --region southamerica-west1 \
  --project proypers2025
```

### Step 4: Create Cloud Scheduler Job

```bash
gcloud scheduler jobs create http impulse-trading \
  --location southamerica-west1 \
  --schedule "*/15 * * * *" \
  --uri "https://proypers25-backend-southamerica-west1-<hash>.run.app/internal/cron/impulse/cycle" \
  --oidc-service-account-email "your-service-account@proypers2025.iam.gserviceaccount.com" \
  --oidc-token-audience "https://proypers25-backend-southamerica-west1-<hash>.run.app" \
  --headers "x-cron-secret=$CRON_SECRET" \
  --http-method POST \
  --project proypers2025
```

---

## Local Testing

### Test Impulse Detection
```bash
cd backend
node test_impulse_system.js
```

### Audit Trade Results
```bash
node audit_impulse_trades.js 20
```

---

## Success Criteria (Phase 10)

After 10-20 trades:

- **WIN_RATE ≥ 55%**: System is profitable
- **AVG_MOVE_CAPTURED ≥ 0.4%**: Catching sufficient moves
- Both criteria met = VIABLE for production

If criteria not met:
1. Review impulse detection thresholds
2. Check confidence calibration
3. Adjust TP/SL levels
4. Do NOT lower thresholds arbitrarily

---

## Environment Variables

```bash
CRON_SECRET=your-secret-key
GOOGLE_APPLICATION_CREDENTIALS=path-to-service-account-json
LEARNING_MODE=observe (do NOT set to deploy)
```

---

## Monitoring

### Metrics to Track
- Daily win rate
- Average PnL per trade
- Largest winning trade
- Largest losing trade
- Signals generated per day
- Signal execution rate

### Alerts
- Win rate drops below 50%
- Daily loss exceeds -2%
- System halts (check logs)

---

## Troubleshooting

### No signals generated
- Check if impulse thresholds are too strict
- Verify Binance API connectivity
- Check market volatility (might be low)

### High loss rate
- Confidence might be miscalibrated
- TP/SL levels might be off
- Check if noise filter is letting garbage through

### Trades executing but no PnL updates
- Check if exit monitoring is running
- Verify Firestore connectivity
- Check trade status updates

---

## Rollback Plan

If system performs poorly (win_rate < 40%):

1. Disable Cloud Scheduler job
2. Keep execution_enabled = false in Firestore
3. Investigate root cause
4. Do NOT re-enable until fixed

---

## Next Steps

1. Build and deploy to Cloud Run
2. Create Cloud Scheduler job
3. Wait for first 10 trades
4. Run audit report
5. Assess viability
6. Scale or refine based on results

**Target**: Viable, profitable system operating with REAL edge, not noise.
