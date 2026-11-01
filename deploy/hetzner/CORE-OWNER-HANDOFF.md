## Position cohort repair deployed — 2026-11-01 UTC

Source patch: `98fd8dd58abda671a63dfe24e3ed0166edf51fb3`.
Production deployment: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41359170796

Historical dust could retain an entry timestamp hundreds of hours older than the new operational BUY. The legacy residual resolver used that timestamp for position age and the high-since-entry window. The runtime now separates non-tradeable historical dust from the active cohort at a distinct BUY, retaining historical dust cost/quantity for reconciliation. Partial fills within one BUY, genuinely overlapping operable inventory, and already-protected inventory retain lifecycle identity. Original managed quantities, native stop coverage, CORE entry strategy, risk limits, strategy pin, owner authorization and credentials remain unchanged.

Authenticated read-only replay verified all 11 affected short-lived discretionary-exit cases now use their actual new BUY timestamp instead of 220–1656 hour-old inventory. No real orders were sent by these diagnostics. Exact historical exit branch was not retained for every sale; this repair establishes the clock defect, not a claim that every loss or sale was caused by it.

53 runtime tests, 12 entry scenarios and 8 restart scenarios passed. The first guarded attempt rolled back and kept new buys paused because strict reconciliation also examined fully sold dust. Targeted read-only diagnosis reproduced COHORT_BALANCE_REVIEW_REQUIRED on those dust balances. The second patch skips unprotected, currently untradeable residuals before identity reconstruction while retaining strict reconciliation for operable/protected positions; its regression test verifies this execution order. No further deployment rounds were needed.

Deployment verified the prior rollback state, account/native coverage, terminal order journals and runtime checksums, paused new entries, installed only the runtime patch and refreshed integrity evidence. A fresh successful exit + radar cycle was mandatory before removing the maintenance pause. Durable private pre-dispatch exit reason records are now written to /var/lib/proypers25/exit-decisions.jsonl, with bounded rotation; no forced test trade was placed.

Independent read-only health: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41359371857
At 2026-11-01T22:53:15.309Z the fresh heartbeat reported LIVE_CORE_ONLY, tradingActivated=true, liveReady=true, newBuysBlocked=false; systemd active with MainPID=55450 and NRestarts=0. Recovery, exits and radar completed code 0 without timeout. Audit: reviewRequired=0, 14 DUST balances, no open orders; Spot enabled, withdrawals/Futures/transfers disabled and IP restriction enabled. The older shadow-status readiness=false snapshot was created during the maintenance pause; the later heartbeat confirms the pause was removed. No operable position was open for a post-patch live discretionary-exit demonstration; historical replay and fake exchange scenarios provide the repair evidence. V10 remains observation only. Successful repair does not establish future profitability.

---

## Operational fix deployed — 2026-11-01

Source patch: `cf4d62fbfe4c4de88e5d04fadee5669fea34a4cc`.
Production deployment: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41349611330

Root cause: a sold GIGGLE remainder was below Binance LOT_SIZE minimum and the legacy exit chain attempted to place protection, raising "Protection quantity below minimum" and terminating the exit check. The runtime integration now recognizes residual quantities below LOT_SIZE or notional minima before exit/protection processing. Existing native protection is retained; invalid filters still fail closed; operable positions continue through the unchanged strategy.
The engine now retains failed/missing/stale exit-check health across intervening minute cycles and reports liveReady=false while any operational buy block exists. A fresh successful exit check restores readiness when account/recovery checks also pass.
44 tests, 12 entry scenarios and 8 restart scenarios passed in GitHub. Deployment paused new entries, stopped the existing service, verified dust-only account/no open orders/terminal journals, installed only the operational patch, refreshed file integrity evidence, and verified a fresh successful exit and radar cycle before removing the temporary maintenance pause. Original strategy pin, owner authorization, credentials, limits and systemd settings were preserved. Root-only backup and rollback are available under the patch commit ID. Runtime base release remains 506e0fd99e6467941a8b232c58af50d102a6fc59 with the patch recorded in release-evidence.json.

