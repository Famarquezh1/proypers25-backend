# Visual Troubleshooting Guide - Critical Safety Monitor

## System Health Indicators

```
HEALTHY STATE
═════════════════════════════════════════════════════════════
✅ Heartbeat    │ Every 5 min          │ is_healthy=true
✅ Signals      │ >10 per 5-min window │ signals_last_5m > 10
✅ Executions   │ >80% of signals      │ executions_last_5m / signals_last_5m > 0.8
✅ Winrate      │ >50%                 │ profitable trades > 50% of closed
✅ Data Feed    │ OK                   │ data_status = "ok"
✅ Safe Mode    │ OFF                  │ pause_active = false
✅ Alerts       │ 0                    │ critical_safety_alerts count = 0
═════════════════════════════════════════════════════════════
OVERALL: System operating normally, no intervention needed
```

```
DEGRADED STATE (1+ WARNING SIGNS)
═════════════════════════════════════════════════════════════
⚠️  Heartbeat    │ Every 5 min (normal) │ but signals/exec low
⚠️  Signals      │ 5-10 per window      │ Some activity but reduced
⚠️  Executions   │ 60-80% of signals    │ Slightly delayed
⚠️  Winrate      │ 40-50%               │ Marginal profitability
⚠️  Data Feed    │ OK                   │ No failures
═════════════════════════════════════════════════════════════
OVERALL: Monitor closely, may need recalibration
ACTION: Check metrics, consider confidence adjustment -5%
```

```
STALLED STATE (MULTIPLE FAILURES)
═════════════════════════════════════════════════════════════
🔴 Heartbeat    │ Gap 5-10 min         │ OR missing heartbeat
🔴 Signals      │ 0-5 per window       │ Barely generating
🔴 Executions   │ <60% of signals      │ OR blocked entirely
🔴 Winrate      │ <40%                 │ Trading poorly
🔴 Data Feed    │ Occasionally down    │ Unreliable data
🔴 Safe Mode    │ ACTIVE               │ Paused for protection
═════════════════════════════════════════════════════════════
OVERALL: System struggling, intervention required
ACTION: 
  1. Pause execution (pause_execution=true)
  2. Investigate root cause
  3. Recalibrate thresholds
  4. Manual resume when ready
```

```
CRASHED STATE (SYSTEM DOWN)
═════════════════════════════════════════════════════════════
🛑 Heartbeat    │ Gap >10 min          │ System offline
🛑 Signals      │ 0 for 10+ min        │ No activity
🛑 Executions   │ 0 for 10+ min        │ No work
🛑 Alerts       │ SYSTEM_IDLE_ALERT    │ + possible others
🛑 API Response │ 500/timeout          │ Service unreachable
═════════════════════════════════════════════════════════════
OVERALL: System is DOWN or unresponsive
EMERGENCY ACTION:
  1. Check Cloud Run service status
  2. Restart service if needed
  3. Check backend logs for errors
  4. Verify database connectivity
```

---

## Alert Decision Matrix

### SYSTEM_IDLE_ALERT
```
┌─────────────────────────────────────────────────┐
│ NO SIGNALS + NO INTENTS FOR 10+ MINUTES        │
│ (But data IS available)                        │
├─────────────────────────────────────────────────┤
│ Severity: CRITICAL                             │
│ Window: 10 minutes                             │
│ Action: INVESTIGATE_SIGNAL_GENERATION          │
├─────────────────────────────────────────────────┤
│ Likely Cause:                                  │
│  1. Signal ML model not producing output       │
│  2. All symbols filtered by qualifying rules   │
│  3. Market conditions don't meet thresholds    │
│  4. Signal generation service crashed          │
├─────────────────────────────────────────────────┤
│ Troubleshooting:                               │
│  $ curl .../api/system/critical-alerts         │
│  $ gcloud run logs read proypers25-backend     │
│  $ Check: symbol_runtime_metrics (last hour)   │
│  $ Check: signal_generation service status     │
├─────────────────────────────────────────────────┤
│ Resolution:                                    │
│  ✓ Restart signal generation if needed         │
│  ✓ Reduce thresholds by 10%                    │
│  ✓ Manual calibration may be needed            │
└─────────────────────────────────────────────────┘
```

