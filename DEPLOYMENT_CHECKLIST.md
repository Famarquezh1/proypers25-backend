# IMPULSE TRADING ENGINE - DEPLOYMENT CHECKLIST

## Code Components ✓

- [x] impulseDetector.js - Impulse detection logic
- [x] noiseFilter.js - Noise filtering
- [x] impulseSignalGenerator.js - Signal generation
- [x] impulseExecutionEngine.js - Trade execution + exit management
- [x] impulseRiskManager.js - Risk controls
- [x] impulseScheduler.js - Main orchestrator
- [x] impulseSchedulerRoute.js - HTTP endpoints
- [x] server.js - Updated with new routes
- [x] test_impulse_system.js - Local testing script
- [x] audit_impulse_trades.js - Performance audit script

## Pre-Deployment Checklist

### Code Quality
- [ ] All files created successfully
- [ ] No syntax errors in services
- [ ] All imports resolve correctly
- [ ] Error handling present in all async operations

### Firebase Firestore
- [ ] Firestore collections created:
  - `high_conviction_impulse_signals`
  - `active_impulse_trades`
- [ ] Firestore security rules configured
- [ ] Service account has write permissions

### Environment Configuration
- [ ] CRON_SECRET set in environment
- [ ] GOOGLE_APPLICATION_CREDENTIALS points to valid service account
- [ ] Cloud Run project ID is correct
- [ ] Region set to southamerica-west1

### Local Testing
- [ ] Run: `node test_impulse_system.js`
- [ ] Verify impulse detection works
- [ ] Verify noise filter works
- [ ] Verify signal generation works
- [ ] No connection errors to Binance API

### Build & Deployment
- [ ] cloudbuild.yaml exists and is correct
- [ ] Dockerfile updated (if needed)
- [ ] All npm dependencies installed: `npm install axios`
- [ ] Test local build: `docker build -t impulse-test .`

## Deployment Steps

### 1. Build Container
```bash
cd C:\Desarrollo\proypers25\backend
gcloud builds submit --config cloudbuild.yaml --project proypers2025
```
- [ ] Build completes successfully
- [ ] Image pushed to registry

### 2. Deploy to Cloud Run
```bash
gcloud run deploy proypers25-backend \
  --image southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest \
  --region southamerica-west1 \
  --project proypers2025 \
  --allow-unauthenticated \
  --timeout 600 \
  --memory 2Gi
```
- [ ] Deployment succeeds
- [ ] Health check endpoint responds
- [ ] Record new service URL

### 3. Update Traffic
```bash
gcloud run services update-traffic proypers25-backend \
  --to-revisions LATEST=100 \
  --region southamerica-west1 \
  --project proypers2025
```
- [ ] Traffic 100% routed to LATEST

### 4. Verify Endpoints
Test these endpoints manually:
- [ ] GET /internal/health/impulse → 200 OK
- [ ] POST /internal/cron/impulse/cycle (with CRON_SECRET header) → 202 Accepted

### 5. Create Cloud Scheduler Job

Get the service URL first:
```bash
gcloud run services describe proypers25-backend --region southamerica-west1 --project proypers2025
```

Create the job:
```bash
gcloud scheduler jobs create http impulse-trading \
  --location southamerica-west1 \
  --schedule "*/15 * * * *" \
  --uri "https://[SERVICE_URL]/internal/cron/impulse/cycle" \
  --oidc-service-account-email "your-service-account@proypers2025.iam.gserviceaccount.com" \
  --oidc-token-audience "https://[SERVICE_URL]" \
  --headers "x-cron-secret=$CRON_SECRET" \
  --http-method POST \
  --project proypers2025
```
- [ ] Scheduler job created
- [ ] Schedule is "*/15 * * * *" (every 15 minutes)

### 6. Enable Scheduler Job
```bash
gcloud scheduler jobs update http impulse-trading \
  --location southamerica-west1 \
  --project proypers2025 \
  --resume
```
- [ ] Job enabled and running

