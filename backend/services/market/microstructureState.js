const TRADE_WINDOW_MS = Math.max(10000, Number(process.env.MARKET_STREAM_TRADE_WINDOW_MS || 60000));
const PRICE_HISTORY_WINDOW_MS = Math.max(10000, Number(process.env.MARKET_STREAM_PRICE_HISTORY_WINDOW_MS || 30000));
const VELOCITY_HISTORY_WINDOW_MS = Math.max(
  PRICE_HISTORY_WINDOW_MS,
  Number(process.env.MARKET_STREAM_VELOCITY_HISTORY_WINDOW_MS || 60000)
);
const {
  normalizeToBinance,
  isValidBinanceFuturesSymbol
} = require('../utils/symbolNormalizer');
const OBSERVATION_DEFAULT_TTL_MS = Math.max(
  30 * 1000,
  Number(process.env.MARKET_STREAM_OBSERVATION_TTL_MS || 20 * 60 * 1000)
);
const SYMBOL_STATE_RETENTION_MS = Math.max(
  OBSERVATION_DEFAULT_TTL_MS,
  Number(process.env.MARKET_STREAM_STATE_RETENTION_MS || 60 * 60 * 1000)
);
const EVENT_TS_SKEW_TOLERANCE_MS = Math.max(
  5000,
  Number(process.env.MARKET_STREAM_EVENT_TS_SKEW_TOLERANCE_MS || 5 * 60 * 1000)
);
const MARKET_STREAM_DEBUG_SYMBOL_RAW = process.env.MARKET_STREAM_DEBUG_SYMBOL || '';
const MARKET_STREAM_DEBUG_LOG_THROTTLE_MS = Math.max(
  2000,
  Number(process.env.MARKET_STREAM_DEBUG_LOG_THROTTLE_MS || 10000)
);

function normalizeSymbol(symbol) {
  const normalized = normalizeToBinance(symbol);
  if (!normalized || !isValidBinanceFuturesSymbol(normalized)) return null;
  return normalized;
}

function trimWindow(items, minTimestamp) {
  if (!Array.isArray(items) || !items.length) return [];
  return items.filter((item) => Number(item?.ts || 0) >= minTimestamp);
}

function resolveEventTimestamp(exchangeTs, fallbackTs) {
  const normalizedFallback = Number.isFinite(Number(fallbackTs)) ? Number(fallbackTs) : Date.now();
  const normalizedExchange = Number(exchangeTs || 0);
  if (!Number.isFinite(normalizedExchange) || normalizedExchange <= 0) {
    return normalizedFallback;
  }
  if (Math.abs(normalizedExchange - normalizedFallback) > EVENT_TS_SKEW_TOLERANCE_MS) {
    return normalizedFallback;
  }
  return normalizedExchange;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function computeSpreadBps(bid, ask) {
  const bestBid = Number(bid || 0);
  const bestAsk = Number(ask || 0);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
    return null;
  }
  const mid = (bestBid + bestAsk) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return ((bestAsk - bestBid) / mid) * 10000;
}

function computeVelocityBpsPerSec(priceHistory = []) {
  if (!Array.isArray(priceHistory) || priceHistory.length < 2) return null;
  const first = priceHistory[0];
  const last = priceHistory[priceHistory.length - 1];
  const basePrice = Number(first?.price || 0);
  const latestPrice = Number(last?.price || 0);
  const elapsedMs = Number(last?.ts || 0) - Number(first?.ts || 0);
  if (!Number.isFinite(basePrice) || !Number.isFinite(latestPrice) || basePrice <= 0 || elapsedMs <= 0) {
    return null;
  }
  const elapsedSeconds = elapsedMs / 1000;
  return (((latestPrice - basePrice) / basePrice) * 10000) / elapsedSeconds;
}

function normalizePriceSeries(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => ({
      ts: Number(item?.ts || 0),
      price: Number(item?.price || 0)
    }))
    .filter((item) => Number.isFinite(item.ts) && item.ts > 0 && Number.isFinite(item.price) && item.price > 0)
    .sort((a, b) => a.ts - b.ts);
}

function computeAccelerationBpsPerSec2(velocityHistory = []) {
  if (!Array.isArray(velocityHistory) || velocityHistory.length < 2) return null;
  const first = velocityHistory[0];
  const last = velocityHistory[velocityHistory.length - 1];
  const elapsedMs = Number(last?.ts || 0) - Number(first?.ts || 0);
  if (elapsedMs <= 0) return null;
  const elapsedSeconds = elapsedMs / 1000;
  return (Number(last?.velocity || 0) - Number(first?.velocity || 0)) / elapsedSeconds;
}

