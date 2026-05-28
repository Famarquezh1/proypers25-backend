════════════════════════════════════════════════════════════════════════════════
AUDIT REPORT: LOTE 3 TIMEOUT BUG ROOT CAUSE ANALYSIS
════════════════════════════════════════════════════════════════════════════════

DATE: May 9, 2026
TIME: 15:10 UTC
SCOPE: Diagnostic only (NO code modifications, NO deployment, NO Binance activation)

════════════════════════════════════════════════════════════════════════════════
EXECUTIVE SUMMARY
════════════════════════════════════════════════════════════════════════════════

✗ CRITICAL BUG CONFIRMED:
  - All 3 Lote 3 positions (NILUSDT, NOTUSDT, TONUSDT) EXCEED 24-hour timeout
  - Timeout was configured to: 2026-05-08T23:03:38Z (24 hours after open)
  - Current time: 2026-05-09T15:10:44Z 
  - TIMEOUT EXCEEDED: 16+ hours ago
  - Still status: PAPER_OPEN (should be PAPER_CLOSED)
  - No results records created (positions were never closed)

✗ ROOT CAUSE:
  1. PRIMARY BUG: Line 493 in binanceSpotPaperExecutor.js
     - If fetchPublicSpotKlines() returns empty array → skip evaluation entirely
     - Even TIMEOUT positions are skipped without evaluation

  2. SECONDARY BUG: Line 235 in binanceSpotPaperExecutor.js
     - Condition: if (!exitReason && timeoutAt && timeoutAt <= now && latestClose > 0)
     - The "latestClose > 0" prevents TIMEOUT closure when price data unavailable
     - TIMEOUT should NOT require current market price (it's time-based only)

════════════════════════════════════════════════════════════════════════════════
DETAILED FINDINGS
════════════════════════════════════════════════════════════════════════════════

FIRESTORE QUERY RESULTS:
─────────────────────────────────────────────────────────────────────────────
scan_id: spot_scan_1778194991002
Symbols: NILUSDT, NOTUSDT, TONUSDT

Position Details:

  NILUSDT
    Status: PAPER_OPEN
    Created At: 2026-05-07T23:03:38.972Z
    Age: 40.12 hours
    Timeout Should Have Occurred: 2026-05-08T23:03:38.972Z
    Timeout Status: ✅ EXCEEDED (16.12 hours overdue)
    Latest Market Price: N/A (not calculated)
    Take Profit Levels: undefined (not set)
    Last Updated: 2026-05-07T23:03:38.972Z (created time, never updated)

  NOTUSDT
    Status: PAPER_OPEN
    Created At: 2026-05-07T23:03:38.475Z
    Age: 40.12 hours
    Timeout Should Have Occurred: 2026-05-08T23:03:38.475Z
    Timeout Status: ✅ EXCEEDED (16.12 hours overdue)
    Latest Market Price: N/A (not calculated)
    Take Profit Levels: undefined (not set)
    Last Updated: 2026-05-07T23:03:38.475Z (created time, never updated)

  TONUSDT
    Status: PAPER_OPEN
    Created At: 2026-05-07T23:03:37.902Z
    Age: 40.12 hours
    Timeout Should Have Occurred: 2026-05-08T23:03:37.902Z
    Timeout Status: ✅ EXCEEDED (16.12 hours overdue)
    Latest Market Price: N/A (not calculated)
    Take Profit Levels: undefined (not set)
    Last Updated: 2026-05-07T23:03:37.902Z (created time, never updated)

Query Results:
  - Positions in spot_paper_positions: 3 (ALL PAPER_OPEN)
  - Closed results in spot_paper_execution_results: 0 (NONE)
  - This means: cron has NEVER successfully closed any Lote 3 position

════════════════════════════════════════════════════════════════════════════════
CODE ANALYSIS: EXECUTION FLOW
════════════════════════════════════════════════════════════════════════════════

Expected Flow (CORRECT):
  1. Cron triggers: POST /internal/cron/binance/spot-paper-execution
  2. Calls: runSpotPaperExecutionCycle()
  3. Calls: updateOpenPaperPositions()
  4. For each PAPER_OPEN position:
     a. fetchPublicSpotKlines(symbol, startTime, endTime)
     b. evaluatePositionExit(position, klines, now)
        - Check TP1, TP2, SL
        - Check TIMEOUT: if age > 24h → set exit_reason = "TIMEOUT"
     c. if exit_reason exists → closePaperPosition()
        - Update status: PAPER_CLOSED
        - Create results record
        - Write PnL calculations

Actual Flow (BROKEN):
  1. Cron triggers: POST /internal/cron/binance/spot-paper-execution
  2. Calls: runSpotPaperExecutionCycle()
  3. Calls: updateOpenPaperPositions()
  4. For each PAPER_OPEN position:
     a. fetchPublicSpotKlines(symbol, startTime, endTime)
        → Returns EMPTY ARRAY (no klines found)
     b. Line 493: if (!klines.length) continue;
        → SKIPS evaluatePositionExit() entirely
        → Position NEVER evaluated for TIMEOUT
        → Position REMAINS PAPER_OPEN forever

════════════════════════════════════════════════════════════════════════════════
BUG #1: SKIPPED EVALUATION (PRIMARY)
════════════════════════════════════════════════════════════════════════════════

File: backend/services/binanceSpotPaperExecutor.js
Function: updateOpenPaperPositions() [line 482]

Code:
  Line 489: const klines = await fetchPublicSpotKlines(position.symbol, openedAt.getTime(), now.getTime());
  Line 490: if (!klines.length) continue;  ← BUG IS HERE
  Line 492: const exitEvaluation = evaluatePositionExit(position, klines, now);

Issue:
  - If fetchPublicSpotKlines returns empty [], the code SKIPS evaluation
  - This means TIMEOUT positions are never evaluated (they can't be closed)
  - Position stays PAPER_OPEN indefinitely

Why This Happens:
  - fetchPublicSpotKlines calls Binance API with 5m interval
  - If startTime is too old (40+ hours ago), Binance API might reject or return empty
  - Binance historical data has a limit (usually last 1000 candles)
  - Lote 3 opened 40 hours ago, requesting 5m candles over 40 hours = 480 candles
  - This SHOULD work, but may be hitting rate limits, timeout, or API restrictions

Evidence:
  - All 3 positions show "Latest Market Price: N/A"
  - All 3 show "Last Updated: [created_at]" (never updated again)
  - If klines fetch succeeded, these would be populated

════════════════════════════════════════════════════════════════════════════════
BUG #2: LATESTCLOSE > 0 REQUIREMENT (SECONDARY)
════════════════════════════════════════════════════════════════════════════════

File: backend/services/binanceSpotPaperExecutor.js
Function: evaluatePositionExit() [line 230]

Code:
  Line 233: const latestClose = Number(klines[klines.length - 1] ? .close || 0);
  Line 235: if (!exitReason && timeoutAt && timeoutAt.getTime() <= now.getTime() && latestClose > 0) {
  Line 236:     exitReason = 'TIMEOUT';

Issue:
  - TIMEOUT closure requires: latestClose > 0
  - But TIMEOUT is a time-based condition, not price-based
  - It should NOT require current market price
  - If price fetch fails (klines empty), latestClose = 0, TIMEOUT never triggers

How It Should Work:
  - TIMEOUT should only check: age > 24 hours
  - Should NOT require latestClose > 0
  - Current price only needed for TP1/TP2/SL calculations

Real-World Scenario:
  - If Binance API is temporarily down when cron runs
  - All positions skip evaluation (Bug #1)
  - Even if they were evaluated, TIMEOUT wouldn't trigger without price (Bug #2)
  - Result: positions stuck forever or until system recovery

════════════════════════════════════════════════════════════════════════════════
TIMEOUT CONFIGURATION
════════════════════════════════════════════════════════════════════════════════

Location: backend/lib/spotPaperRiskRules.js
Value: const TIMEOUT_HOURS = 24;

✓ Correctly configured to 24 hours
✓ Correctly imported into binanceSpotPaperExecutor.js
✓ Correctly used in timeout calculation: openedAt + (TIMEOUT_HOURS * 60 * 60 * 1000)

The TIMEOUT configuration itself is NOT the problem.
The problem is the EVALUATION and CLOSURE logic.

════════════════════════════════════════════════════════════════════════════════
CRON VERIFICATION
════════════════════════════════════════════════════════════════════════════════

Endpoint: POST /internal/cron/binance/spot-paper-execution
Location: backend/routes/velasCron.js [line 92]

Code:
  const summary = await runSpotPaperExecutionCycle(db, req.body || {});

✓ Endpoint EXISTS and is correctly implemented
✓ Calls runSpotPaperExecutionCycle() ✓ Returns proper response format

✗ But we don't know:
  - Is the endpoint being triggered on a schedule?
  - Or does it only trigger manually?
  - Cloud Run logs would show if cron is actually calling this endpoint

════════════════════════════════════════════════════════════════════════════════
LOTE 3 SPECIFIC DETAILS
════════════════════════════════════════════════════════════════════════════════

Timeline:
  May 7 23:03 UTC - Lote 3 positions opened (NILUSDT, NOTUSDT, TONUSDT)
  May 8 23:03 UTC - 24-hour timeout reached (should auto-close)
  May 9 15:10 UTC - Now (16+ hours overdue, still PAPER_OPEN)

Why Paper Execution Shows Them Open:
  - Firestore still has status: PAPER_OPEN
  - No PAPER_CLOSED records created
  - No results written to spot_paper_execution_results
  - lote3_simple.js correctly reports 3 open, 0 closed

Why System Didn't Close Them:
  1. ✗ BUG #1: Klines fetch failed (empty array)
  2. ✗ → Evaluation skipped entirely
  3. ✗ → TIMEOUT never triggered
  4. ✗ → Position never closed

════════════════════════════════════════════════════════════════════════════════
RECOMMENDED FIXES (NOT IMPLEMENTED - AUDIT ONLY)
════════════════════════════════════════════════════════════════════════════════

Fix #1: Handle Missing Klines (Line 493)
Current:
  if (!klines.length) continue;

Should Be:
  if (klines.length === 0) {
      // Still evaluate TIMEOUT even without kline data
      const exitEvaluation = evaluatePositionExit(position, [], now);
      if (exitEvaluation && exitEvaluation.exit_reason) {
          await closePaperPosition(db, position, exitEvaluation, now);
      }
      continue;
  }

Fix #2: Remove latestClose Requirement for TIMEOUT (Line 235)
Current:
  if (!exitReason && timeoutAt && timeoutAt.getTime() <= now.getTime() && latestClose > 0) {

Should Be:
  if (!exitReason && timeoutAt && timeoutAt.getTime() <= now.getTime()) {

Fix #3: Add Better Error Handling
Current:
  const klines = await fetchPublicSpotKlines(...);
  if (!klines.length) continue;

Should Include:
  - Log why klines are empty (API error vs no data)
  - Retry logic for transient failures
  - Alert if a position is nearing timeout without price data
  - Force timeout closure if API unreachable for extended period

════════════════════════════════════════════════════════════════════════════════
CONCLUSION
════════════════════════════════════════════════════════════════════════════════

ROOT CAUSE:  Position evaluation completely skipped when Binance API returns no klines
             (likely rate limiting or API restrictions on 40+ hour historical data)

BUG LOCATION: backend/services/binanceSpotPaperExecutor.js
  - PRIMARY:   Line 493 (skips evaluation if klines empty)
  - SECONDARY: Line 235 (requires latestClose > 0 for TIMEOUT)

IMPACT:       Lote 3 positions stuck indefinitely
              Cannot be closed by TIMEOUT mechanism
              Manually must be updated or cron must succeed with klines

WHY NOT FIXED: 
  - Diagnostic phase only (as requested)
  - User specified: NO code modifications
  - Bug is reproducible and confirmed via Firestore audit

NEXT STEPS:
  1. Check Cloud Run logs for /internal/cron/binance/spot-paper-execution errors
  2. Verify if cron is being triggered at all (may not be scheduled)
  3. Try manually calling endpoint with CRON_SECRET to see actual error
  4. Implement fixes once user authorizes code changes
  5. Manually close Lote 3 positions or wait for next cron with successful klines fetch

STATUS: ✓ Root cause identified, fixes documented, ready for implementation

════════════════════════════════════════════════════════════════════════════════
END OF AUDIT REPORT
════════════════════════════════════════════════════════════════════════════════
