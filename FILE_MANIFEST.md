# FILE MANIFEST - IMPULSE TRADING ENGINE

## Quick Reference

All files created for the Impulse Trading Engine redesign, organized by location.

---

## Backend Services (Complete Implementation)

### Location: `C:\Desarrollo\proypers25\backend\services\`

```
impulseDetector.js
├─ Purpose: Detect real market impulses
├─ Lines: ~200
├─ Dependencies: axios, Binance API
├─ Exports: detectImpulse(), detectImpulses(), getKlines()
└─ Key function: Checks 4 impulse criteria

noiseFilter.js
├─ Purpose: Filter out noisy/illiquid signals
├─ Lines: ~180
├─ Dependencies: axios
├─ Exports: filterNoise(), get15mCandles(), getSpread()
└─ Key function: Blocks signals that fail 3 filters

impulseSignalGenerator.js
├─ Purpose: Generate IMPULSE-type signals
├─ Lines: ~120
├─ Dependencies: firebase-admin, impulseDetector, noiseFilter
├─ Exports: generateImpulseSignal(), generateImpulseSignals()
└─ Key function: Creates signals only for real impulses

impulseExecutionEngine.js
├─ Purpose: Execute trades (market entry, exit management)
├─ Lines: ~350
├─ Dependencies: firebase-admin, axios
├─ Exports: executeImpulseTrade(), processImpulseSignals(), updateOpenTrades(), closeTrade()
└─ Key function: Handles TP/SL/Trailing stops

impulseRiskManager.js
├─ Purpose: Manage portfolio risk and halt conditions
├─ Lines: ~250
├─ Dependencies: firebase-admin
├─ Exports: getPortfolioMetrics(), shouldHaltTrading(), validateTrade(), logRiskMetrics()
└─ Key function: Enforces trading limits and halt conditions

impulseScheduler.js
├─ Purpose: Orchestrate complete trading cycle
├─ Lines: ~100
├─ Dependencies: All services above
├─ Exports: runImpulseCycle(), handleSchedulerRequest()
└─ Key function: Runs every 15 minutes, coordinates all phases
```

---

## Routes & Integration

### Location: `C:\Desarrollo\proypers25\backend\routes\`

```
impulseSchedulerRoute.js
├─ Purpose: HTTP endpoints for Cloud Scheduler
├─ Lines: ~80
├─ Endpoints:
│  ├─ POST /internal/cron/impulse/cycle (main entry)
│  └─ GET /internal/health/impulse (status check)
└─ Authentication: CRON_SECRET header validation
```

### Modified File: `C:\Desarrollo\proypers25\backend\server.js`

```
Changes:
├─ Line 12: Added require('./routes/impulseSchedulerRoute')
├─ Line 72: Added app.use('/', impulseSchedulerRoute)
└─ Total changes: 2 lines added
```

---

## Testing & Audit Scripts

### Location: `C:\Desarrollo\proypers25\backend\`

```
test_impulse_system.js
├─ Purpose: Local pre-deployment testing
├─ Lines: ~150
├─ Functions:
│  ├─ testImpulseDetection()
│  ├─ testNoiseFilter()
│  ├─ testSignalGeneration()
│  └─ runAllTests()
├─ Usage: node test_impulse_system.js
└─ Output: Test results for 5 sample symbols

audit_impulse_trades.js
├─ Purpose: Performance validation after trades
├─ Lines: ~180
├─ Functions:
│  ├─ getClosedTrades(limit)
│  ├─ calculateMetrics(trades)
│  └─ generateAuditReport(limit)
├─ Usage: node audit_impulse_trades.js 20
└─ Output: Win rate, PnL, best/worst trade, viability
```

---

## Documentation Files

### Location: `C:\Desarrollo\proypers25\`

```
IMPULSE_TRADING_ENGINE.md
├─ Size: ~400 lines
├─ Content:
│  ├─ Complete architecture overview
│  ├─ Detection criteria (detailed)
│  ├─ Noise filter rules
│  ├─ Exit strategy (TP/SL/Trailing)
│  ├─ Risk controls
│  ├─ Execution flow
│  ├─ Database schema
│  ├─ Deployment instructions
│  ├─ Local testing
│  ├─ Troubleshooting
│  └─ Rollback procedure
└─ Audience: Technical implementation

DEPLOYMENT_CHECKLIST.md
├─ Size: ~300 lines
├─ Content:
│  ├─ Pre-deployment checklist
│  ├─ Step-by-step deployment
│  ├─ Post-deployment configuration
│  ├─ Monitoring setup
│  ├─ Initial execution guide
│  ├─ Success criteria verification
│  ├─ Rollback procedure
│  └─ Maintenance schedule
└─ Audience: DevOps / Deployment team

SYSTEM_REDESIGN_SUMMARY.md
├─ Size: ~350 lines
├─ Content:
│  ├─ Executive summary
│  ├─ Before vs after comparison
│  ├─ Key differences
│  ├─ Database structure changes
│  ├─ Code organization
│  ├─ Success metrics
│  ├─ Philosophy changes
│  ├─ Deployment impact
│  └─ Summary comparison table
└─ Audience: Project stakeholders / Decision makers

BUILD_COMPLETE.md
├─ Size: ~400 lines
├─ Content:
│  ├─ Implementation summary
│  ├─ What was accomplished
│  ├─ Files created list
│  ├─ Architecture highlights
│  ├─ Success criteria
│  ├─ Deployment timeline
│  ├─ Comparison table
│  ├─ Risk management
│  ├─ Next steps
│  └─ Summary checklist
└─ Audience: Project managers / Team leads

FINAL_DIAGNOSIS_STRICT.txt
├─ Old system validation report (April 20)
├─ Shows: 44.4% accuracy, 33.3% profitable
├─ Verdict: NOISE - No real edge
└─ Reason for complete redesign
```

