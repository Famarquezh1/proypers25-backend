# 📊 POST-DEPLOYMENT MONITORING GUIDE

**System**: Proypers2025 Backend Centralized Execution Contract  
**Monitoring Period**: 24 hours (critical), then 1 week (ongoing)  
**Purpose**: Detect and mitigate the 2 identified medium-level risks

---

## 🎯 MONITORING OBJECTIVES

1. **Race Condition Detection**: Firestore merge conflicts
2. **Legacy Field Contamination**: Ensure no bypass of centralized service
3. **Performance Impact**: Verify updateIntent() adds minimal latency
4. **Data Consistency**: Confirm all fields normalized correctly
5. **Error Handling**: Track validation failures

---

## 📈 DASHBOARD SETUP

### Google Cloud Logging Dashboard

**Create a custom dashboard** with these queries:

#### Dashboard 1: Service Health
```
resource.type="cloud_run_revision"
resource.labels.service_name="proypers2025-backend"
severity="ERROR"
```
**Alert Threshold**: > 0 errors in 5 minutes  
**Action**: Immediate investigation

#### Dashboard 2: Contract Validation Status
```
resource.type="cloud_run_revision"
jsonPayload.function="updateIntent"
(jsonPayload.result="PASS" OR jsonPayload.result="FAIL")
```
**Expected**: 95%+ pass rate  
**Alert Threshold**: < 90% pass rate  
**Action**: Review validation logs

#### Dashboard 3: Race Condition Detector
```
resource.type="cloud_run_revision"
jsonPayload.error=~"merge|conflict|concurrent|race"
```
**Expected**: 0 occurrences (first 24 hours)  
**Alert Threshold**: > 1 per hour  
**Action**: Implement database-level locking

#### Dashboard 4: Performance Monitor
```
resource.type="cloud_run_revision"
jsonPayload.function="updateIntent"
```
**Metric**: Trace execution time (latency_ms field)  
**Baseline**: < 50ms  
**Alert Threshold**: > 200ms (95th percentile)  
**Action**: Optimize database queries

---

## 🔍 MANUAL CHECKS (DO HOURLY FOR FIRST 24 HOURS)

### Check 1: Recent Intents Structure
```bash
# Command (Firebase Console or gcloud)
gcloud firestore documents list binance_execution_intents --limit 20

# Verify each intent has:
✅ win_model field (not null/PENDING)
✅ status field (created|sent|executed|closed)
✅ updated_at field (ISO8601 format)
✅ updated_by field (value: "executionContractService")
✅ delay_ms field (positive integer)
```

### Check 2: Error Log Scan
```bash
# Get last 100 logs
gcloud run logs read proypers2025-backend --limit 100

# Search for errors:
❌ "Cannot read property" (missing field)
❌ "Merge failed" (race condition)
❌ "Direct write detected" (bypass attempt)
❌ "Validation error" (contract failure)
❌ "Database timeout" (performance issue)

Result: 0 errors expected in first 24 hours
```

### Check 3: Frontend Widget Test
```
1. Go to Dashboard → "Últimas ejecuciones Binance"
2. Expected: Widget shows recent executions (not "0 results")
3. Count: Should be >= number of active signals
4. Data: Each execution shows pnl_pct, win_model, status
```

### Check 4: Firestore Writes Count
```
Google Cloud Metrics:
- Namespace: firestore.googleapis.com
- Metric: Document write count
- Filter: collection=binance_execution_intents

Expected Trend:
- During trading hours: +5-20 writes per minute
- During off-hours: 0-2 writes per minute
- Spikes: Expected when markets open/close
- Anomaly: >50 writes per minute = investigate
```

---

## ⚠️ RISK 1: RACE CONDITIONS

### What Is It?
Multiple updateIntent() calls happening simultaneously might cause Firestore merge conflicts. Low probability, but possible under high trading volume.

### How to Detect
```
Cloud Logging Query:
resource.type="cloud_run_revision"
jsonPayload.error=~"merge|conflict|concurrent"
severity="ERROR"

What to look for:
❌ "FAILED_PRECONDITION: Cannot merge: conflicting writes"
❌ "[RACE] Concurrent update detected"
❌ "Merge conflict detected on intentId:XXX"
```

