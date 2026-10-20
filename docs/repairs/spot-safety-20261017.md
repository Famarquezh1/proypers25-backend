# Spot safety repair — 2026-10-17

Base: `232266b0724189b3a4b62e6dd2a993111da43779`. Isolated branch: `fix/spot-safety-ci-20261017`.

## Directed diagnosis and reuse

- #3092 and #3221 are overlapping, unmerged dust fixes. Reused the typed below-minimum classification from #3221 and extended it to per-symbol isolation with a failing aggregate state.
- #3261 remains unmerged. Reused fail-closed GitHub scope discovery; replaced obsolete sampling and exit-wrapper assumptions without changing production risk parameters.
- #2817 is unmerged research-only work; deliberately excluded from production repair.
- Confirmed in main: absent continuation and CORE quality gates, swallowed inventory/history errors, component fail-fast orchestration, outdated CI assertions, old inventory timestamp leaking into recent base acquisitions, and missing native quantity coverage checks.

## Implemented boundaries

- All production capabilities remain. No risk/sizing configuration was modified.
- GET transport has an eight-second deadline and at most one retry. Order submissions never retry on uncertain network results.
- Base/V10 execution, V6.1 protection and legacy/V10 exit order creation share a per-symbol persisted intent. Reconcile order and account before releasing uncertainty; require fresh caller state before another submission. Confirmed NEW protective orders and filled market orders are distinct outcomes.
- Sell minimum checks precede cancellation. Native upgrades preflight first. After a failed transition, recovery queries open orders/balances before attempting to rearm a previous stop. An uncertain order blocks recovery to avoid overlapping execution. Failure remains explicitly degraded, never a claim of protection.
- Per-symbol failures do not prevent subsequent symbols or supervision stages from executing. Their aggregate result fails.
- Native stop quantity cannot reduce attributable managed position size. A stale price OR insufficient quantity requires reconciliation.
- Reconstructed cost is retained, while the latest base acquisition establishes the minimum start time; add-ons do not reset it.
- CORE requires fresh 3/3 quality or the existing intended strict early-confirmation pathway (2/3, norm >= .82, 24h advance < 8%, positive closed-candle confirmation/extension/r15). Existing execution score and sizing caps still apply.
- Local continuation requires a positive sampled price path for CORE/V10; spread, latency, skew, manipulation and reversal controls remain.
- Shadow meta-decision observer is actually called and logged; it does not authorize orders.

## Validation budget

Exactly two local implementation/validation rounds. First found an obsolete expected rejection code and the unused shadow observer. Final round passes all local steps of both CI workflows. V10 live read-only smoke is reserved for GitHub CI; no production entry/exit script was executed locally against real services.

New offline regressions cover lost market ACK (one submission), pending intent across invocations (no resubmit), order+balance reconciliation, active partial market order, lost protective stop ACK, bounded GET retry/no POST retry, malformed JSON, historical dust/new entry age, partial stop quantity, strict CORE/continuation gates, sell preflight before cancellation, dust continuity/global failure, unavailable registry, supervisor continuity/global failure and compiling all actual V10 wrapper patches without executing orders.

## Material limits and next prerequisite

- No evidence was collected from Binance account/order history. ALT's reported incident and ZEC/SAND/RVN/EIGEN/MINA's actual coverage are not certified by these mocked tests.
- Binance cancel/create is not atomic. Network loss, insufficient tradable balance, market movement, pending partial orders or exchange filters can leave protection unresolved; the engine reports failure instead of inventing protection.
- Intent state lives in the runner user's `.proypers25/order-intents` directory. Preserve it across cleanup/restarts. This is not a distributed lock across different hosts/users. Orphan/XEC sibling scripts retain their own order transport; equivalent global execution coordination needs a separate bounded change before an unrestricted autonomy claim.
- Managed-symbol discovery still has the existing 7-day registry window/100-issue page and order/trade history limits. Full historical coverage and cross-lane ownership are not proven. A registry outage now fails explicitly; it does not independently discover all unprotected assets.
- V6.1 retains its own fading calculation and historical sampling. Protection rollback is best effort, not an exchange guarantee; concurrent manual orders require review.
- V10 wrapper compilation and shared exit behaviour are tested, but this change does not certify every V10 lane rule or real exchange recovery path.
- Existing GitHub rate limits are not eliminated; secondary growth-state outages suppress add-ons and mark degraded while allowing primary supervision.
- No deployment, merge, real trade, credential change, mass training, QPU experiment or profitability evaluation was performed.

Required next action: review this branch and CI results, then separately authorize/read Binance evidence to verify actual protection and the remaining ownership/history limits before production rollout. CI approval, actual protection and net profitability are separate claims.