### EXECUTION_BLOCK_ALERT
```
┌─────────────────────────────────────────────────┐
│ INTENTS CREATED BUT 0 EXECUTIONS FOR 5+ MIN    │
├─────────────────────────────────────────────────┤
│ Severity: HIGH                                 │
│ Window: 5 minutes                              │
│ Action: CHECK_EXECUTION_ENGINE                 │
├─────────────────────────────────────────────────┤
│ This is the EXACT scenario that happened!      │
│ Signals generated ✓ but execution blocked ✗    │
├─────────────────────────────────────────────────┤
│ Likely Cause:                                  │
│  1. Binance API connection lost                │
│  2. Rate limit hit (1200 requests/minute)      │
│  3. WebSocket stream reconnecting              │
│  4. Order validation failed (margin/size)      │
│  5. Execution queue backed up                  │
├─────────────────────────────────────────────────┤
│ Troubleshooting:                               │
│  $ curl https://fapi.binance.com/fapi/v1/ping  │
│  $ Check account balance & margin              │
│  $ Review order logs for failures              │
│  $ Check network latency to Binance            │
├─────────────────────────────────────────────────┤
│ Resolution:                                    │
│  ✓ Wait 30 seconds (auto-retry)                │
│  ✓ Reconnect WebSocket stream                  │
│  ✓ If persistent: Pause execution 5 min        │
│  ✓ Investigate Binance connection              │
└─────────────────────────────────────────────────┘
```

### DATA_FEED_DOWN_ALERT
```
┌─────────────────────────────────────────────────┐
│ FETCHED_SYMBOLS = 0 DURING MARKET HOURS        │
├─────────────────────────────────────────────────┤
│ Severity: CRITICAL                             │
│ Window: Immediate (per cycle)                  │
│ Action: VERIFY_BINANCE_CONNECTION              │
├─────────────────────────────────────────────────┤
│ Result: CALIBRATION SKIPPED (no valid data)   │
├─────────────────────────────────────────────────┤
│ Likely Cause:                                  │
│  1. Binance API down or unreachable            │
│  2. Network connectivity issue                 │
│  3. API credentials invalid                    │
│  4. Rate limit exceeded (permanent ban)        │
│  5. Yahoo Finance also down (fallback failed)  │
├─────────────────────────────────────────────────┤
│ Troubleshooting:                               │
│  $ curl https://fapi.binance.com/fapi/v1/ping  │
│  $ curl https://query1.finance.yahoo.com/...   │
│  $ Check system firewall/proxy settings        │
│  $ Review API rate limits                      │
├─────────────────────────────────────────────────┤
│ Resolution:                                    │
│  ✓ Wait 2-3 minutes for auto-recovery          │
│  ✓ If persists: Check internet connectivity    │
│  ✓ May indicate market data service downtime   │
│  ✓ System will auto-pause until data available │
└─────────────────────────────────────────────────┘
```

### SAFE_MODE_ACTIVATED
```
┌─────────────────────────────────────────────────┐
│ EXECUTION PAUSED - BAD TRADING CONDITIONS      │
├─────────────────────────────────────────────────┤
│ Severity: HIGH                                 │
│ Window: 10 minutes (auto-pause duration)       │
│ Action: EXECUTION_PAUSED_UNTIL [timestamp]     │
├─────────────────────────────────────────────────┤
│ Trigger (any one triggers safe mode):          │
│  • Winrate < 30% for 10+ minutes               │
│  • SL Hit Ratio > 70% for 10+ minutes          │
├─────────────────────────────────────────────────┤
│ What Happens:                                  │
│  ✓ system_runtime_config updated:              │
│    pause_execution = true                      │
│    pause_until = now + 10 minutes               │
│  ✓ No new orders created during pause          │
│  ✓ Open positions not affected                 │
│  ✓ System continues monitoring                 │
│  ✓ Auto-resume after 10 minutes if metrics OK  │
├─────────────────────────────────────────────────┤
│ Typical Scenario:                              │
│  [00:00] System hits 5 losing trades           │
│  [00:05] Winrate drops to 25%                  │
│  [00:10] Alert triggered, safe mode activates  │
│  [00:15] No new orders being created (paused)  │
│  [00:20] System waiting...                     │
│  [00:30] Metrics check: is winrate still bad?  │
│          Yes → Stay paused                     │
│          No → Auto-resume, trading resumes     │
├─────────────────────────────────────────────────┤
│ Manual Options During Pause:                   │
│  1. Wait: Auto-resume after 10 min             │
│  2. Verify: Check if metrics actually improved │
│  3. Adjust: Reduce thresholds in config        │
│  4. Resume: Set pause_execution=false manually │
├─────────────────────────────────────────────────┤
│ Preventing Repeated Safe Mode:                 │
│  1. Increase WINRATE_THRESHOLD (e.g., 25%)     │
│  2. Decrease SL_HIT_RATIO_THRESHOLD (e.g.,50%) │
│  3. Add market condition checks                │
│  4. Reduce position size or confidence         │
└─────────────────────────────────────────────────┘
```

