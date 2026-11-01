# First 15 real trades — attribution and historical-dust defect

## Scope and evidence
Fixed cohort: 2026-11-01T02:51:57.420Z through 2026-11-01T20:50:12.251Z; 15 BUYs across 14 symbols. Executed SELLs allocated FIFO within symbol. Binance private allOrders/myTrades were queried through the GET-only VPS transport. No orders were submitted, no training was run and production strategy was not changed.
Execution/fee evidence: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41352869968
Original residual-context replay: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41353264416

## Main finding
11 of 15 lots were closed by discretionary MARKET exits at approximately the first five-minute exit cycle. All 11 reconstruct to pre-existing inventory start dates, giving ages between 220.007 and 1656.293 hours despite the new BUY being about five minutes old.
Examples: ERA actual 5.490 minutes vs reconstructed 220.007 hours; AVAX actual 5.406 minutes vs reconstructed 1035.612 hours; SUPER actual 5.706 minutes vs reconstructed 1656.293 hours.
The unchanged residual resolver forces reconstruction when there are multiple historical managed BUYs. spotOrphanProtection.reconstructInventory resets the inventory start only when remaining quantity reaches <=1e-12. Old tradable-minimum dust therefore preserves an ancient start date. spotManagedResidual.resolveManagedResidual then replaces the current BUY date with that date, and the legacy exit engine uses it for both age and historical-high calculations. Old dust and the new operational position are not distinct lifecycle cohorts.
Files: backend/services/spotOrphanProtection.js; backend/services/spotManagedResidual.js; backend/scripts/github-spot-auto-exit-legacy.js.

An offline minimal reproduction preserved a 0.00001-unit old remainder, added a new BUY and applied the original resolver. A five-minute position became 720 hours old. Original growth-exit policy returned HOLD for the actual age and NO_PROGRESS for the contaminated age. No network or real orders were used.

This demonstrates a reproducible age-contamination mechanism and a matching pattern in the real-trade reconstruction. Exact historical branch selection for every MARKET exit cannot be claimed: transition records did not persist the originating reason, and later notifications label them AUTOMATIC_EXIT. Context replay uses the last 100 order records available by exit and the last 1000 fills; transfers are not reconstructed. None of the queried context histories reached that 1000 limit. REZ had overlapping BUY lots, so its first lot must not be treated as an independent position-manager decision.

## Cost and path findings
- Weighted gross price return: -0.733%.
- Fees relative to cumulative deployed purchase cost: 0.199%.
- Marked result including actual fees and remaining cohort dust: -0.948%.
- Positive lots after fees/dust: 4/15. Negative: 11/15.
These percentages use cumulative purchase cost, which can reuse capital across trades. They are NOT the Binance account equity return. Dust is marked at analysis-time price, not the historical cutoff. Fees were charged in base assets and USDT; no BNB conversion was required for this cohort.
12/15 lots ended within six minutes: 11 discretionary MARKET exits plus one native stop. Two native-stop exits were observed overall. At four hours after exit, 10/15 observed prices were below the actual sale price. Holding longer mechanically is therefore not supported as a general solution. Post-exit prices are observations, not simulated executable returns with stops, fees and slippage.
ZKP reached approximately +7.816% within fully-held one-minute bars and finished at -0.431% net; the timing/stop execution of that separate case deserves explanation, not automatic stop widening.

## Trade rows
All times below are UTC. MFE/MAE use fully-contained 1m candles plus actual execution prices and omit partial entry/exit candles; no intraminute price-path assumptions.

| Symbol | BUY UTC | Minutes | Gross % | Net marked % | Fee % | MFE % | MAE % | Exit classification | Price 4h later vs sale % |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|
| ERAUSDT | 2026-11-01T12:12:11.568Z | 5.490 | 0.279 | 0.075 | 0.200 | 0.279 | -1.397 | AUTOMATIC_EXIT | -4.596 |
| AWEUSDT | 2026-11-01T07:23:03.485Z | 5.452 | 0.378 | 0.051 | 0.200 | 0.404 | -0.208 | AUTOMATIC_EXIT | -13.152 |
| ZKPUSDT | 2026-11-01T07:35:47.522Z | 150.092 | -0.230 | -0.431 | 0.200 | 7.816 | -1.149 | NATIVE_PROTECTIVE_STOP | -3.226 |
| GTCUSDT | 2026-11-01T05:43:55.728Z | 5.413 | -1.631 | -1.826 | 0.198 | 0.008 | -1.860 | AUTOMATIC_EXIT | 0.043 |
| AVAXUSDT | 2026-11-01T05:25:12.085Z | 5.406 | 0.123 | -0.096 | 0.199 | 0.180 | -0.146 | AUTOMATIC_EXIT | -1.245 |
| INITUSDT | 2026-11-01T04:23:19.568Z | 5.410 | -0.733 | -0.929 | 0.199 | 0.135 | -1.343 | AUTOMATIC_EXIT | -3.493 |
| XPLUSDT | 2026-11-01T04:29:35.210Z | 3.082 | -5.118 | -5.317 | 0.195 | 0.035 | -5.118 | NATIVE_PROTECTIVE_STOP | -10.128 |
| GIGGLEUSDT | 2026-11-01T06:21:02.029Z | 187.463 | 0.336 | 0.139 | 0.200 | 2.319 | -0.739 | AUTOMATIC_EXIT | 1.909 |
| AMPUSDT | 2026-11-01T07:16:32.455Z | 5.609 | -0.911 | -1.109 | 0.199 | 0.982 | -0.911 | AUTOMATIC_EXIT | -1.628 |
| OGNUSDT | 2026-11-01T11:35:58.125Z | 5.705 | 0.150 | -0.061 | 0.200 | 1.351 | -0.675 | AUTOMATIC_EXIT | -5.920 |
| SUPERUSDT | 2026-11-01T11:23:00.743Z | 5.706 | -0.549 | -0.828 | 0.198 | 0.165 | -0.604 | AUTOMATIC_EXIT | -3.311 |
| REZUSDT | 2026-11-01T04:35:57.003Z | 29.991 | 0.215 | 0.014 | 0.200 | 7.131 | -0.593 | AUTOMATIC_EXIT | 1.864 |
| REZUSDT | 2026-11-01T05:00:28.981Z | 5.458 | -2.042 | -2.238 | 0.198 | 0.000 | -2.087 | AUTOMATIC_EXIT | 0.527 |
| CVCUSDT | 2026-11-01T03:17:30.824Z | 5.420 | -1.348 | -1.548 | 0.198 | 0.000 | -1.879 | AUTOMATIC_EXIT | 0.124 |
| KITEUSDT | 2026-11-01T05:12:49.171Z | 5.502 | 0.085 | -0.115 | 0.200 | 0.085 | -0.338 | AUTOMATIC_EXIT | -0.169 |

## Specific engineering correction supported by this evidence
Separate old residual inventory from a newly opened managed position's entry time and price. Preserve actual inventory/commission accounting and native stops, but do not let negligible historical dust reset a new trade's clock or high-water mark. Preserve weighted lifecycle continuity for genuine overlapping operational BUYs/add-ons; do not unconditionally reset every BUY. Add durable exit-decision attribution (rule, age, entry/high reference and originating component) so future analyses do not rely on generic AUTOMATIC_EXIT labels.
This is a lifecycle/attribution defect to repair before deciding whether to replace the entry strategy. It is not proof that fixing the defect alone will yield profitability. No live strategy change was made during this investigation.
