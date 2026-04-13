const { getBinanceBotConfig } = require('./binanceBotConfig');
const { getFuturesWalletBalance, getFuturesIncomeHistory } = require('./binanceFuturesExecutor');

const EQUITY_CURVE_CACHE_TTL_MS = Math.max(
  30 * 1000,
  Number(process.env.EQUITY_CURVE_CACHE_TTL_MS || 2 * 60 * 1000)
);
const EQUITY_CURVE_LOOKBACK_DAYS = Math.max(
  7,
  Math.min(90, Number(process.env.EQUITY_CURVE_LOOKBACK_DAYS || 90))
);
const EQUITY_CURVE_MAX_INCOME_ROWS = Math.max(
  500,
  Math.min(20000, Number(process.env.EQUITY_CURVE_MAX_INCOME_ROWS || 5000))
);

let cache = {
  fetchedAt: 0,
  key: '',
  payload: null
};

function toNum(value, fallback = 0) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(toNum(value, 0) * 10000) / 10000;
}

function toUnixSeconds(value) {
  const date = new Date(value || 0);
  const time = Math.floor(date.getTime() / 1000);
  return Number.isFinite(time) && time > 0 ? time : Math.floor(Date.now() / 1000);
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  if (typeof value === 'number') return value;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function outcomeFromTrade(trade = {}) {
  const rawNet = String(trade?.win_exchange_net || '').toUpperCase();
  if (rawNet.includes('WIN')) return 'WIN';
  if (rawNet.includes('LOSS')) return 'LOSS';
  if (rawNet.includes('BREAKEVEN')) return 'BREAKEVEN';
  const raw = String(trade?.win_exchange || '').toUpperCase();
  if (raw.includes('WIN')) return 'WIN';
  if (raw.includes('LOSS')) return 'LOSS';
  if (raw.includes('BREAKEVEN')) return 'BREAKEVEN';
  const pnlPct = toNum(trade?.net_close_pnl_pct, toNum(trade?.close_pnl_pct, 0));
  if (pnlPct > 0) return 'WIN';
  if (pnlPct < 0) return 'LOSS';
  return 'BREAKEVEN';
}

function sourceLabel(sourceProfile = '') {
  const source = String(sourceProfile || '').toLowerCase();
  if (source === 'high_conviction') return 'HC';
  if (source === 'event_emitted') return 'Event';
  if (source === 'manual_prealert') return 'Manual';
  return source || 'N/A';
}

async function getEquityCurveSettings(db) {
  try {
    const doc = await db.collection('analytics_settings').doc('equity_curve').get();
    return doc.exists ? doc.data() || {} : {};
  } catch (_) {
    return {};
  }
}

function resolveInitialCapital(options = {}, settings = {}, config = {}) {
  return Math.max(
    1,
    toNum(
      options.initialCapital,
      toNum(
        settings?.initial_capital_usdt,
        toNum(process.env.EQUITY_CURVE_INITIAL_CAPITAL_USDT, toNum(config?.account_capital_usdt, 100))
      )
    )
  );
}

function resolveTradeNotional(trade = {}) {
  const entryPrice = toNum(trade?.entry_price, null);
  const quantity = toNum(trade?.quantity, null);
  if (Number.isFinite(entryPrice) && Number.isFinite(quantity) && entryPrice > 0 && quantity > 0) {
    return entryPrice * quantity;
  }
  return null;
}

function resolveClosePnlAmount(trade = {}) {
  const explicit =
    toNum(trade?.net_close_pnl_amount, null) ??
    toNum(trade?.close_pnl_amount, null) ??
    toNum(trade?.realized_pnl, null) ??
    toNum(trade?.pnl_amount, null);
  if (Number.isFinite(explicit)) return explicit;

  const notional = resolveTradeNotional(trade);
  const pnlPct = toNum(trade?.net_close_pnl_pct, toNum(trade?.close_pnl_pct, null));
  if (Number.isFinite(notional) && Number.isFinite(pnlPct)) {
    return notional * (pnlPct / 100);
  }

  const entryPrice = toNum(trade?.entry_price, null);
  const closePrice = toNum(trade?.close_price, null);
  const quantity = toNum(trade?.quantity, null);
  const side = String(trade?.side || '').toUpperCase();
  if (Number.isFinite(entryPrice) && Number.isFinite(closePrice) && Number.isFinite(quantity) && quantity > 0) {
    const move = side === 'SELL' ? entryPrice - closePrice : closePrice - entryPrice;
    return move * quantity;
  }

  return 0;
}

function resolvePnlAmountFromPercent(trade = {}, pct) {
  const notional = resolveTradeNotional(trade);
  if (!Number.isFinite(notional) || !Number.isFinite(pct)) return null;
  return notional * (pct / 100);
}

function incomeEventKey(row = {}) {
  return [
    String(row?.incomeType || ''),
    String(row?.tranId || ''),
    String(row?.tradeId || ''),
    String(row?.time || ''),
    String(row?.income || ''),
    String(row?.symbol || '')
  ].join('|');
}

function normalizeIncomeRows(rows = [], asset = 'USDT') {
  const upperAsset = String(asset || 'USDT').toUpperCase();
  const deduped = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const eventTime = Number(row?.time || 0);
    const income = toNum(row?.income, null);
    if (!Number.isFinite(eventTime) || !Number.isFinite(income)) continue;
    if (String(row?.asset || '').toUpperCase() !== upperAsset) continue;
    deduped.set(incomeEventKey(row), {
      time: eventTime,
      income,
      asset: String(row?.asset || upperAsset),
      incomeType: String(row?.incomeType || 'UNKNOWN'),
      symbol: String(row?.symbol || ''),
      info: String(row?.info || ''),
      tranId: String(row?.tranId || ''),
      tradeId: String(row?.tradeId || '')
    });
  }

  return [...deduped.values()].sort((a, b) => a.time - b.time);
}