### Impact if Occurs
- **Data**: Some fields might not update (Firestore merge-safe)
- **User**: Execution would still complete, but metadata might be stale
- **System**: Intent still valid, just lacks final metadata
- **Severity**: LOW (data consistency maintained, execution not affected)

### Mitigation Strategy 1: Async Lock Pattern (No code change needed yet)
```javascript
// Already handled by Firestore merge semantics
// Firestore automatically prevents true conflicts with merge: true

// Current approach is safe. If conflicts emerge:
// → Add distributed lock via Cloud Tasks
// → Or implement Firestore transaction-based updates
```

### Mitigation Strategy 2: Rate Limiting (Optional)
```javascript
// In updateIntent(), add per-intentId rate limiting:
const rateLimiter = new Map(); // intentId -> lastUpdateTime

if (rateLimiter.has(intentId)) {
  const lastUpdate = rateLimiter.get(intentId);
  if (Date.now() - lastUpdate < 100) {
    // Same intent updated twice in <100ms
    throw new Error('[RACE PREVENTION] Too rapid consecutive updates');
  }
}
```

### When to Implement
**Monitor for 24-48 hours first**. If you see:
- 0 merge errors → No action needed
- 1-2 merge errors → Document and continue
- >1 per hour → Implement async lock before next deploy

---

## ⚠️ RISK 2: LEGACY FIELD CONTAMINATION

### What Is It?
Other modules might still write to the old fields (win_exchange, verification_outcome) instead of going through updateIntent(). This would bypass contract enforcement.

### How to Detect
```
Method 1: Code Search (One-time verification)
grep -r "win_exchange\s*=" backend/ | grep -v executionContractService
grep -r "verification_outcome\s*=" backend/ | grep -v executionContractService
grep -r "binance_execution_intents" backend/ | grep -v updateIntent

Expected: 0 results (no matches outside executionContractService)

Method 2: Data Monitoring (Continuous)
Cloud Logging Query:
resource.type="cloud_run_revision"
jsonPayload.collection="binance_execution_intents"
jsonPayload.operation=~"direct_write|update|set"
jsonPayload.source!="executionContractService"

Expected: 0 results
```

### Data Signature to Watch For
```
Suspect patterns:
❌ win_exchange field changed WITHOUT updated_by="executionContractService"
❌ verification_outcome field changed WITHOUT updated_by record
❌ contract structure incomplete (missing fields)
❌ Multiple updates in same second from different modules

Red flag example (in Firestore):
{
  updated_at: "2026-04-16T12:34:56Z",
  updated_by: "intentWatchdog"  ← WRONG (should be executionContractService)
  win_exchange: "WIN"            ← Only updated via updateIntent
}
```

### Prevention Strategy
```javascript
// Add defensive check in updateIntent():
if (!Array.isArray(partialData.updated_by)) {
  // Caller trying to provide their own updated_by
  throw new Error('[SECURITY] Caller cannot set updated_by. Use updateIntent()');
}

// This prevents any module from claiming responsibility for a write
```

### When to Implement
**Already implemented** - Check `/backend/services/execution/executionContractService.js` line ~40

---

## 🔧 MONITORING TOOLS TO SET UP

### Google Cloud Alerts

**Alert 1: Contract Validation Failure**
```
Metric: Firestore Write Failure Count
Collection: binance_execution_intents
Condition: Count > 5 in 1 hour
Severity: MEDIUM
Action: Page on-call engineer
```

**Alert 2: Service Errors**
```
Log Query: severity="ERROR" 
Service: proypers2025-backend
Condition: Count > 1 in 5 minutes
Severity: HIGH
Action: Immediate escalation
```

**Alert 3: High Latency**
```
Metric: Execution Time for updateIntent()
Condition: 95th percentile > 200ms
Severity: MEDIUM
Action: Review database performance
```

### Datadog (Optional Enhancement)
```
Create monitor for:
- updateIntent() execution time histogram
- Contract validation pass/fail ratio
- Firestore write operations per minute
- Memory usage of Node.js process
- CPU usage spikes during trading hours
```

---

## 📋 HOURLY CHECK TEMPLATE (First 24 Hours)

