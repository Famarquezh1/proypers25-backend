# Proypers25 Critical Safety Monitor - Operational Runbook
## Extra Phases 1-7 Monitoring & Response Guide

**System**: Proypers25 Binance Futures Trading (Live Production)
**Safety Layer**: Critical Safety Monitor (Extra Phases 1-7)
**Deployment**: Cloud Run (southamerica-west1)
**Database**: Firestore (Firebase)

---

## Dashboard Monitoring

### Real-Time Visibility (3 API Endpoints)

#### 1. Critical Alerts Dashboard
```bash
# Command
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/critical-alerts?limit=20" | jq '.'

# Expected Response (Healthy System)
{
  "timestamp": "2026-04-19T03:00:00Z",
  "alerts": [],
  "total_count": 0
}

# Interpretation
- Empty alerts [] = Healthy system
- If alerts present, read severity (critical/high/info)
- Critical alerts require immediate investigation
```

#### 2. System Heartbeat Monitor
```bash
# Command
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/heartbeats?limit=20" | jq '.heartbeats[] | {timestamp, system_state, signals_last_5m, is_healthy}'

# Expected Pattern (every 5 minutes)
2026-04-19T03:00:00Z  healthy  15  true
2026-04-19T02:55:00Z  healthy  12  true
2026-04-19T02:50:00Z  healthy  18  true
2026-04-19T02:45:00Z  healthy  14  true

# RED FLAG: Gap > 10 minutes = System down/offline
```

#### 3. Safety Status Check
```bash
# Command
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/safety-status" | jq '.all_phases_active'

# Expected: true (all 7 phases active)
# If false: Emergency - Some phases disabled
```

---

## Alert Types & Response Matrix

### SYSTEM_IDLE_ALERT (Critical)
**Trigger**: No signals + no intents for 10 minutes (with data available)

**Response Steps**:
1. Check Firestore: `critical_safety_alerts` collection for details
2. Review signal generation:
   ```sql
   Query: SELECT * FROM symbol_runtime_metrics ORDER BY timestamp DESC LIMIT 10
   Look for: signals_emitted = 0 across 10-minute window
   ```
3. Possible causes:
   - Signal generation engine crashed
   - All symbols filtered out (no qualifying trades)
   - ML models not producing signals
4. Action:
   - Check backend logs: `gcloud run logs read proypers25-backend --limit 100`
   - Restart autocalibration cycle if needed
   - Verify signal generation thresholds in `system_runtime_config`

---

### EXECUTION_BLOCK_ALERT (High)
**Trigger**: Intents created but 0 executions for 5+ minutes

**Response Steps**:
1. This alert indicates **signals are generated but not executing**
2. Check Binance connection:
   ```bash
   # Test API connectivity
   curl -s "https://fapi.binance.com/fapi/v1/ping" 
   # Expected: {} (empty object)
   ```
3. Check execution engine logs for Binance errors
4. Possible causes:
   - Binance API rate limits hit
   - WebSocket connection lost
   - Insufficient account margin
   - Order validation failures
5. Action:
   - Manually verify Binance account health on exchange
   - Check `/api/system/deep-health` for Binance connection status
   - If persistent, may need manual execution or pause for investigation

---

### DATA_FEED_DOWN_ALERT (Critical)
**Trigger**: fetched_symbols = 0 during market hours

**Response Steps**:
1. Immediate action: **Calibration cannot proceed without data**
2. System auto-pauses to prevent bad decisions
3. Check data sources:
   - Primary: Binance USDT symbols
   - Fallback: Yahoo Finance
   - Cache: 60-second local cache
4. Troubleshooting:
   ```bash
   # Test Binance data availability
   curl -s "https://fapi.binance.com/fapi/v1/exchangeInfo" | jq '.symbols | length'
   # Should be > 0
   ```
5. Action:
   - Wait 1-2 minutes for data feed recovery (automatic retry)
   - If persists > 5 minutes: Check internet connectivity
   - May indicate market-wide data service issues

---

### SAFE_MODE_ACTIVATED (High)
**Trigger**: Winrate <30% OR SL ratio >70% for 10+ minutes

**What Happens**:
- Execution paused automatically for 10 minutes
- No new orders created during pause
- System continues monitoring
- Automatically resumes after 10 minutes if metrics improve