---

## Database Collections

### Firestore Structure

```
high_conviction_impulse_signals/
├─ Purpose: Stores newly generated signals
├─ Documents:
│  ├─ symbol: string
│  ├─ signal_type: "IMPULSE"
│  ├─ direction: "UP" | "DOWN"
│  ├─ confidence: 0.6-0.9
│  ├─ strength_score: 0-1
│  ├─ impulse_metrics: object
│  ├─ noise_metrics: object
│  ├─ entry_price: number
│  ├─ created_at: Timestamp
│  └─ status: "PENDING_EXECUTION" | "EXECUTED"
└─ Created by: impulseSignalGenerator.js

active_impulse_trades/
├─ Purpose: Stores all trades (open and closed)
├─ Documents:
│  ├─ trade_id: string (unique)
│  ├─ symbol: string
│  ├─ direction: "UP" | "DOWN"
│  ├─ entry_price: number
│  ├─ entry_time: Timestamp
│  ├─ quantity: number
│  ├─ tp_price, tp_target_pct: numbers
│  ├─ sl_price, sl_target_pct: numbers
│  ├─ trailing_activated: boolean
│  ├─ status: "OPEN" | "CLOSED"
│  ├─ pnl_pct: number
│  ├─ exit_price: number
│  ├─ exit_time: Timestamp
│  ├─ reason_exit: "TP_HIT" | "SL_HIT" | "TRAILING"
│  ├─ duration_ms: number
│  ├─ created_at, closed_at: Timestamps
│  └─ impulse_metrics, noise_metrics: objects
└─ Created by: impulseExecutionEngine.js

system_runtime_config/impulse_trading/
├─ Purpose: System configuration
├─ Document:
│  ├─ execution_enabled: boolean
│  ├─ position_size_percent: 0.25 | 0.5 | 1.0
│  ├─ risk_level: "CONSERVATIVE" | "MODERATE"
│  ├─ max_concurrent_trades: number
│  ├─ max_daily_loss_percent: number
│  ├─ status: "ACTIVE" | "HALTED"
│  ├─ enabled_at: Timestamp
│  └─ notes: string
└─ Managed by: Manual or impulseRiskManager.js
```

---

## Environment Variables

### Required for Deployment

```
CRON_SECRET
├─ Purpose: Validate Cloud Scheduler requests
├─ Value: Random hex string (24+ chars)
└─ Location: Cloud Run > service > environment

GOOGLE_APPLICATION_CREDENTIALS
├─ Purpose: Firestore authentication
├─ Value: Path to service account JSON
└─ Location: Service account key file

GOOGLE_CLOUD_PROJECT
├─ Purpose: GCP project ID
├─ Value: "proypers2025"
└─ Location: Environment
```

---

## Deployment Files

### Cloud Build Configuration

```
cloudbuild.yaml
├─ Purpose: Automated build and push
├─ Steps:
│  ├─ Build Docker image
│  ├─ Tag with latest
│  ├─ Push to artifact registry
│  └─ Trigger Cloud Run update
└─ Trigger: Manual or git push

Dockerfile
├─ Purpose: Container image definition
├─ Base: node:20-slim
├─ Installs: Dependencies
├─ Entrypoint: npm start (server.js)
└─ Ports: 8080
```

---

## Command Reference

### Local Testing
```bash
cd C:\Desarrollo\proypers25\backend
node test_impulse_system.js              # Test all components
node audit_impulse_trades.js 20          # Audit 20 trades
```

### Deployment
```bash
cd C:\Desarrollo\proypers25\backend
gcloud builds submit --config cloudbuild.yaml --project proypers2025
gcloud run deploy proypers25-backend ...
```

### Cloud Scheduler
```bash
gcloud scheduler jobs create http impulse-trading ...
gcloud scheduler jobs describe impulse-trading --location southamerica-west1
gcloud scheduler jobs pause impulse-trading --location southamerica-west1
gcloud scheduler jobs resume impulse-trading --location southamerica-west1
```

### Monitoring
```bash
gcloud run logs read proypers25-backend --region southamerica-west1 --limit 100
curl https://[SERVICE_URL]/internal/health/impulse
```

---

## File Statistics

```
Total Files Created:        14
Total Lines of Code:        1,500+
Total Documentation:        1,400+ lines

Breakdown:
├─ Services (6):             1,200 lines
├─ Routes (1):                  80 lines
├─ Test Scripts (2):           330 lines
├─ Documentation (4):        1,400 lines
└─ Total:                   ~3,010 lines
```

---

## Dependency Check

### Python Dependencies
- firebase-admin (v13+)
- axios (for HTTP/Binance API)
- express (v5.1.0)
- node-cron (if needed)

### External APIs
- Binance Futures API (`https://fapi.binance.com/fapi/v1`)
  - `/klines` endpoint (price history)
  - `/ticker/bookTicker` endpoint (bid/ask)

### Google Cloud Services
- Cloud Firestore (collections)
- Cloud Run (service hosting)
- Cloud Scheduler (job execution)
- Cloud Logs (monitoring)
- Artifact Registry (image storage)

---

## Next Steps

1. Review BUILD_COMPLETE.md
2. Review DEPLOYMENT_CHECKLIST.md
3. Deploy to Cloud Run
4. Create Cloud Scheduler job
5. Monitor first 10 trades
6. Run audit_impulse_trades.js
7. Assess viability
8. Make decision: PROCEED or HALT

---

**Build Date**: April 21, 2026
**All Files Ready**: ✓ YES
**Deployment Ready**: ✓ YES
**Status**: READY FOR PRODUCTION

For questions, refer to appropriate documentation file above.
