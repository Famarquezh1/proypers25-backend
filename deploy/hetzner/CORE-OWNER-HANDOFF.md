# CORE owner handoff — verified 2026-11-01 UTC

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
