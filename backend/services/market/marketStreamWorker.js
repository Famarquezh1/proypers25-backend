const WebSocket = require('ws');
const { getBinanceBotConfig } = require('../../lib/binanceBotConfig');
const { microstructureState, normalizeSymbol } = require('./microstructureState');
const { marketSnapshotPublisher } = require('./marketSnapshotPublisher');
const { isValidBinanceFuturesSymbol } = require('../utils/symbolNormalizer');

const MARKET_STREAM_WS_URL =
  process.env.MARKET_STREAM_WS_URL || 'wss://fstream.binance.com/ws';
const MARKET_STREAM_RECONNECT_DELAY_MS = Math.max(
  2000,
  Number(process.env.MARKET_STREAM_RECONNECT_DELAY_MS || 5000)
);
const MARKET_STREAM_SNAPSHOT_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.MARKET_STREAM_SNAPSHOT_INTERVAL_MS || 2000)
);
const MARKET_STREAM_HEALTHCHECK_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.MARKET_STREAM_HEALTHCHECK_INTERVAL_MS || 5000)
);
const MARKET_STREAM_AGGTRADE_STALE_MS = Math.max(
  5000,
  Number(process.env.MARKET_STREAM_AGGTRADE_STALE_MS || 5000)
);
const MARKET_STREAM_STALE_SOCKET_MS = Math.max(
  MARKET_STREAM_HEALTHCHECK_INTERVAL_MS * 2,
  Number(process.env.MARKET_STREAM_STALE_SOCKET_MS || 20000)
);
const MARKET_STREAM_MAX_RECONNECT_ATTEMPTS = Math.max(
  1,
  Number(process.env.MARKET_STREAM_MAX_RECONNECT_ATTEMPTS || 3)
);
const MARKET_STREAM_DISABLE_MS = Math.max(
  5000,
  Number(process.env.MARKET_STREAM_DISABLE_MS || 10000)
);
const MARKET_STREAM_RECENT_SIGNAL_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.MARKET_STREAM_RECENT_SIGNAL_TTL_MS || 20 * 60 * 1000)
);
const MARKET_STREAM_ALLOWLIST_TTL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.MARKET_STREAM_ALLOWLIST_TTL_MS || 30 * 60 * 1000)
);
const MARKET_STREAM_POSITION_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.MARKET_STREAM_POSITION_TTL_MS || 30 * 60 * 1000)
);
const MARKET_STREAM_INTENT_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.MARKET_STREAM_INTENT_TTL_MS || 20 * 60 * 1000)
);

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function extractTimestampMs(value) {
  const date = parseDateLike(value);
  return date ? date.getTime() : null;
}

function normalizeFeatureMode(value, fallback = 'off') {
  const raw = String(value || fallback).trim().toLowerCase();
  if (raw === 'observe') return 'observe';
  if (raw === 'enforce') return 'enforce';
  if (raw === 'true') return 'observe';
  return 'off';
}

function isStreamEnabled(config) {
  const mode = normalizeFeatureMode(config?.market_stream?.mode || config?.market_stream?.enabled, 'off');
  return mode !== 'off';
}

