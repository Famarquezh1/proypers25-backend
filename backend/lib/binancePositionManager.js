const { FieldValue } = require('firebase-admin/firestore');
const { getBinanceBotConfig } = require('./binanceBotConfig');
const {
  getMarkPrice,
  getPositionRisk,
  closePositionMarket
} = require('./binanceFuturesExecutor');

const BINANCE_POSITION_MANAGER_ENABLED = process.env.BINANCE_POSITION_MANAGER_ENABLED === 'true';
const BINANCE_POSITION_MANAGER_MAX_OPEN = Math.max(1, Number(process.env.BINANCE_POSITION_MANAGER_MAX_OPEN || 20));
const BINANCE_POSITION_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
const BINANCE_EARLY_EXIT_MIN_PROFIT_PCT = Number(process.env.BINANCE_EARLY_EXIT_MIN_PROFIT_PCT || 0.1);

function nowIso() {
  return new Date().toISOString();
}

function pnlPctFor(side, entry, mark) {
  if (!entry || !mark) return 0;
  if (side === 'BUY') return ((mark - entry) / entry) * 100;
  if (side === 'SELL') return ((entry - mark) / entry) * 100;
  return 0;
}

function getOpenMinutes(openedAt) {
  const openedMs = new Date(openedAt || 0).getTime();
  if (!Number.isFinite(openedMs) || openedMs <= 0) return 0;
  return (Date.now() - openedMs) / 60000;
}

function shouldEarlyExit(position, config, markPrice) {
  const side = position?.side;
  const entry = Number(position?.entry_price || 0);
  const pnlPct = pnlPctFor(side, entry, markPrice);
  const openedMinutes = getOpenMinutes(position?.opened_at);
  const drawdown = Number(position?.early_exit_drawdown_pct ?? config?.early_exit_drawdown_pct ?? 0.25);

  if (position?.early_exit_enabled || config?.early_exit_enabled) {
    if (pnlPct <= -Math.abs(drawdown)) {
      return { close: true, reason: 'early_exit_drawdown', pnl_pct: pnlPct, opened_minutes: openedMinutes };
    }
    if (openedMinutes >= 2 && pnlPct >= BINANCE_EARLY_EXIT_MIN_PROFIT_PCT) {
      return { close: true, reason: 'early_exit_lock_profit', pnl_pct: pnlPct, opened_minutes: openedMinutes };
    }
  }

  if (openedMinutes >= BINANCE_POSITION_MAX_HOLD_MINUTES) {
    return { close: true, reason: 'max_hold_reached', pnl_pct: pnlPct, opened_minutes: openedMinutes };
  }

  return { close: false, reason: 'hold', pnl_pct: pnlPct, opened_minutes: openedMinutes };
}

async function runBinancePositionManagerCycle(db) {
  if (!BINANCE_POSITION_MANAGER_ENABLED) {
    return { enabled: false, checked: 0, closed: 0, skipped: 0, failed: 0 };
  }

  const config = await getBinanceBotConfig(db);
  if (config.mode === 'off') {
    return { enabled: true, mode: 'off', checked: 0, closed: 0, skipped: 0, failed: 0 };
  }

  const openSnap = await db
    .collection('binance_open_positions')
    .where('status', '==', 'open')
    .limit(BINANCE_POSITION_MANAGER_MAX_OPEN)
    .get();

  let checked = 0;
  let closed = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of openSnap.docs) {
    checked += 1;
    const position = doc.data() || {};
    try {
      const symbol = position.symbol;
      const qty = Number(position.quantity || 0);
      if (!symbol || !qty) {
        skipped += 1;
        continue;
      }

      const markPrice = await getMarkPrice(symbol);
      const decision = shouldEarlyExit(position, config, markPrice);

      if (!decision.close) {
        await doc.ref.update({
          mark_price: markPrice,
          unrealized_pnl_pct: Number(decision.pnl_pct.toFixed(4)),
          opened_minutes: Number(decision.opened_minutes.toFixed(2)),
          manager_last_check_at: nowIso(),
          updated_at: FieldValue.serverTimestamp()
        });
        skipped += 1;
        continue;
      }

      if (config.mode === 'dry-run') {
        await doc.ref.update({
          mark_price: markPrice,
          unrealized_pnl_pct: Number(decision.pnl_pct.toFixed(4)),
          opened_minutes: Number(decision.opened_minutes.toFixed(2)),
          manager_last_check_at: nowIso(),
          manager_decision: { close: true, reason: decision.reason, dry_run: true },
          updated_at: FieldValue.serverTimestamp()
        });
        skipped += 1;
        continue;
      }

      const risk = await getPositionRisk(symbol);
      const positionAmt = Number(risk?.positionAmt || 0);
      const isAlreadyClosed = !positionAmt || Math.abs(positionAmt) < 0.0000001;
      let closeOrder = null;
      if (!isAlreadyClosed) {
        closeOrder = await closePositionMarket({
          symbol,
          side: position.side,
          quantity: qty
        });
      }

      await doc.ref.update({
        status: 'closed',
        closed_at: nowIso(),
        close_reason: decision.reason,
        manager_last_check_at: nowIso(),
        mark_price: markPrice,
        unrealized_pnl_pct: Number(decision.pnl_pct.toFixed(4)),
        opened_minutes: Number(decision.opened_minutes.toFixed(2)),
        close_order: closeOrder || { skipped: 'already_closed' },
        updated_at: FieldValue.serverTimestamp()
      });

      closed += 1;
    } catch (err) {
      failed += 1;
      await doc.ref.update({
        manager_last_check_at: nowIso(),
        manager_error: String(err?.message || err),
        updated_at: FieldValue.serverTimestamp()
      });
    }
  }

  const summary = {
    enabled: true,
    mode: config.mode,
    checked,
    closed,
    skipped,
    failed,
    max_hold_minutes: BINANCE_POSITION_MAX_HOLD_MINUTES,
    early_exit_min_profit_pct: BINANCE_EARLY_EXIT_MIN_PROFIT_PCT
  };

  await db.collection('binance_position_manager_logs').add({
    ...summary,
    created_at: FieldValue.serverTimestamp()
  });

  return summary;
}

module.exports = {
  runBinancePositionManagerCycle
};