function computeTradeFlowImbalance(trades = []) {
  if (!Array.isArray(trades) || !trades.length) return null;
  let buyQty = 0;
  let sellQty = 0;
  for (const trade of trades) {
    const qty = Number(trade?.qty || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (Number(trade?.aggressor_side || 0) >= 0) {
      buyQty += qty;
    } else {
      sellQty += qty;
    }
  }
  const total = buyQty + sellQty;
  if (total <= 0) return null;
  return clamp((buyQty - sellQty) / total, -1, 1);
}

function extractObservationSummary(observationReasons) {
  return Array.from(observationReasons.values()).map((item) => ({
    key: item.key,
    reason: item.reason,
    priority: item.priority,
    expires_at: item.expires_at ? new Date(item.expires_at).toISOString() : null,
    metadata: item.metadata || null
  }));
}

function shouldDebugSymbol(symbol) {
  if (!MARKET_STREAM_DEBUG_SYMBOL_RAW) return false;
  return normalizeSymbol(symbol) === normalizeSymbol(MARKET_STREAM_DEBUG_SYMBOL_RAW);
}

class MicrostructureState {
  constructor() {
    this.symbolStates = new Map();
    this.diagnostics = {
      snapshot_builds: 0,
      recent_trades_window_zero: 0,
      velocity_null: 0,
      acceleration_null: 0,
      recent_trades_window_positive: 0,
      velocity_fallback_used: 0,
      acceleration_fallback_used: 0,
      last_reset_at: new Date().toISOString()
    };
  }

  getOrCreateSymbolState(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return null;
    if (!this.symbolStates.has(normalized)) {
      this.symbolStates.set(normalized, {
        symbol: normalized,
        last_price: null,
        bid: null,
        ask: null,
        spread_bps: null,
        recent_trades_window: [],
        price_history: [],
        velocity_history: [],
        trade_flow_imbalance: null,
        micro_high: null,
        micro_low: null,
        last_update_ts: null,
        last_snapshot: null,
        last_published_at: null,
        observation_reasons: new Map(),
        last_trade_ts: null,
        last_debug_trade_log_at: null,
        last_debug_metrics_log_at: null
      });
    }
    return this.symbolStates.get(normalized);
  }

  prune(now = Date.now()) {
    for (const [symbol, state] of this.symbolStates.entries()) {
      for (const [key, item] of state.observation_reasons.entries()) {
        if (item.expires_at && item.expires_at <= now) {
          state.observation_reasons.delete(key);
        }
      }
      const lastActivity = Math.max(
        Number(state.last_update_ts || 0),
        ...Array.from(state.observation_reasons.values()).map((item) => Number(item.expires_at || 0))
      );
      if (!state.observation_reasons.size && lastActivity > 0 && now - lastActivity > SYMBOL_STATE_RETENTION_MS) {
        this.symbolStates.delete(symbol);
      }
    }
  }

  ensureObservation(symbol, reason, options = {}) {
    const state = this.getOrCreateSymbolState(symbol);
    if (!state) return null;
    const key = String(options.key || reason || 'default');
    const ttlMs = Math.max(1000, Number(options.ttlMs || OBSERVATION_DEFAULT_TTL_MS));
    const now = Date.now();
    state.observation_reasons.set(key, {
      key,
      reason: String(reason || 'operational'),
      priority: Number(options.priority || 1),
      expires_at: ttlMs > 0 ? now + ttlMs : null,
      metadata: options.metadata || null
    });
    return this.buildSnapshot(state.symbol, now);
  }

  releaseObservation(symbol, reason, options = {}) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || !this.symbolStates.has(normalized)) return false;
    const state = this.symbolStates.get(normalized);
    const key = String(options.key || reason || 'default');
    state.observation_reasons.delete(key);
    this.prune();
    return true;
  }

  getObservedSymbols() {
    this.prune();
    return Array.from(this.symbolStates.values())
      .filter((state) => state.observation_reasons.size > 0)
      .map((state) => state.symbol);
  }

  listObservationReasons(symbol) {
    const state = this.getOrCreateSymbolState(symbol);
    if (!state) return [];
    return extractObservationSummary(state.observation_reasons);
  }

  recordAggTrade(symbol, payload = {}) {
    const state = this.getOrCreateSymbolState(symbol);
    if (!state) return null;
    const receivedAt = Number(payload._received_at || Date.now());
    const exchangeTs = Number(payload.T || payload.E || 0);
    const ts = resolveEventTimestamp(exchangeTs, receivedAt);
    const price = Number(payload.p || payload.price || 0);
    const qty = Number(payload.q || payload.quantity || 0);
    if (!Number.isFinite(price) || price <= 0) return null;

    state.last_price = price;
    state.last_update_ts = receivedAt;
    state.last_trade_ts = ts;
    state.recent_trades_window.push({
      ts,
      exchange_ts: Number.isFinite(exchangeTs) && exchangeTs > 0 ? exchangeTs : null,
      price,
      qty,
      aggressor_side: payload.m ? -1 : 1
    });
    state.price_history.push({
      ts,
      price
    });
    if (shouldDebugSymbol(state.symbol)) {
      const now = Date.now();
      if (!state.last_debug_trade_log_at || now - state.last_debug_trade_log_at >= MARKET_STREAM_DEBUG_LOG_THROTTLE_MS) {
        state.last_debug_trade_log_at = now;
        console.log('[MICROSTRUCTURE_TRADE_BUFFER]', JSON.stringify({
          symbol: state.symbol,
          buffer_size: state.recent_trades_window.length,
          price_history_points: state.price_history.length,
          last_trade_ts: state.last_trade_ts,
          received_at: receivedAt
        }));
      }
    }
    return this.buildSnapshot(state.symbol, receivedAt);
  }

  recordBookTicker(symbol, payload = {}) {
    const state = this.getOrCreateSymbolState(symbol);
    if (!state) return null;
    const receivedAt = Number(payload._received_at || Date.now());
    const exchangeTs = Number(payload.E || payload.T || 0);
    const ts = resolveEventTimestamp(exchangeTs, receivedAt);
    const bid = Number(payload.b || payload.bidPrice || payload.bid || 0);
    const ask = Number(payload.a || payload.askPrice || payload.ask || 0);
    const mid = average([bid > 0 ? bid : null, ask > 0 ? ask : null]);

    if (Number.isFinite(bid) && bid > 0) state.bid = bid;
    if (Number.isFinite(ask) && ask > 0) state.ask = ask;
    if (Number.isFinite(mid) && mid > 0) {
      state.last_price = mid;
      state.price_history.push({ ts, price: mid });
    }
    state.last_update_ts = receivedAt;
    return this.buildSnapshot(state.symbol, receivedAt);
  }

  buildSnapshot(symbol, now = Date.now()) {
    const state = this.getOrCreateSymbolState(symbol);
    if (!state) return null;
    const snapshotTs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const minTradeTs = snapshotTs - TRADE_WINDOW_MS;
    const minPriceTs = snapshotTs - PRICE_HISTORY_WINDOW_MS;
    const minVelocityTs = snapshotTs - VELOCITY_HISTORY_WINDOW_MS;
    state.recent_trades_window = trimWindow(state.recent_trades_window, minTradeTs);
    state.price_history = trimWindow(state.price_history, minPriceTs);
    state.velocity_history = trimWindow(state.velocity_history, minVelocityTs);

    const tradePrices = state.recent_trades_window.map((item) => Number(item?.price || 0)).filter((value) => value > 0);
    const priceCandidates = [
      ...tradePrices,
      Number(state.bid || 0),
      Number(state.ask || 0),
      Number(state.last_price || 0)
    ].filter((value) => Number.isFinite(value) && value > 0);

    if (priceCandidates.length > 0) {
      state.micro_high = Math.max(...priceCandidates);
      state.micro_low = Math.min(...priceCandidates);
    }

    state.spread_bps = computeSpreadBps(state.bid, state.ask);
    state.trade_flow_imbalance = computeTradeFlowImbalance(state.recent_trades_window);

    const effectivePriceHistory = normalizePriceSeries(
      state.price_history.length >= 2 ? state.price_history : state.recent_trades_window
    );
    let velocity = computeVelocityBpsPerSec(effectivePriceHistory);
    let velocityFallbackUsed = false;
    if (!Number.isFinite(velocity) && state.recent_trades_window.length > 0) {
      const lastVelocity = Number(state.velocity_history[state.velocity_history.length - 1]?.velocity || NaN);
      velocity = Number.isFinite(lastVelocity) ? lastVelocity : 0;
      velocityFallbackUsed = true;
    }
    if (Number.isFinite(velocity)) {
      state.velocity_history.push({ ts: snapshotTs, velocity });
    }
    let acceleration = computeAccelerationBpsPerSec2(state.velocity_history);
    let accelerationFallbackUsed = false;
    if (!Number.isFinite(acceleration) && state.recent_trades_window.length > 0) {
      acceleration = 0;
      accelerationFallbackUsed = true;
    }

    state.last_snapshot = {
      symbol: state.symbol,
      last_price: finiteOrNull(state.last_price),
      bid: finiteOrNull(state.bid),
      ask: finiteOrNull(state.ask),
      spread_bps: Number.isFinite(state.spread_bps) ? Number(state.spread_bps.toFixed(3)) : null,
      recent_trades_window: state.recent_trades_window.length,
      price_velocity_bps_per_sec: Number.isFinite(velocity) ? Number(velocity.toFixed(3)) : null,
      price_acceleration_bps_per_sec2: Number.isFinite(acceleration)
        ? Number(acceleration.toFixed(3))
        : null,
      trade_flow_imbalance: Number.isFinite(state.trade_flow_imbalance)
        ? Number(state.trade_flow_imbalance.toFixed(4))
        : null,
      micro_high: finiteOrNull(state.micro_high),
      micro_low: finiteOrNull(state.micro_low),
      last_update_ts: finiteOrNull(state.last_update_ts),
      last_trade_ts: finiteOrNull(state.last_trade_ts),
      price_history_points: effectivePriceHistory.length,
      velocity_history_points: state.velocity_history.length,
      velocity_fallback_used: velocityFallbackUsed,
      acceleration_fallback_used: accelerationFallbackUsed,
      observation_reasons: extractObservationSummary(state.observation_reasons)
    };

    this.diagnostics.snapshot_builds += 1;
    if (state.last_snapshot.recent_trades_window <= 0) {
      this.diagnostics.recent_trades_window_zero += 1;
    } else {
      this.diagnostics.recent_trades_window_positive += 1;
    }
    if (state.last_snapshot.price_velocity_bps_per_sec == null) {
      this.diagnostics.velocity_null += 1;
    }
    if (state.last_snapshot.price_acceleration_bps_per_sec2 == null) {
      this.diagnostics.acceleration_null += 1;
    }
    if (velocityFallbackUsed) {
      this.diagnostics.velocity_fallback_used += 1;
    }
    if (accelerationFallbackUsed) {
      this.diagnostics.acceleration_fallback_used += 1;
    }

    if (shouldDebugSymbol(state.symbol)) {
      const logNow = Date.now();
      if (!state.last_debug_metrics_log_at || logNow - state.last_debug_metrics_log_at >= MARKET_STREAM_DEBUG_LOG_THROTTLE_MS) {
        state.last_debug_metrics_log_at = logNow;
        console.log('[MICROSTRUCTURE_METRICS]', JSON.stringify({
          symbol: state.symbol,
          recent_trades_window: state.last_snapshot.recent_trades_window,
          price_velocity_bps_per_sec: state.last_snapshot.price_velocity_bps_per_sec,
          price_acceleration_bps_per_sec2: state.last_snapshot.price_acceleration_bps_per_sec2,
          trade_flow_imbalance: state.last_snapshot.trade_flow_imbalance,
          last_trade_ts: state.last_snapshot.last_trade_ts,
          price_history_points: state.last_snapshot.price_history_points
        }));
      }
    }

    return state.last_snapshot;
  }

  getSnapshot(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || !this.symbolStates.has(normalized)) return null;
    return this.buildSnapshot(normalized, Date.now());
  }

  getWorkerState() {
    this.prune();
    return this.getObservedSymbols().map((symbol) => this.getSnapshot(symbol)).filter(Boolean);
  }

  markPublished(symbol, publishedAt = Date.now()) {
    const state = this.getOrCreateSymbolState(symbol);
    if (!state) return;
    state.last_published_at = publishedAt;
  }

  getDiagnostics() {
    const total = Math.max(0, Number(this.diagnostics.snapshot_builds || 0));
    const toPct = (count) => (total > 0 ? Number(((Number(count || 0) / total) * 100).toFixed(2)) : null);
    return {
      ...this.diagnostics,
      recent_trades_window_zero_pct: toPct(this.diagnostics.recent_trades_window_zero),
      velocity_null_pct: toPct(this.diagnostics.velocity_null),
      acceleration_null_pct: toPct(this.diagnostics.acceleration_null),
      velocity_fallback_used_pct: toPct(this.diagnostics.velocity_fallback_used),
      acceleration_fallback_used_pct: toPct(this.diagnostics.acceleration_fallback_used)
    };
  }
}

const microstructureState = new MicrostructureState();

module.exports = {
  MicrostructureState,
  microstructureState,
  normalizeSymbol
};