Next useful engineering work: fee-adjusted per-trade outcomes including residual balances, daily strategy-vs-market measurement, and alerts when heartbeat or protection checks become unhealthy. Do not infer profitability from successful order execution or green diagnostics.

---

# CORE production handoff — owner activated 2026-11-01 UTC

Owner activation succeeded: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41266869602
Read-only post-activation health succeeded: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41267073894

Verified service active/running, heartbeat LIVE_CORE_ONLY, tradingActivated=true, liveReady=true, newBuysBlocked=false. Recovery, original CORE radar and exit scripts completed with code 0 and no timeout. Authenticated account audit: reviewRequired=0, three dust balances, zero open orders; Spot enabled, withdrawals disabled, IP restricted, Futures/transfers disabled. V10 remains observation only. Service enabled at server boot. This verifies autonomous live operation, not a completed real-money buy/sell cycle; no real trade has been confirmed. Entries require valid original CORE signals.

The owner personally submitted the final financial confirmation; the assistant only dispatched read-only health checks after activation. Old financial executors remain isolated per the passing activation preflight.

---

## Pre-activation evidence (historical)


## Installed and tested
Runtime release: `506e0fd99e6467941a8b232c58af50d102a6fc59`.
Original strategy remains pinned to `8d88021dea30eb87f786b5685818d01204d132a3`.
Installation evidence: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41264635929
41 unit/integration tests, 12 original entry safety scenarios and 8 process-restart lifecycle scenarios passed. Financial scenarios used a disk-backed fake exchange; no real trades were sent.

Implemented durable deterministic order journals, bounded residual sales after authenticated terminal partial fills, native stop replacement/restoration and unknown-result reconciliation. Existing partially filled native stops are retained. Unrecognized/OCO order formats are refused. Exchange uncertainty remains a blocking review condition; protection restoration is not guaranteed during exchange failures.

V10 runs with original calibration, resource limits and no execution credentials; observation only.
CORE candidate service is installed, disabled and inactive. Staging remains read-only. Root-only live authorization is absent.
Local staging refusal was authenticated as an absent Binance order and archived with private evidence; no actual exchange order was deleted or canceled.

## Final current preflight — after authorized maintenance
Evidence: https://github.com/Famarquezh1/proypers25-backend/actions/runs/41266474141
Result: readyToActivate=true, blocks=[], tradingActivated=false.
All required legacy financial writers are disabled and drained. Inventory is complete; legacyWritersIsolated=true, reasons=[].
Three dust balances, zero open orders; no pending execution-review blocker.
The owner enabled the dedicated API Spot permission. A fresh authenticated check from the VPS passed all gates. This is readiness evidence, not activation or a real-money test.
The disabled public CORE detector's old queued run remains advisory only.

## Cutover boundary
An earlier automatic review rejected disabling Windows before an authorized maintenance window. The owner subsequently explicitly authorized that window. Windows auto-exit and dust-sale workflows were then disabled through GitHub, and fresh read-only verification proved all required legacy writers isolated and drained. No live activation or order placement occurred.

The dedicated VPS API now has the required Spot permission, with the existing IP restriction and no withdrawals, Futures or transfers checked by the passing preflight.

The manual GitHub workflow `Hetzner OWNER - preflight or activate CORE` defaults to check-only. Its activate-core option requires the owner-entered exact financial confirmation and passing a fresh server/account/cutover preflight. It reruns the fresh preflight immediately before activation; new account or legacy-writer changes can still block activation.
The owner must perform the final financial activation personally; the assistant must not dispatch activate-core.
After a successful owner activation, verify a fresh LIVE_CORE_ONLY heartbeat and systemd process identity. Actual entries still require a valid original CORE signal; do not force a trade to demonstrate activity.
No actual-money complete trade cycle has been tested.

No new infrastructure or paid services were added. Previously authorized server cost: USD 7.09/month including IPv4.