### SYSTEM_HEARTBEAT (Info)
```
┌─────────────────────────────────────────────────┐
│ PERIODIC LIVENESS CONFIRMATION                 │
├─────────────────────────────────────────────────┤
│ Severity: INFO                                 │
│ Interval: Every 5 minutes                      │
│ Purpose: Prove system is actively working      │
├─────────────────────────────────────────────────┤
│ Contained Proof:                               │
│  • Timestamp: When heartbeat was sent           │
│  • system_state: healthy|degraded|stalled|...  │
│  • signals_last_5m: Number generated           │
│  • executions_last_5m: Number executed         │
│  • winrate: Current performance ratio           │
│  • data_status: ok|down                        │
│  • is_healthy: true|false                      │
├─────────────────────────────────────────────────┤
│ How to Monitor:                                │
│  GET /api/system/heartbeats?limit=12           │
│  Should show 12 entries = 60-minute history    │
│  Gap > 10 min = System offline/down            │
├─────────────────────────────────────────────────┤
│ Example Healthy Heartbeat:                     │
│  {                                             │
│    "timestamp": "2026-04-19T03:00:00Z",        │
│    "system_state": "healthy",                  │
│    "signals_last_5m": 15,                      │
│    "executions_last_5m": 12,                   │
│    "winrate": 0.667,                           │
│    "data_status": "ok",                        │
│    "is_healthy": true                          │
│  }                                             │
├─────────────────────────────────────────────────┤
│ Example Degraded Heartbeat:                    │
│  {                                             │
│    "timestamp": "2026-04-19T02:55:00Z",        │
│    "system_state": "degraded",                 │
│    "signals_last_5m": 3,                       │
│    "executions_last_5m": 1,                    │
│    "winrate": 0.42,                            │
│    "data_status": "ok",                        │
│    "is_healthy": false                         │
│  }                                             │
└─────────────────────────────────────────────────┘
```

---

## Real-Time Monitoring Dashboard

### Setup Monitoring (Google Cloud Console)

```
1. Open Firestore: https://console.cloud.google.com/firestore
2. Select Database: proypers2025
3. Navigate to Collections:
   
   📊 critical_safety_alerts
      └─ Monitor: timestamp, event_type, severity
   
   ❤️  system_heartbeats
      └─ Monitor: timestamp, is_healthy, signals_last_5m
```

### Quick Status Check Script

```bash
#!/bin/bash
# Real-time system status (copy & run)

echo "PROYPERS25 CRITICAL SAFETY MONITOR STATUS"
echo "=========================================="
echo ""

# Get latest heartbeat
echo "[1] Latest Heartbeat:"
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/heartbeats?limit=1" | \
  jq '.heartbeats[0] | {state: .system_state, signals: .signals_last_5m, healthy: .is_healthy}'

# Count recent alerts
echo ""
echo "[2] Recent Alerts:"
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/critical-alerts?limit=10" | \
  jq '{total: .total_count, by_severity: (.alerts | group_by(.severity) | map({severity: .[0].severity, count: length}))}'

# Check all phases active
echo ""
echo "[3] Safety Phases Status:"
curl -s "https://proypers25-backend-southamerica-west1.run.app/api/system/safety-status" | \
  jq '{all_phases_active: .all_phases_active, health_score: .system_health.score}'

echo ""
echo "For more details: curl -s 'https://...api/system/safety-status' | jq '.phases'"
```

---

## Alert Severity Color Coding

```
🟢 INFO           │ SYSTEM_HEARTBEAT      │ Normal operation confirmed
🟡 HIGH           │ EXECUTION_BLOCK       │ Signals OK, execution delayed
🟡 HIGH           │ SAFE_MODE_ACTIVATED   │ Bad conditions, paused
🔴 CRITICAL       │ SYSTEM_IDLE           │ No signals, investigate
🔴 CRITICAL       │ DATA_FEED_DOWN        │ No data, cannot trade
```

---

## When to Escalate

```
ESCALATE IMMEDIATELY if:
├─ 🔴 Multiple CRITICAL alerts in 15 minutes
├─ 🔴 Heartbeat gap > 15 minutes (system down)
├─ 🟡 SAFE_MODE active for > 30 minutes
├─ 🛑 /api/system/safety-status returns error 500
└─ 🛑 Cannot reach any monitoring endpoint

ACTIONS:
1. Pause execution: pause_execution=true
2. Notify on-call engineer
3. Collect logs: gcloud run logs read proypers25-backend
4. Check Firestore: critical_safety_alerts collection
5. Verify Cloud Run service status
```

---

## Performance Baselines

```
Metric                    Healthy      Caution      Critical
─────────────────────────────────────────────────────────────
Heartbeat Interval        5 min        5-8 min      >10 min
Signals per 5min          10-20        5-10         <5
Execution Rate            80-95%       60-80%       <60%
Winrate (recent)          50-70%       40-50%       <30%
SL Hit Ratio              20-40%       40-70%       >70%
Data Feed Uptime          99%+         95-99%       <95%
Safe Mode Duration        <5 min/day   5-20min/day  >20min/day
Critical Alerts (24h)     0-1          1-3          >3
```

---

**Last Updated**: 2026-04-19
**Document Version**: 1.0
**Status**: All 7 Phases Active ✅