function isTransferLikeIncome(row = {}) {
  const incomeType = String(row?.incomeType || '').toUpperCase();
  return incomeType.includes('TRANSFER') || incomeType === 'WELCOME_BONUS';
}

function extractLeadingBaselineIncome(rows = [], declaredInitialCapital = 0) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (!normalizedRows.length || !Number.isFinite(declaredInitialCapital) || declaredInitialCapital <= 0) {
    return {
      baselineOffset: 0,
      rows: normalizedRows
    };
  }

  let baselineOffset = 0;
  let cutoffIndex = 0;

  while (cutoffIndex < normalizedRows.length) {
    const row = normalizedRows[cutoffIndex];
    if (!isTransferLikeIncome(row)) {
      break;
    }
    baselineOffset += toNum(row?.income, 0);
    cutoffIndex += 1;
  }

  const usefulBaseline = Math.abs(baselineOffset) >= Math.max(10, declaredInitialCapital * 0.25);
  return {
    baselineOffset: usefulBaseline ? roundMoney(baselineOffset) : 0,
    rows: usefulBaseline ? normalizedRows.slice(cutoffIndex) : normalizedRows
  };
}

async function fetchIncomeHistoryRange(asset, startTime, endTime, maxRows = EQUITY_CURVE_MAX_INCOME_ROWS) {
  let cursor = Math.max(0, Number(startTime || 0));
  const upperEnd = Math.max(cursor, Number(endTime || Date.now()));
  const rows = [];
  let safety = 0;

  while (cursor <= upperEnd && rows.length < maxRows && safety < 30) {
    const remaining = Math.max(1, maxRows - rows.length);
    const limit = Math.max(1, Math.min(1000, remaining));
    const batch = await getFuturesIncomeHistory({
      startTime: cursor,
      endTime: upperEnd,
      limit
    }).catch(() => []);
    const list = Array.isArray(batch) ? batch : [];
    if (!list.length) break;
    rows.push(...list);

    const latestTime = list.reduce((max, item) => {
      const value = Number(item?.time || 0);
      return Number.isFinite(value) && value > max ? value : max;
    }, cursor);

    if (list.length < limit || latestTime <= cursor) {
      break;
    }
    cursor = latestTime + 1;
    safety += 1;
  }

  return normalizeIncomeRows(rows, asset);
}

function resolveHistoryStartMs(options = {}, settings = {}) {
  const now = Date.now();
  const maxLookbackMs = EQUITY_CURVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const earliestAllowed = now - maxLookbackMs;
  const configured =
    toMillis(options.startTime) ||
    toMillis(settings?.start_time) ||
    toMillis(settings?.started_at) ||
    toMillis(settings?.equity_start_at);
  if (configured > 0) {
    return Math.max(earliestAllowed, Math.min(configured, now));
  }
  return earliestAllowed;
}

