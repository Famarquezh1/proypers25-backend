# Proypers25 Alpha MVP — only financial evidence

**CAPTURE → RECONCILE → ACCOUNTING → REPORT**. No changes to Radar, V42, QUBO, Entry V61, sizing, gates, orders, exits, protections or risk. This folder is never imported by any trading engine. All authenticated Binance requests are GET.

## Evidence and accounting

- Binance Spot `GET /api/v3/allOrders` + `GET /api/v3/myTrades` are the execution/fee source of truth. Symbol-specific time windows and pagination; missing fills or commissions block verified PnL.
- FIFO by confirmed managed BUY order. Subsequent managed SELL fills are apportioned by actual quantity across older lots; each order may have multiple fills; partially sold inventory remains open.
- Fee in USDT is added to buy cost or deducted from sale proceeds. BUY fee in base reduces net bought quantity; SELL fee in base consumes extra FIFO units. BNB/other assets use Binance historical `ASSETUSDT` 1-minute close as a documented *valuation reference*, not an exact USD quote at fill time. Missing conversion means no verified close.
- PnL realized for each SELL fill is stored separately in `realized_events`; a partial trade has realized PnL **to date**, but is not a closed position.
- `gross_pnl_usdt = net_pnl_usdt + allocated trading fees` so fees are not deducted twice. Open inventory is not counted as closed profits.
- Stable `trade_id` uses logical account alias, symbol, Binance BUY order ID. Stable Firestore doc ID is SHA-256 of this key; repeat reconciliation overwrites the same document. `alpha_trades_mvp` retains original per-symbol fills and orders in `replay` (bounded to 800kB per doc), enabling deterministic replay from Firestore.
- Any foreign activity on the symbol, incomplete fills or inventory inconsistency is an anomaly. An unsuccessful symbol reconciliation is never counted complete.
- This ledger measures the scoped managed Spot history, not Binance's complete wealth. Default `ALPHA_SINCE=2026-10-30T00:00:00Z` is a **scope boundary**, not a claim that no earlier trades existed. Change scope explicitly when necessary.
- Account equity at entry is recorded only if the entry's existing `GROWTH_ENGINE_V1 equity_usdt` log is tied to the **same Binance orderId**; otherwise `null`. `capital_allocated_usdt` is the filled BUY notional, never substituted for equity.
- Radar V4.2 score uses `v42_norm`. QUBO score uses radar `utility`, which in the verified code is `productionUtility(...).toFixed(6)`; it is distinct from `qubo_objective`. Entry V6.1 uses an existing `APPROVED_V61` log bound to a real order ID. Missing or overwritten logs remain `null`.
- Strategy hash is SHA-256 of an allowlist of actual repo/runtime strategy files and the adaptive configuration when present; only captured near the original signal. Historical unknown versions stay null. An independent `capture.cjs --watch` process copies evidence; no trading script requires this process.
- Exit reason comes from the existing `exit-decisions.jsonl` bound to buyOrderId or, if confirmed, the native protective-stop order type. Otherwise null.

## Commands (Node.js >=20)

```sh
node --test backend/alpha-mvp/mvp.test.cjs
# Authenticated Binance GET-only, prints totals, does not write Firestore:
ALPHA_SINCE=2026-10-30T00:00:00Z node backend/alpha-mvp/reconcile.cjs --symbols BTCUSDT
# Explicit opt-in to save reconciled trades in Firestore:
node backend/alpha-mvp/reconcile.cjs --write-firestore
# Firestore-only replay by Firestore document ID, not raw Binance order number:
node backend/alpha-mvp/reconcile.cjs --replay <firestore_document_id>
# Generate previous Punta Arenas calendar day's text from Firestore:
node backend/alpha-mvp/morning-report.cjs
```

Credentials for Binance: `BINANCE_API_KEY`/`BINANCE_SECRET_KEY` or existing `CREDENTIALS_DIRECTORY`. Firebase Admin uses existing `backend/firebase-admin-config.js` and requires configured application-default credentials. **Never commit credentials or a populated state directory**.

## Scheduling and real deployment prerequisites

Optional, isolated systemd units live in `deploy/hetzner/alpha-mvp/`. `alpha-capture.service` samples existing local evidence every 5 seconds; `alpha-daily.timer` calls GET-only reconciliation and text reporting at **08:00 America/Punta_Arenas**, previous local calendar day. Output: `/var/lib/proypers25/alpha-mvp/reports/YYYY-MM-DD.txt` and journal logs.

**These unit files are not installed by GitHub merge.** Before installation, verify the running VPS repo/runtime hashes, service user `proypers25` (edit units if different), Node binary, read-only Binance credentials, Firestore ADC and permissions to state directories. Check calendar with `systemd-analyze calendar '*-*-* 08:00:00 America/Punta_Arenas'`; install to `/etc/systemd/system/` and enable watcher + timer only after dry-run tests. Do not restart or redeploy the trading engine.

## Financial validation caveats

`COMPLETE` requires a recent clean reconciliation. The report explicitly marks **PARCIAL / NO VERIFICADA** when current evidence is missing or errors occur. Win Rate and Profit Factor use *closed, reconciled lifetime trades*; daily PnL uses dated real sale fills and includes partially closed trade realization. Therefore closed-trade PF and the daily PnL numerator can be based on different populations. ROI on capital and patrimonial drawdown are **N/D** until a verified, comparable equity series exists; neither should be synthesized from closed PnL.

Historical missing signals, strategy snapshots or entry equity cannot be recreated reliably, and the report flags missing causal metadata. Source code plus passing mocks do **not** establish successful VPS deployment or live Binance reconciliation.