**Response Steps**:
1. Check trading metrics:
   ```sql
   SELECT 
     COUNT(*) as closed_trades,
     SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / COUNT(*) as winrate,
     SUM(CASE WHEN hit_stop_loss THEN 1 ELSE 0 END) / COUNT(*) as sl_ratio
   FROM closed_trades 
   WHERE timestamp > NOW() - INTERVAL 10 MINUTE
   ```
2. Analyze recent performance:
   - Why is winrate low?
   - Are SL hits due to market volatility or bad timing?
   - Is calibration producing bad parameters?
3. Action Options:
   - **Wait 10 minutes**: Let system auto-resume and monitor
   - **Manual pause**: Set `pause_execution=false` in config if metrics improve
   - **Recalibrate**: Manually adjust confidence thresholds in `trading_params_live`

---

### SYSTEM_HEARTBEAT (Info)
**Occurs**: Every 5 minutes automatically

**What It Contains**:
```json
{
  "system_state": "healthy|degraded|stalled|paused",
  "signals_last_5m": 15,        // Proof of signal generation
  "executions_last_5m": 12,     // Proof of execution
  "winrate": 0.667,              // Current performance
  "data_status": "ok|down",      // Data feed status
  "calibration_active": true,    // Not in pause mode
  "is_healthy": true             // Overall health flag
}
```

**How to Use**:
- Healthy heartbeat = System operating normally
- Missing heartbeat (gap > 10 min) = System down/offline
- Monitor via dashboard: `GET /api/system/heartbeats`

---

## Emergency Procedures

### Alert #1: Multiple Critical Alerts in 5 Minutes
**Action**: System may be in cascade failure

```bash
# 1. Get all recent alerts
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/critical-alerts?limit=50" | jq '.alerts[] | select(.severity=="critical")'

# 2. Count alerts by type in last 5 minutes
gcloud firestore documents list --collection-ids=critical_safety_alerts --page-size=100

# 3. Check system logs
gcloud run logs read proypers25-backend --limit 200 --format json | jq '.severity="ERROR"'

# 4. If cascading: PAUSE EXECUTION IMMEDIATELY
gsutil cp -  gs://proypers2025_system_config/trading_params_live.json << EOF
{"pause_execution": true, "pause_reason": "cascade_failure_detected"}
EOF
```

### Alert #2: Heartbeat Gap > 10 Minutes
**Meaning**: System has stopped sending updates

```bash
# 1. Check if service is running
gcloud run services describe proypers25-backend --region southamerica-west1 --format='value(status.ingress)'

# 2. If ingress problem, restart service
gcloud run services update proypers25-backend --region southamerica-west1

# 3. Get latest revision status
gcloud run revisions list --service=proypers25-backend --region=southamerica-west1 --limit=5
```

### Alert #3: Sustained SAFE_MODE_ACTIVATED (>30 min)
**Meaning**: Trading conditions very poor

```bash
# 1. Review hourly performance
SELECT 
  DATE_TRUNC(timestamp, HOUR) as hour,
  COUNT(*) as trades,
  SUM(pnl) as hourly_pnl,
  AVG(pnl) as avg_pnl
FROM closed_trades 
WHERE timestamp > NOW() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour DESC

# 2. Options:
#    A) Continue pause and monitor (system auto-resumes)
#    B) Manually recalibrate with conservative thresholds
#    C) Pause all trading (pause_execution=true, permanent)
```

---

## Monitoring Schedule

### Every 5 Minutes (Automated)
- Heartbeat logged to Firestore
- System state evaluated
- All 7 phases check in sequence

### Every Hour (Manual Check)
```bash
# Get latest status
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/safety-status" | jq '.phases | to_entries[] | {phase: .key, active: .value.active, triggered_24h: .value.triggered_count_24h}'

# Check for any critical alerts
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/critical-alerts?limit=5" | jq '.alerts[] | select(.severity=="critical")'
```

### Every Day (Daily Review)
```bash
# Get full 24-hour summary
gcloud firestore documents list --collection-ids=critical_safety_alerts --page-size=1000 | grep -E '"eventType"|"severity"'

# Analyze trading performance
SELECT 
  DATE(timestamp) as date,
  COUNT(*) as total_trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / COUNT(*) as daily_winrate,
  SUM(pnl) as daily_pnl,
  MAX(pnl) as best_trade,
  MIN(pnl) as worst_trade
FROM closed_trades
WHERE timestamp > NOW() - INTERVAL 30 DAY
GROUP BY date
```

---

## Configuration Adjustments