## Post-Deployment Configuration

### Firestore Setup
Create/update system configuration:
```javascript
db.collection('system_runtime_config').doc('impulse_trading').set({
  execution_enabled: true,
  position_size_percent: 0.25,
  risk_level: 'CONSERVATIVE',
  max_concurrent_trades: 2,
  max_daily_loss_percent: -2,
  status: 'ACTIVE',
  enabled_at: admin.firestore.FieldValue.serverTimestamp()
});
```
- [ ] Configuration document created in Firestore

## Monitoring Setup

### View Logs
```bash
gcloud run logs read proypers25-backend --region southamerica-west1 --project proypers2025 --limit 100
```
- [ ] Logs visible in Cloud Run console
- [ ] Check for [IMPULSE_CYCLE] entries

### Cloud Monitoring
- [ ] Create alert for error rate > 5%
- [ ] Create alert for no executions in 30 minutes
- [ ] Create alert for memory usage > 1.5Gi

## Initial Execution

### Wait for First Cycle
- [ ] Scheduler job fires after 15 minutes
- [ ] Check logs for [IMPULSE_CYCLE] message
- [ ] If no signals: market might be quiet (normal)
- [ ] If signals: check audit after 10 trades

### Collection Verification
Check Firestore collections:
- [ ] high_conviction_impulse_signals has documents
- [ ] active_impulse_trades has documents (if signals executed)

### Run Audit After 10 Trades
```bash
cd backend
node audit_impulse_trades.js 10
```
- [ ] Audit completes without errors
- [ ] Check win_rate and avg_move_captured
- [ ] Compare against success criteria

## Success Criteria Check

After 10+ trades, verify:
- [ ] WIN_RATE ≥ 55%
- [ ] AVG_MOVE_CAPTURED ≥ 0.4%

If YES:
- [x] System is VIABLE
- [x] Continue monitoring
- [x] After 20+ trades, can increase position_size to 0.5x

If NO:
- [ ] HALT trading (disable Cloud Scheduler)
- [ ] Investigate failure mode
- [ ] Review impulse thresholds
- [ ] Fix and redeploy before resuming

## Rollback Procedure

If system fails criteria:

1. Disable scheduler:
```bash
gcloud scheduler jobs pause impulse-trading \
  --location southamerica-west1 \
  --project proypers2025
```

2. Disable execution in Firestore:
```javascript
db.collection('system_runtime_config').doc('impulse_trading').update({
  execution_enabled: false,
  status: 'HALTED',
  reason: 'Performance below viability threshold'
});
```

3. Investigate logs and metrics
4. Fix code if needed
5. Redeploy after fixes
6. Re-enable scheduler only after verification

## Maintenance

### Daily Checks
- [ ] Check Firestore collections have recent documents
- [ ] Verify win rate in Cloud Logs
- [ ] Monitor PnL trend

### Weekly Checks
- [ ] Run full audit: `node audit_impulse_trades.js 50`
- [ ] Compare metrics to baseline
- [ ] Check for any anomalies

### Monthly Actions
- [ ] Review all closed trades
- [ ] Identify patterns in winning/losing trades
- [ ] Adjust thresholds if needed (conservative changes only)
- [ ] Update documentation with learnings

## Critical Notes

1. **DO NOT modify old prediccionVelas.js** - Keep both systems separate
2. **Conservative position sizing** - Start at 0.25x, never exceed 1x without data
3. **Never lower thresholds arbitrarily** - Only adjust after analysis
4. **Keep detailed audit trail** - Save all reports for review
5. **Default to HALT over execute** - Risk management priority

---

## Final Sign-Off

- [ ] All components built
- [ ] Deployment complete
- [ ] Initial cycle executed
- [ ] Audit report generated
- [ ] Viability criteria assessed
- [ ] Decision made: PROCEED or HALT

**Status**: READY FOR DEPLOYMENT ✓