function buildEquityCandlesFromIncomeRows(rows = [], startCapital = 0, currentCapital = 0, historyStartMs = Date.now()) {
  const startValue = roundMoney(startCapital);
  const candles = [];
  let running = startValue;
  let peakEquity = startValue;
  let maxDrawdownPct = 0;
  let lastTime = Math.max(1, Math.floor(historyStartMs / 1000));

  candles.push({
    time: lastTime,
    open: startValue,
    high: startValue,
    low: startValue,
    close: startValue
  });

  for (const row of rows) {
    const incomeAmount = roundMoney(row.income);
    const open = roundMoney(running);
    const close = roundMoney(open + incomeAmount);
    let time = Math.floor(Number(row.time || 0) / 1000);
    if (!Number.isFinite(time) || time <= 0) {
      time = lastTime + 1;
    }
    if (time <= lastTime) {
      time = lastTime + 1;
    }
    lastTime = time;

    const high = roundMoney(Math.max(open, close));
    const low = roundMoney(Math.min(open, close));
    candles.push({ time, open, high, low, close });

    running = close;
    peakEquity = Math.max(peakEquity, high, close);
    const drawdownPct = peakEquity > 0 ? ((peakEquity - low) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  const rawCurveCapital = roundMoney(running);
  const walletSyncGap = roundMoney(currentCapital - rawCurveCapital);

  if (Number.isFinite(currentCapital) && currentCapital > 0 && Math.abs(walletSyncGap) > 0.0001) {
    const open = rawCurveCapital;
    const close = roundMoney(currentCapital);
    const time = Math.max(Math.floor(Date.now() / 1000), lastTime + 60);
    const high = roundMoney(Math.max(open, close));
    const low = roundMoney(Math.min(open, close));
    candles.push({ time, open, high, low, close });
    peakEquity = Math.max(peakEquity, high, close);
    const drawdownPct = peakEquity > 0 ? ((peakEquity - low) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    running = close;
  }

  return {
    candles,
    curveCapital: roundMoney(running),
    rawCurveCapital,
    walletSyncGap,
    maxDrawdownPct: roundMoney(maxDrawdownPct)
  };
}

async function getEquityCurveSnapshot(db, options = {}) {
  const refresh = options.refresh === true;
  const maxTrades = Math.max(50, Math.min(10000, Number(options.maxTrades || 5000)));
  const key = JSON.stringify({ maxTrades });
  const now = Date.now();

  if (!refresh && cache.payload && cache.key === key && now - cache.fetchedAt < EQUITY_CURVE_CACHE_TTL_MS) {
    return {
      cached: true,
      payload: cache.payload
    };
  }

  const [config, settings, walletBalance, snapshot] = await Promise.all([
    getBinanceBotConfig(db),
    getEquityCurveSettings(db),
    getFuturesWalletBalance('USDT').catch(() => null),
    db.collection('binance_open_positions').orderBy('closed_at', 'desc').limit(Math.max(maxTrades * 4, 200)).get()
  ]);

  const declaredInitialCapital = resolveInitialCapital(options, settings, config);
  const historyStartMs = resolveHistoryStartMs(options, settings);
  const trades = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((trade) => String(trade?.status || '').toLowerCase() === 'closed' && trade?.closed_at)
    .slice(0, maxTrades)
    .sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());

  const walletCapital = roundMoney(
    toNum(
      walletBalance?.balance,
      toNum(walletBalance?.walletBalance, toNum(walletBalance?.crossWalletBalance, 0))
    )
  );
  const currentCapital = walletCapital > 0 ? walletCapital : declaredInitialCapital;
  const incomeRows = await fetchIncomeHistoryRange('USDT', historyStartMs, now, EQUITY_CURVE_MAX_INCOME_ROWS);
  const { baselineOffset, rows: effectiveIncomeRows } = extractLeadingBaselineIncome(incomeRows, declaredInitialCapital);
  const totalIncome = roundMoney(effectiveIncomeRows.reduce((sum, row) => sum + toNum(row?.income, 0), 0));
  const reconstructedInitialCapital = roundMoney(currentCapital - totalIncome);
  const initialCapital = declaredInitialCapital > 0 ? declaredInitialCapital : reconstructedInitialCapital;
  const incomeSeries = buildEquityCandlesFromIncomeRows(effectiveIncomeRows, initialCapital, currentCapital, historyStartMs);
  const initialCapitalSource =
    declaredInitialCapital > 0
      ? (settings?.initial_capital_usdt != null
        ? 'analytics_settings'
        : process.env.EQUITY_CURVE_INITIAL_CAPITAL_USDT
          ? 'env'
          : 'binance_bot_config_fallback')
      : 'binance_income_reconstructed';

  const candles = [...incomeSeries.candles];
  const markers = [];
  const tradePoints = [];
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let equity = initialCapital;
  let lastTime = 0;

  for (const trade of trades) {
    const pnlPct = toNum(trade?.net_close_pnl_pct, toNum(trade?.close_pnl_pct, 0));
    const grossPnlPct = toNum(trade?.close_pnl_pct, pnlPct);
    const closePnlAmount = resolveClosePnlAmount(trade);
    const maxSeenPct = Math.max(toNum(trade?.profit_capture_max_seen_pct, pnlPct), pnlPct);
    const minSeenPct = Math.min(toNum(trade?.min_seen_pct, pnlPct), pnlPct);
    const maxSeenAmount = resolvePnlAmountFromPercent(trade, maxSeenPct);
    const minSeenAmount = resolvePnlAmountFromPercent(trade, minSeenPct);
    const open = roundMoney(equity);
    const close = roundMoney(open + closePnlAmount);
    const high = roundMoney(
      Math.max(
        open,
        Number.isFinite(maxSeenAmount) ? open + maxSeenAmount : open,
        close
      )
    );
    const low = roundMoney(
      Math.min(
        open,
        Number.isFinite(minSeenAmount) ? open + minSeenAmount : open,
        close
      )
    );
    let time = toUnixSeconds(trade?.closed_at || trade?.updated_at || trade?.opened_at);
    if (time <= lastTime) {
      time = lastTime + 1;
    }
    lastTime = time;

    equity = close;
    const outcome = outcomeFromTrade(trade);
    if (outcome === 'WIN') wins += 1;
    else if (outcome === 'LOSS') losses += 1;
    else breakevens += 1;

    const markerText = `${outcome === 'WIN' ? 'WIN' : outcome === 'LOSS' ? 'LOSS' : 'BE'} ${trade.symbol || 'N/A'} ${sourceLabel(trade.source_profile)} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}%`;
    markers.push({
      time,
      position: outcome === 'LOSS' ? 'aboveBar' : 'belowBar',
      color: outcome === 'WIN' ? '#16a34a' : outcome === 'LOSS' ? '#dc2626' : '#64748b',
      shape: outcome === 'WIN' ? 'arrowUp' : outcome === 'LOSS' ? 'arrowDown' : 'circle',
      text: markerText
    });

    tradePoints.push({
      id: trade.id,
      time,
      symbol: trade.symbol || 'N/A',
      source_profile: String(trade.source_profile || trade.source || 'unknown'),
      outcome,
      pnl_pct: pnlPct,
      gross_pnl_pct: grossPnlPct,
      pnl_amount: roundMoney(closePnlAmount),
      close_reason: trade.close_reason || null,
      closed_at: trade.closed_at || null,
      open,
      high,
      low,
      close
    });
  }

  const curveCapital = roundMoney(incomeSeries.curveCapital || currentCapital);
  const payload = {
    generated_at: new Date().toISOString(),
    candles,
    markers,
    trades: tradePoints,
    summary: {
      initial_capital: roundMoney(initialCapital),
      initial_capital_source: initialCapitalSource,
      current_capital: currentCapital,
      current_capital_source: walletCapital > 0
        ? (walletBalance?._cache_fallback ? 'binance_wallet_balance_cache' : 'binance_wallet_balance')
        : 'equity_curve_estimate',
      curve_capital: curveCapital,
      wallet_balance: walletCapital > 0 ? walletCapital : null,
      total_growth_pct: initialCapital > 0 ? roundMoney(((currentCapital - initialCapital) / initialCapital) * 100) : 0,
      total_trades: tradePoints.length,
      wins,
      losses,
      breakevens,
      max_drawdown_pct: incomeSeries.maxDrawdownPct,
      equity_series_source: 'binance_income_history',
      income_events: effectiveIncomeRows.length,
      reconstructed_initial_capital: reconstructedInitialCapital,
      declared_initial_capital: roundMoney(declaredInitialCapital),
      baseline_transfer_offset: baselineOffset,
      wallet_sync_gap: incomeSeries.walletSyncGap,
      history_start_at: new Date(historyStartMs).toISOString()
    }
  };

  cache = {
    fetchedAt: now,
    key,
    payload
  };

  return {
    cached: false,
    payload
  };
}

module.exports = {
  getEquityCurveSnapshot
};