### Adjust Inactivity Detection Window
**File**: `backend/lib/critical_safety_monitor.js`
```javascript
// Change from 10 minutes to 15 minutes
const INACTIVITY_WINDOW_MS = 15 * 60 * 1000;
```

### Adjust Execution Block Window
**File**: `backend/lib/critical_safety_monitor.js`
```javascript
// Change from 5 minutes to 3 minutes
const EXECUTION_BLOCK_WINDOW_MS = 3 * 60 * 1000;
```

### Adjust Safe-Mode Thresholds
**File**: `backend/lib/critical_safety_monitor.js`
```javascript
// Current: winrate <30% triggers safe mode
// Change to 40%:
const WINRATE_THRESHOLD = 0.40;

// Current: SL ratio >70% triggers safe mode
// Change to 60%:
const SL_HIT_RATIO_THRESHOLD = 0.60;
```

### Adjust Safe-Mode Pause Duration
**File**: `backend/lib/critical_safety_monitor.js`
```javascript
// Current: 10 minutes
// Change to 15 minutes:
const safeModeDuration = 15 * 60 * 1000;
```

---

## Troubleshooting Decision Tree

```
ALERT TRIGGERED?
├─ No → Continue normal operations ✓
└─ Yes
   ├─ SYSTEM_IDLE_ALERT?
   │  ├─ Check: Is data_available=true?
   │  │  ├─ false → DATA FEED ISSUE (see below)
   │  │  └─ true → SIGNAL GENERATION ISSUE
   │  │     └─ Action: Check signal_generation service logs
   │
   ├─ EXECUTION_BLOCK_ALERT?
   │  ├─ Check: Is Binance API responding?
   │  │  ├─ No → BINANCE CONNECTION ISSUE
   │  │  │    └─ Action: Check network/firewall
   │  │  └─ Yes → EXECUTION ENGINE ISSUE
   │  │     └─ Action: Check order validation, margins
   │
   ├─ DATA_FEED_DOWN_ALERT?
   │  ├─ Action: Wait 2 minutes (auto-recovery attempt)
   │  └─ If persistent: Check internet connectivity
   │
   ├─ SAFE_MODE_ACTIVATED?
   │  ├─ Check: Are metrics actually bad?
   │  │  ├─ Yes → Wait 10 min or recalibrate
   │  │  └─ No → May need threshold adjustment
   │
   └─ Multiple alerts?
      └─ ACTION: May be cascade failure
         └─ Consider manual pause: pause_execution=true
```

---

## Key Metrics to Monitor

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Heartbeat Gap | <5 min | 5-10 min | >10 min |
| Critical Alerts (24h) | 0 | 1-3 | >3 |
| Winrate (5m window) | >50% | 30-50% | <30% |
| SL Hit Ratio | <40% | 40-70% | >70% |
| Execution Rate | >80% | 60-80% | <60% |
| Data Feed Status | ok | occasional gaps | down |
| Calibration Cycles (15m) | Running | Delayed | Stalled |

---

## Contact & Escalation

**System Owner**: Proypers25 Trading Operations
**Alert Destination**: Monitor dashboard + Firestore collections
**Response SLA**:
- Critical alerts: Investigate within 5 minutes
- High alerts: Investigate within 15 minutes
- Info alerts: Review daily

**Emergency Pause**: 
```bash
# IMMEDIATE EXECUTION PAUSE
gcloud firestore documents update system_runtime_config/trading_params_live \
  --update pause_execution=true,pause_reason="manual_emergency_pause"
```

---

## Documentation References

- **Implementation Guide**: [EXTRA_PHASES_IMPLEMENTATION.md](EXTRA_PHASES_IMPLEMENTATION.md)
- **Deployment Status**: [DEPLOYMENT_STATUS_EXTRA_PHASES.md](DEPLOYMENT_STATUS_EXTRA_PHASES.md)
- **API Validation Script**: [validate-extra-phases.sh](validate-extra-phases.sh)
- **Backend Code**: 
  - Critical Safety Monitor: [backend/lib/critical_safety_monitor.js](backend/lib/critical_safety_monitor.js)
  - Autocalibration Integration: [backend/jobs/autocalibration_cycle.js](backend/jobs/autocalibration_cycle.js)
  - API Endpoints: [backend/routes/deep_health_router.js](backend/routes/deep_health_router.js)

---

**Last Updated**: 2026-04-19 03:00 UTC
**System Status**: ✅ All 7 Extra Phases Active
**Next Review**: 2026-04-19 04:00 UTC