function isSocketAlive(ws) {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

function logSymbolFlow({ symbol = null, source = null, stage = null, predictionId = null } = {}) {
  console.info('[SYMBOL_FLOW]', {
    symbol: symbol || null,
    source: source || null,
    stage: stage || null,
    prediction_id: predictionId || null
  });
}

function logSymbolError(context = {}) {
  console.error('[SYMBOL_ERROR]', context);
}

function resolveObservationSymbol(data = {}) {
  return normalizeSymbol(
    data?.symbol ||
      data?.simbolo ||
      data?.simbolo_normalizado ||
      data?.signal_symbol ||
      data?.intent?.symbol ||
      data?.intent?.signal_symbol ||
      data?.metadata?.symbol
  );
}

function logObservedSymbols(stage, source = 'market_stream') {
  for (const symbol of microstructureState.getObservedSymbols()) {
    logSymbolFlow({ symbol, source, stage });
  }
}

class MarketStreamWorker {
  constructor() {
    this.ws = null;
    this.db = null;
    this.started = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.snapshotTimer = null;
    this.healthTimer = null;
    this.subscriptionSeq = 1;
    this.activeSubscriptions = new Set();
    this.pendingSync = false;
    this.lastConfig = null;
    this.lastSocketOpenAt = null;
    this.lastSocketCloseAt = null;
    this.lastSocketError = null;
    this.lastMessageAt = null;
    this.lastAggTradeAt = null;
    this.lastBookTickerAt = null;
    this.totalMessages = 0;
    this.aggTradeMessages = 0;
    this.bookTickerMessages = 0;
    this.messagesBySymbol = new Map();
    this.reconnectAttempts = 0;
    this.lastReconnectDelayMs = null;
    this.lastMessageAtMs = 0;
    this.lastAggTradeAtMs = 0;
    this.lastBookTickerAtMs = 0;
    this.connectionSeq = 0;
    this.staleSocketDetections = 0;
    this.subscriptionSyncCount = 0;
    this.disabledUntilMs = 0;
    this.disabledReason = null;
  }

  async ensureStarted(db, config = null) {
    this.db = db || this.db;
    const effectiveConfig = config || this.lastConfig || (this.db ? await getBinanceBotConfig(this.db) : null);
    this.lastConfig = effectiveConfig;
    if (!isStreamEnabled(effectiveConfig)) {
      return false;
    }
    if (this.disabledUntilMs > Date.now()) {
      return false;
    }
    if (isSocketAlive(this.ws) && !this.isSocketStale()) {
      return true;
    }
    if (this.connecting) return true;
    this.started = true;
    this.connecting = true;
    this.connect();
    this.startSnapshotLoop();
    this.startHealthLoop();
    return true;
  }

  isSocketStale(now = Date.now()) {
    if (!this.lastMessageAtMs) return false;
    return now - this.lastMessageAtMs > MARKET_STREAM_STALE_SOCKET_MS;
  }

  resetSocketState() {
    this.activeSubscriptions.clear();
    this.lastSocketCloseAt = new Date().toISOString();
    this.lastMessageAt = null;
    this.lastAggTradeAt = null;
    this.lastBookTickerAt = null;
    this.lastMessageAtMs = 0;
    this.lastAggTradeAtMs = 0;
    this.lastBookTickerAtMs = 0;
    this.connecting = false;
  }

  disableStreamTemporarily(ms = MARKET_STREAM_DISABLE_MS, reason = 'temporary_disable') {
    const delayMs = Math.max(1000, Number(ms || MARKET_STREAM_DISABLE_MS));
    this.disabledUntilMs = Date.now() + delayMs;
    this.disabledReason = reason;
    this.reconnectAttempts = 0;
    this.lastReconnectDelayMs = delayMs;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_) {
        // noop
      }
      this.ws = null;
    }
    this.resetSocketState();
    logObservedSymbols('market_stream_disabled', reason);
    console.warn(`[MARKET_STREAM] disabled for ${delayMs}ms`, { reason });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.disabledUntilMs = 0;
      this.disabledReason = null;
      try {
        await this.ensureStarted(this.db, this.lastConfig);
        logObservedSymbols('market_stream_reenabled', reason);
      } catch (err) {
        console.warn('[MARKET_STREAM] re-enable failed', err.message);
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  reconnectStream(reason = 'manual_reconnect') {
    if (this.disabledUntilMs > Date.now()) {
      return;
    }
    logObservedSymbols('market_stream_reconnect', reason);
    console.warn('[MARKET_STREAM] reconnect requested', { reason });
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_) {
        // noop
      }
      this.ws = null;
    }
    this.resetSocketState();
    this.scheduleReconnect();
  }

  connect() {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (_) {
        // noop
      }
      this.ws = null;
    }

    const ws = new WebSocket(MARKET_STREAM_WS_URL);
    const connectionId = ++this.connectionSeq;
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws || connectionId !== this.connectionSeq) return;
      this.connecting = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.activeSubscriptions.clear();
      this.reconnectAttempts = 0;
      this.lastReconnectDelayMs = null;
      this.disabledUntilMs = 0;
      this.disabledReason = null;
      this.lastSocketOpenAt = new Date().toISOString();
      this.lastSocketError = null;
      this.lastMessageAt = null;
      this.lastAggTradeAt = null;
      this.lastBookTickerAt = null;
      this.lastMessageAtMs = 0;
      this.lastAggTradeAtMs = 0;
      this.lastBookTickerAtMs = 0;
      console.log('[MARKET_STREAM] websocket connected');
      logObservedSymbols('market_stream_connected', 'market_stream');
      this.scheduleSync();
    });

    ws.on('message', async (raw) => {
      if (this.ws !== ws || connectionId !== this.connectionSeq) return;
      try {
        await this.handleMessage(raw);
      } catch (err) {
        console.warn('[MARKET_STREAM] message handling failed', err.message);
      }
    });

    ws.on('close', () => {
      if (this.ws !== ws || connectionId !== this.connectionSeq) return;
      this.ws = null;
      this.resetSocketState();
      console.warn('[MARKET_STREAM] websocket closed');
      if (this.started) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      if (this.ws !== ws || connectionId !== this.connectionSeq) return;
      this.lastSocketError = String(err?.message || err);
      console.warn('[MARKET_STREAM] websocket error', err.message);
    });
  }

  startSnapshotLoop() {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setInterval(async () => {
      try {
        await this.publishSnapshots();
      } catch (err) {
        console.warn('[MARKET_STREAM] snapshot publish failed', err.message);
      }
    }, MARKET_STREAM_SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer.unref?.();
  }

  startHealthLoop() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      try {
        if (!this.started) return;
        if (isSocketAlive(this.ws) && this.isSocketStale()) {
          this.staleSocketDetections += 1;
          console.warn('[MARKET_STREAM] stale socket detected, forcing reconnect');
          this.reconnectStream('stale_socket');
          return;
        }
        if (isSocketAlive(this.ws)) {
          const desiredStreamCount = microstructureState.getObservedSymbols()
            .flatMap((symbol) => this.buildStreamParams(symbol))
            .length;
          const aggTradeStale =
            this.lastAggTradeAtMs > 0 &&
            Date.now() - this.lastAggTradeAtMs > MARKET_STREAM_AGGTRADE_STALE_MS;
          if (desiredStreamCount !== this.activeSubscriptions.size) {
            this.scheduleSync();
          } else if (desiredStreamCount > 0 && aggTradeStale) {
            console.warn('[MARKET_STREAM] aggTrade feed stale, forcing resubscription');
            this.reconnectStream('aggtrade_stale');
          }
        }
        if (!isSocketAlive(this.ws) && !this.connecting) {
          this.scheduleReconnect();
        }
      } catch (err) {
        console.warn('[MARKET_STREAM] healthcheck failed', err.message);
      }
    }, MARKET_STREAM_HEALTHCHECK_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.disabledUntilMs > Date.now()) {
      return;
    }
    if (this.reconnectAttempts >= MARKET_STREAM_MAX_RECONNECT_ATTEMPTS) {
      this.disableStreamTemporarily(MARKET_STREAM_DISABLE_MS, 'max_reconnect_attempts');
      return;
    }
    const delayMs = Math.min(
      30000,
      MARKET_STREAM_RECONNECT_DELAY_MS * Math.max(1, this.reconnectAttempts + 1)
    );
    this.reconnectAttempts += 1;
    this.lastReconnectDelayMs = delayMs;
    console.warn(`[MARKET_STREAM] scheduling reconnect in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.ensureStarted(this.db, this.lastConfig);
      } catch (err) {
        console.warn('[MARKET_STREAM] reconnect failed', err.message);
      }
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  scheduleSync() {
    if (this.pendingSync) return;
    this.pendingSync = true;
    setTimeout(async () => {
      this.pendingSync = false;
      try {
        await this.syncSubscriptions();
      } catch (err) {
        console.warn('[MARKET_STREAM] subscription sync failed', err.message);
      }
    }, 250).unref?.();
  }

  buildStreamParams(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || !isValidBinanceFuturesSymbol(normalized)) return [];
    const lower = normalized.toLowerCase();
    return [`${lower}@aggTrade`, `${lower}@bookTicker`];
  }

  async syncSubscriptions() {
    const desiredSymbols = new Set(microstructureState.getObservedSymbols());
    const desiredStreams = new Set();
    for (const symbol of desiredSymbols) {
      for (const stream of this.buildStreamParams(symbol)) {
        desiredStreams.add(stream);
      }
    }

    const toSubscribe = [...desiredStreams].filter((stream) => !this.activeSubscriptions.has(stream));
    const toUnsubscribe = [...this.activeSubscriptions].filter((stream) => !desiredStreams.has(stream));
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (toSubscribe.length) {
      ws.send(
        JSON.stringify({
          method: 'SUBSCRIBE',
          params: toSubscribe,
          id: this.subscriptionSeq++
        })
      );
      toSubscribe.forEach((stream) => this.activeSubscriptions.add(stream));
    }

    if (toUnsubscribe.length) {
      ws.send(
        JSON.stringify({
          method: 'UNSUBSCRIBE',
          params: toUnsubscribe,
          id: this.subscriptionSeq++
        })
      );
      toUnsubscribe.forEach((stream) => this.activeSubscriptions.delete(stream));
    }
    this.subscriptionSyncCount += 1;
  }

  async handleMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    if (!text) return;
    const payload = JSON.parse(text);
    if (payload?.result !== undefined || payload?.id != null) return;

    const event = payload?.data || payload;
    const eventType = String(event?.e || '').toLowerCase();
    const symbol = normalizeSymbol(event?.s || event?.symbol);
    if (!symbol) return;
    this.totalMessages += 1;
    const receivedAtIso = new Date().toISOString();
    const receivedAtMs = Date.now();
    this.lastMessageAt = new Date().toISOString();
    this.lastMessageAtMs = receivedAtMs;
    this.messagesBySymbol.set(symbol, (this.messagesBySymbol.get(symbol) || 0) + 1);

    if (eventType === 'aggtrade') {
      this.aggTradeMessages += 1;
      this.lastAggTradeAt = receivedAtIso;
      this.lastAggTradeAtMs = receivedAtMs;
      microstructureState.recordAggTrade(symbol, {
        ...event,
        _received_at: receivedAtMs
      });
      return;
    }

    if (eventType === 'bookticker') {
      this.bookTickerMessages += 1;
      this.lastBookTickerAt = receivedAtIso;
      this.lastBookTickerAtMs = receivedAtMs;
      microstructureState.recordBookTicker(symbol, {
        ...event,
        _received_at: receivedAtMs
      });
    }
  }

  async publishSnapshots() {
    if (!this.db || !this.lastConfig?.market_stream?.snapshot_enabled) {
      return;
    }
    const symbols = microstructureState.getObservedSymbols();
    for (const symbol of symbols) {
      const snapshot = microstructureState.getSnapshot(symbol);
      if (!snapshot) continue;
      const published = await marketSnapshotPublisher.publishSnapshot(this.db, symbol, snapshot, {
        intervalMs: this.lastConfig?.market_stream?.snapshot_publish_interval_ms
      });
      if (published) {
        microstructureState.markPublished(symbol);
      }
    }
  }

  async ensureSymbolObservation(symbol, reason, options = {}) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) {
      logSymbolError({
        stage: 'market_stream_observe',
        source: reason || 'market_stream',
        prediction_id: options?.metadata?.prediction_id || null,
        symbol_raw: symbol || null
      });
      return null;
    }
    microstructureState.ensureObservation(normalized, reason, options);
    logSymbolFlow({
      symbol: normalized,
      source: reason || 'market_stream',
      stage: 'market_stream_observe',
      predictionId: options?.metadata?.prediction_id || null
    });
    await this.ensureStarted(options.db || this.db, options.config || this.lastConfig);
    this.scheduleSync();
    return microstructureState.getSnapshot(normalized);
  }

  releaseSymbolObservation(symbol, reason, options = {}) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return false;
    const released = microstructureState.releaseObservation(normalized, reason, options);
    this.scheduleSync();
    return released;
  }

  getSnapshot(symbol) {
    return microstructureState.getSnapshot(symbol);
  }

  async syncOperationalObservation(db, options = {}) {
    if (!db) return { enabled: false, observed_symbols: [] };
    const config = options.config || (await getBinanceBotConfig(db));
    this.lastConfig = config;
    if (!isStreamEnabled(config)) {
      return { enabled: false, observed_symbols: [] };
    }

    await this.ensureStarted(db, config);
    const now = Date.now();
    const signalLookbackMs = Math.max(
      60 * 1000,
      Number(options.signalLookbackMs || config?.market_stream?.recent_signal_ttl_ms || MARKET_STREAM_RECENT_SIGNAL_TTL_MS)
    );

    const [openSnap, intentSnap, signalSnap] = await Promise.all([
      db.collection('binance_open_positions').where('status', '==', 'open').limit(40).get(),
      db.collection('binance_execution_intents').orderBy('created_at', 'desc').limit(80).get(),
      db.collection('velas_predicciones').orderBy('timestamp', 'desc').limit(60).get()
    ]);

    const allowlistSymbols = new Set([
      ...(Array.isArray(config.symbols_allowlist) ? config.symbols_allowlist : []),
      ...(Array.isArray(config.execution_profiles?.high_conviction?.symbols_allowlist)
        ? config.execution_profiles.high_conviction.symbols_allowlist
        : [])
    ].map(normalizeSymbol).filter(Boolean));

    for (const symbol of allowlistSymbols) {
      await this.ensureSymbolObservation(symbol, 'allowlist', {
        db,
        config,
        key: `allowlist:${symbol}`,
        ttlMs: config?.market_stream?.allowlist_ttl_ms || MARKET_STREAM_ALLOWLIST_TTL_MS,
        priority: 1
      });
    }

    for (const doc of openSnap.docs) {
      const data = doc.data() || {};
      const symbol = resolveObservationSymbol(data);
      if (!symbol) {
        logSymbolError({
          stage: 'market_stream_open_position',
          source: 'binance_open_positions',
          prediction_id: data?.prediction_id || null,
          doc_id: doc.id,
          symbol_raw: data?.symbol || data?.signal_symbol || data?.simbolo || data?.simbolo_normalizado || null
        });
        continue;
      }
      await this.ensureSymbolObservation(symbol, 'open_position', {
        db,
        config,
        key: `position:${doc.id}`,
        ttlMs: config?.market_stream?.position_ttl_ms || MARKET_STREAM_POSITION_TTL_MS,
        priority: 5,
        metadata: {
          source_profile: data.source_profile || data.source || 'unknown'
        }
      });
    }

    for (const doc of intentSnap.docs) {
      const data = doc.data() || {};
      const createdAtMs = extractTimestampMs(data.created_at) || now;
      if (now - createdAtMs > MARKET_STREAM_INTENT_TTL_MS) continue;
      if (!['processing', 'executed'].includes(String(data.status || '').toLowerCase())) continue;
      const symbol = resolveObservationSymbol(data);
      if (!symbol) {
        logSymbolError({
          stage: 'market_stream_intent',
          source: 'binance_execution_intents',
          prediction_id: data?.prediction_id || null,
          doc_id: doc.id,
          symbol_raw:
            data?.intent?.symbol ||
            data?.symbol ||
            data?.signal_symbol ||
            data?.simbolo ||
            data?.simbolo_normalizado ||
            null
        });
        continue;
      }
      await this.ensureSymbolObservation(symbol, 'execution_intent', {
        db,
        config,
        key: `intent:${doc.id}`,
        ttlMs: config?.market_stream?.intent_ttl_ms || MARKET_STREAM_INTENT_TTL_MS,
        priority: 4,
        metadata: {
          status: data.status,
          source_profile: data.source_profile || data.source || 'unknown'
        }
      });
    }

    for (const doc of signalSnap.docs) {
      const data = doc.data() || {};
      const signalTsMs = extractTimestampMs(data.timestamp) || extractTimestampMs(data.created_at);
      if (!signalTsMs || now - signalTsMs > signalLookbackMs) continue;
      if (data.signal_emitted !== true) continue;
      const symbol = resolveObservationSymbol(data);
      if (!symbol) {
        logSymbolError({
          stage: 'market_stream_signal',
          source: 'velas_predicciones',
          prediction_id: data?.prediction_id || null,
          doc_id: doc.id,
          symbol_raw: data?.symbol || data?.simbolo || data?.simbolo_normalizado || null
        });
        continue;
      }
      await this.ensureSymbolObservation(symbol, 'recent_signal', {
        db,
        config,
        key: `signal:${doc.id}`,
        ttlMs: signalLookbackMs,
        priority: 3,
        metadata: {
          source_profile: data.source_profile || data.source || 'signal'
        }
      });
    }

    return {
      enabled: true,
      observed_symbols: microstructureState.getObservedSymbols(),
      active_streams: [...this.activeSubscriptions]
    };
  }

  getStatus() {
    const diagnostics = microstructureState.getDiagnostics();
    return {
      enabled: isStreamEnabled(this.lastConfig),
      started: this.started,
      connected: isSocketAlive(this.ws),
      observed_symbols: microstructureState.getObservedSymbols(),
      active_streams: [...this.activeSubscriptions],
      last_socket_open_at: this.lastSocketOpenAt,
      last_socket_close_at: this.lastSocketCloseAt,
      last_socket_error: this.lastSocketError,
      disabled_until_ms: this.disabledUntilMs || null,
      disabled_reason: this.disabledReason,
      last_message_at: this.lastMessageAt,
      last_agg_trade_at: this.lastAggTradeAt,
      last_book_ticker_at: this.lastBookTickerAt,
      reconnect_attempts: this.reconnectAttempts,
      last_reconnect_delay_ms: this.lastReconnectDelayMs,
      last_message_age_ms: this.lastMessageAtMs ? Math.max(0, Date.now() - this.lastMessageAtMs) : null,
      total_messages: this.totalMessages,
      agg_trade_messages: this.aggTradeMessages,
      book_ticker_messages: this.bookTickerMessages,
      stale_socket_detections: this.staleSocketDetections,
      subscription_sync_count: this.subscriptionSyncCount,
      messages_by_symbol: Object.fromEntries(this.messagesBySymbol),
      sample_snapshots: microstructureState.getWorkerState().slice(0, 10),
      diagnostics
    };
  }
}

const marketStreamWorker = new MarketStreamWorker();

module.exports = {
  MarketStreamWorker,
  marketStreamWorker,
  syncOperationalMarketObservation: (...args) => marketStreamWorker.syncOperationalObservation(...args),
  ensureSymbolObservation: (...args) => marketStreamWorker.ensureSymbolObservation(...args),
  releaseSymbolObservation: (...args) => marketStreamWorker.releaseSymbolObservation(...args),
  getMarketSnapshot: (...args) => marketStreamWorker.getSnapshot(...args),
  getMarketStreamStatus: () => marketStreamWorker.getStatus()
};