Copy this and run every hour:

```
TIME: ________

[ ] Check 1: Cloud Run Status
    Status: ________
    Issues: ________

[ ] Check 2: Error Logs (last 50 lines)
    Error Count: ________
    Critical Errors: ________

[ ] Check 3: Recent Intents (Firebase Console)
    Sample Count: ________
    All have win_model: YES / NO
    All have updated_by: YES / NO
    Issues: ________

[ ] Check 4: Frontend Widget
    Shows executions: YES / NO
    Example count: ________
    Issues: ________

[ ] Check 5: Merge Conflict Search
    Conflicts found: ________
    Time: ________

[ ] Check 6: Direct Write Bypass Search
    Bypasses found: ________
    Time: ________

SUMMARY:
✅ All checks passed / ⚠️ Warning: ________ / 🔴 Critical: ________
```

---

## 📊 DAILY REPORTS (Days 2-7)

Create a summary report each day with:

```
Date: ________

METRICS:
- Total intents written: ________
- Contract validation pass rate: ________ %
- Average updateIntent() latency: ________ ms
- Merge conflicts: ________
- Direct write bypasses: ________
- Frontend widget working: YES / NO

ISSUES:
- Critical: ________
- Medium: ________
- Low: ________

TREND:
✅ All metrics normal
⚠️ Slight elevation in latency
🔴 Validation failures increasing (investigate!)

ACTION ITEMS:
- ________
- ________
```

---

## 🎯 SUCCESS CRITERIA

**Monitoring Phase 1: First 24 Hours (Critical)**
```
✅ 0 critical errors
✅ Contract validation pass rate > 99%
✅ 0 merge conflicts
✅ 0 direct write bypasses
✅ Frontend widget working
✅ updateIntent() average latency < 100ms
✅ 0 data corruption detected
```

**Monitoring Phase 2: Days 2-7 (Validation)**
```
✅ Sustained metrics from Phase 1
✅ No new error patterns
✅ No anomalies in write patterns
✅ Load testing simulation (if applicable)
✅ Edge case scenarios exercised
```

**Monitoring Phase 3: Week 2+ (Ongoing)**
```
✅ Weekly trend reports
✅ Auto-alerts configured
✅ Performance baseline established
✅ On-call procedures documented
✅ Escalation process clear
```

---

## 🚨 ESCALATION PROCEDURE

### If You See a Merge Conflict (Race Condition)

**Level 1 (First occurrence):**
```
1. Document timestamp and intentId
2. Take screenshot of logs
3. Post in #backend channel with [RACE-CONDITION] tag
4. Analyze: Was there high trading volume at that moment?
5. Action: Continue monitoring (1-2 occurrences acceptable)
```

**Level 2 (>1 per hour):**
```
1. Implement async lock pattern in updateIntent()
2. Deploy code fix
3. Monitor for recurrence
4. Post incident summary
```

**Level 3 (>5 per hour):**
```
1. Rollback deployment immediately
2. Revert to previous version
3. Investigate root cause
4. Redesign with Firestore transactions
5. Redeploy after testing
```

### If You See Direct Write Bypass

**Immediate Action (Stop the presses!):**
```
1. Identify which module is bypassing
2. Check if intentional or accident
3. If accident: Create urgent PR to fix
4. If intentional: Review design
5. Ensure all writes go through updateIntent()
```

---

## 📞 ON-CALL CONTACTS

**Backend Issues**: [Backend Team Slack]  
**Database Issues**: [Firebase Admin]  
**Escalation**: [Engineering Lead]  

---

## ✅ CHECKLIST: Monitoring Setup Complete?

- [ ] Google Cloud Logging dashboard created
- [ ] All 4 monitoring queries added to dashboard
- [ ] Google Cloud Alerts configured for 3 conditions
- [ ] Team notified of monitoring period
- [ ] On-call schedule established
- [ ] Hourly check template printed/bookmarked
- [ ] Escalation procedures understood
- [ ] Rollback procedure verified
- [ ] Daily report template created
- [ ] Success criteria documented

---

**Monitoring Guide Version**: 1.0  
**Effective Date**: April 16, 2026  
**Review Frequency**: Daily (Week 1), Weekly (Ongoing)
