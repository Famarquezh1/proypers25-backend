/**
 * IMPULSE EXECUTION ENGINE - Phases 4 & 5
 *
 * Ejecuta trades REALES en Binance
 * Implementa: Market entry, TP/SL, Trailing stop
 */

const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const { getRealOpenPositions } = require('./impulseRiskManager');
const { executeHighConvictionTrade } = require('../lib/binanceFuturesExecutor');

const db = admin.firestore();

const BINANCE_API = 'https://fapi.binance.com/fapi/v1';
const ORDER_TIMEOUT = 30000; // 30 seconds
const BINANCE_FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BINANCE_API_KEY = resolveBinanceCredential(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_FUTURES_API_KEY,
  process.env.BINANCE_KEY,
  process.env.BINANCE_APIKEY
);
const BINANCE_API_SECRET = resolveBinanceCredential(
  process.env.BINANCE_API_SECRET,
  process.env.BINANCE_FUTURES_API_SECRET,
  process.env.BINANCE_SECRET_KEY,
  process.env.BINANCE_SECRET
);
const BINANCE_RECV_WINDOW_MS = Math.max(5000, Number(process.env.BINANCE_SIGNED_RECV_WINDOW_MS || 10000));
const DEFAULT_LEVERAGE = 5;
const BINANCE_MIN_NOTIONAL_USDT = 5;
const BINANCE_SAFE_NOTIONAL_USDT = 5.5;
const SYMBOL_RULES_CACHE_TTL_MS = 10 * 60 * 1000;
const symbolRulesCache = new Map();
const EXIT_TAKE_PROFIT_PNL_PCT = 0.4;
const EXIT_STOP_LOSS_PNL_PCT = -0.6;
const MAX_HOLD_SECONDS = Math.max(1, Number(process.env.IMPULSE_MAX_HOLD_SECONDS || 120));
const MAX_HOLD_MS = MAX_HOLD_SECONDS * 1000;
const HARD_BLOCK_INTENT_MAX_AGE_MS = 30 * 1000;

// Risk parameters
const MAX_CONCURRENT_TRADES = 1;
const MAX_TRADES_PER_SYMBOL = 1;
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const POSITION_SIZE_PERCENT = 0.10;
const RISK_BLOCK_SOURCE_FILE = 'backend/services/impulseExecutionEngine.js';

function logRiskBlockSource(payload) {
  console.log('[RISK_BLOCK_SOURCE]', payload);
}

function resolveBinanceCredential(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const sanitized = String(candidate)
      .trim()
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\r/g, '')
      .replace(/\n/g, '')
      .trim();
    if (sanitized) return sanitized;
  }
  return '';
}

function buildSignedQuery(params) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function getDecimalPlaces(value) {
  const text = String(value || '').toLowerCase();
  if (!text || text === '0') return 0;
  if (text.includes('e-')) {
    const exp = Number(text.split('e-')[1]);
    return Number.isFinite(exp) ? exp : 0;
  }
  const dotIndex = text.indexOf('.');
  if (dotIndex < 0) return 0;
  return text.length - dotIndex - 1;
}

function roundToStep(value, stepSize, mode = 'floor') {
  const numericValue = Number(value);
  const numericStep = Number(stepSize);
  if (!Number.isFinite(numericValue) || !Number.isFinite(numericStep) || numericStep <= 0) {
    return numericValue;
  }
  const units = numericValue / numericStep;
  const roundedUnits = mode === 'ceil'
    ? Math.ceil(units - 1e-12)
    : Math.floor(units + 1e-12);
  const decimals = Math.min(12, Math.max(0, getDecimalPlaces(numericStep)));
  return Number((roundedUnits * numericStep).toFixed(decimals));
}

function directionFromPositionAmount(positionAmt) {
  return Number(positionAmt) > 0 ? 'UP' : 'DOWN';
}

function calcUnrealizedPnlPct(position) {
  const unrealizedProfit = Number(position?.unRealizedProfit || 0);
  const notionalAbs = Math.abs(Number(position?.notional || 0));
  if (!Number.isFinite(unrealizedProfit) || !Number.isFinite(notionalAbs) || notionalAbs <= 0) {
    return null;
  }
  return (unrealizedProfit / notionalAbs) * 100;
}

function calcDirectionalPnlPct(position) {
  const markPrice = Number(position?.markPrice || 0);
  const entryPrice = Number(position?.entryPrice || 0);
  const positionAmt = Number(position?.positionAmt || 0);
  if (!Number.isFinite(markPrice) || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(positionAmt) || positionAmt === 0) {
    return null;
  }
  const raw = ((markPrice - entryPrice) / entryPrice) * 100;
  return positionAmt > 0 ? raw : -raw;
}

function timestampToMs(value) {
  if (!value) return null;
  if (typeof value?.toMillis === 'function') {
    const millis = value.toMillis();
    return Number.isFinite(millis) ? millis : null;
  }
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSignalDetectionTimeMs(signal) {
  return timestampToMs(signal?.created_at_ms) ??
    timestampToMs(signal?.detected_at) ??
    timestampToMs(signal?.created_at) ??
    timestampToMs(signal?.signal_created_at) ??
    timestampToMs(signal?.timestamp);
}

function findOppositeSignal(symbol, positionDirection, pendingSignals = []) {
  return pendingSignals.find((signal) => {
    const signalSymbol = String(signal?.symbol || '').toUpperCase();
    const signalDirection = String(signal?.direction || '').toUpperCase();
    if (!signalSymbol || !signalDirection) return false;
    if (signalSymbol !== String(symbol || '').toUpperCase()) return false;
    if (signalDirection === String(positionDirection || '').toUpperCase()) return false;
    return true;
  }) || null;
}

async function getSymbolOrderRules(symbol) {
  const upperSymbol = String(symbol || '').toUpperCase();
  if (!upperSymbol) return null;
  const cached = symbolRulesCache.get(upperSymbol);
  if (cached && (Date.now() - cached.fetchedAt) < SYMBOL_RULES_CACHE_TTL_MS) {
    return cached.rules;
  }

  try {
    const response = await axios.get(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`, {
      timeout: ORDER_TIMEOUT
    });
    const symbols = Array.isArray(response?.data?.symbols) ? response.data.symbols : [];
    const symbolInfo = symbols.find((item) => String(item?.symbol || '').toUpperCase() === upperSymbol);
    if (!symbolInfo) return null;
    const filters = Array.isArray(symbolInfo.filters) ? symbolInfo.filters : [];
    const marketLot = filters.find((f) => f?.filterType === 'MARKET_LOT_SIZE');
    const lot = filters.find((f) => f?.filterType === 'LOT_SIZE');
    const activeLot = marketLot || lot || {};
    const rules = {
      stepSize: Number(activeLot.stepSize || lot?.stepSize || 0),
      minQty: Number(activeLot.minQty || lot?.minQty || 0),
      maxQty: Number(activeLot.maxQty || lot?.maxQty || 0)
    };
    symbolRulesCache.set(upperSymbol, {
      fetchedAt: Date.now(),
      rules
    });
    return rules;
  } catch (_) {
    return null;
  }
}

async function signedRequest(path, params = {}, method = 'GET') {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    throw new Error('missing_api_credentials');
  }
  const timestamp = Date.now();
  const query = buildSignedQuery({
    ...params,
    timestamp,
    recvWindow: BINANCE_RECV_WINDOW_MS
  });
  const signature = crypto
    .createHmac('sha256', BINANCE_API_SECRET)
    .update(query)
    .digest('hex');
  const url = `${BINANCE_FUTURES_BASE_URL}${path}?${query}&signature=${signature}`;
  const response = await axios({
    method,
    url,
    timeout: ORDER_TIMEOUT,
    headers: {
      'X-MBX-APIKEY': BINANCE_API_KEY
    }
  });
  return response.data;
}

const client = {
  async futuresLeverage(payload) {
    return signedRequest('/fapi/v1/leverage', payload, 'POST');
  },
  async futuresOrder(payload) {
    return signedRequest('/fapi/v1/order', payload, 'POST');
  },
  async futuresPositionRisk(symbol) {
    const data = await signedRequest('/fapi/v2/positionRisk', symbol ? { symbol } : {}, 'GET');
    return Array.isArray(data) ? data : [];
  }
};

async function forceLeverage(symbol) {
  await client.futuresLeverage({
    symbol,
    leverage: DEFAULT_LEVERAGE
  });
  console.log('[LEVERAGE_FORCED]', {
    symbol,
    leverage: DEFAULT_LEVERAGE
  });
}

async function getRecentClosedTradesForSymbol(symbol, windowMs) {
  const thresholdMs = Date.now() - windowMs;
  const snapshot = await db.collection('active_impulse_trades')
    .where('symbol', '==', symbol)
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .filter((trade) => trade?.closed_at && trade.closed_at.toMillis() > thresholdMs);
}

async function getOpenTradeTimesBySymbol() {
  const snapshot = await db.collection('active_impulse_trades')
    .where('status', '==', 'OPEN')
    .get();

  const openTradeTimesBySymbol = new Map();
  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const symbol = String(data.symbol || '').toUpperCase();
    if (!symbol) continue;
    const openTimeMs = timestampToMs(data.entry_time) ?? timestampToMs(data.created_at);
    if (!Number.isFinite(openTimeMs)) continue;
    const previous = openTradeTimesBySymbol.get(symbol);
    if (!Number.isFinite(previous) || openTimeMs < previous) {
      openTradeTimesBySymbol.set(symbol, openTimeMs);
    }
  }

  return openTradeTimesBySymbol;
}

async function syncClosedTradeBySymbol(symbol, reason, pnlPct = null, exitPrice = null, durationMs = null) {
  const snapshot = await db.collection('active_impulse_trades')
    .where('symbol', '==', symbol)
    .where('status', '==', 'OPEN')
    .get();

  if (snapshot.empty) return;

  const now = admin.firestore.Timestamp.now();
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'CLOSED',
      reason_exit: reason,
      exit_time: now,
      exit_price: exitPrice,
      pnl_pct: pnlPct,
      duration_ms: durationMs,
      closed_at: now,
      updated_at: now
    });
  });
  await batch.commit();
}

async function hasFreshExecutionIntent(symbol, side) {
  const threshold = new Date(Date.now() - HARD_BLOCK_INTENT_MAX_AGE_MS);
  const snapshot = await db.collection('binance_execution_intents')
    .where('created_at', '>=', threshold)
    .limit(50)
    .get();

  return snapshot.docs.some((doc) => {
    const data = doc.data() || {};
    const intentSymbol = String(data?.symbol || data?.intent?.symbol || '').toUpperCase();
    const intentSide = String(data?.intent?.side || '').toUpperCase();
    if (intentSymbol !== String(symbol || '').toUpperCase()) return false;
    if (intentSide !== String(side || '').toUpperCase()) return false;
    return true;
  });
}

// Exit parameters
const TP_MIN = 0.6; // +0.6%
const TP_MAX = 1.0; // +1.0%
const SL_MIN = -0.4; // -0.4%
const SL_MAX = -0.6; // -0.6%
const TRAILING_ACTIVATION = 0.3; // Activate trailing on +0.3%

/**
 * Check risk controls
 */
async function checkRiskControls(symbol) {
  try {
    // Check concurrent trades using Binance as source of truth
    const realPositionState = await getRealOpenPositions();
    if (!realPositionState.ok) {
      const result = { allowed: false, reason: `Real position check failed: ${realPositionState.reason}` };
      logRiskBlockSource({
        file: RISK_BLOCK_SOURCE_FILE,
        function: 'checkRiskControls',
        symbol,
        reason: result.reason,
        activeCount: null,
        maxConcurrent: MAX_CONCURRENT_TRADES,
        realBinancePositionsCount: null
      });
      console.log('[RISK_CHECK]', { symbol, allowed: result.allowed, reason: result.reason });
      return result;
    }
    if (realPositionState.openPositions.length === 0) {
      console.log('[RISK_OVERRIDE_NO_REAL_POSITION]', { symbol });
    } else if (realPositionState.openPositions.length >= MAX_CONCURRENT_TRADES) {
      const result = { allowed: false, reason: `Max concurrent trades (${MAX_CONCURRENT_TRADES}) reached` };
      logRiskBlockSource({
        file: RISK_BLOCK_SOURCE_FILE,
        function: 'checkRiskControls',
        symbol,
        reason: result.reason,
        activeCount: realPositionState.openPositions.length,
        maxConcurrent: MAX_CONCURRENT_TRADES,
        realBinancePositionsCount: realPositionState.openPositions.length
      });
      console.log('[RISK_CHECK]', { symbol, allowed: result.allowed, reason: result.reason });
      return result;
    }

    // Check trades per symbol
    const symbolTradesSnapshot = await db.collection('active_impulse_trades')
      .where('symbol', '==', symbol)
      .where('status', '==', 'OPEN')
      .get();

    if (symbolTradesSnapshot.size >= MAX_TRADES_PER_SYMBOL) {
      const result = { allowed: false, reason: `Max trades per symbol (${MAX_TRADES_PER_SYMBOL}) reached` };
      logRiskBlockSource({
        file: RISK_BLOCK_SOURCE_FILE,
        function: 'checkRiskControls',
        symbol,
        reason: result.reason,
        activeCount: symbolTradesSnapshot.size,
        maxConcurrent: MAX_CONCURRENT_TRADES,
        realBinancePositionsCount: realPositionState.openPositions.length
      });
      console.log('[RISK_CHECK]', { symbol, allowed: result.allowed, reason: result.reason });
      return result;
    }

    // Check cooldown
    const recentTrades = await getRecentClosedTradesForSymbol(symbol, COOLDOWN_MS);

    if (recentTrades.length > 0) {
      const result = { allowed: false, reason: `Cooldown active for ${symbol}` };
      logRiskBlockSource({
        file: RISK_BLOCK_SOURCE_FILE,
        function: 'checkRiskControls',
        symbol,
        reason: result.reason,
        activeCount: recentTrades.length,
        maxConcurrent: MAX_CONCURRENT_TRADES,
        realBinancePositionsCount: realPositionState.openPositions.length
      });
      console.log('[RISK_CHECK]', { symbol, allowed: result.allowed, reason: result.reason });
      return result;
    }

    const result = { allowed: true, reason: null };
    console.log('[RISK_CHECK]', { symbol, allowed: result.allowed, reason: result.reason });
    return result;

  } catch (error) {
    console.error(`[RISK_CHECK] Error:`, error.message);
    const result = { allowed: false, reason: `Error: ${error.message}` };
    logRiskBlockSource({
      file: RISK_BLOCK_SOURCE_FILE,
      function: 'checkRiskControls',
      symbol,
      reason: result.reason,
      activeCount: null,
      maxConcurrent: MAX_CONCURRENT_TRADES,
      realBinancePositionsCount: null
    });
    console.log('[RISK_CHECK]', { symbol, allowed: result.allowed, reason: result.reason });
    return result;
  }
}

/**
 * Execute market order on Binance
 */
async function executeMarketOrder(symbol, direction, quantity) {
  try {
    const side = direction === 'UP' ? 'BUY' : 'SELL';
    const orderPayload = {
      symbol,
      side,
      type: 'MARKET',
      quantity
    };
    let orderResponse;
    try {
      const freshIntentExists = await hasFreshExecutionIntent(symbol, side);
      if (!freshIntentExists) {
        console.log('[ORPHAN_ORDER_BLOCKED]', {
          symbol,
          side,
          reason: 'missing_recent_execution_intent'
        });
        return null;
      }
      console.log('[ORDER_PREPARED]', {
        symbol,
        leverage: DEFAULT_LEVERAGE,
        quantity
      });
      await forceLeverage(symbol);
      orderResponse = await client.futuresOrder(orderPayload);
      console.log('[ORDER_SENT]', { symbol });
    } catch (err) {
      const message = err?.response?.data?.msg || err?.message || String(err);
      const code = err?.response?.data?.code ?? err?.code ?? null;
      console.log('[BINANCE_ORDER_ERROR]', {
        message,
        code
      });
      return null;
    }

    return {
      orderId: orderResponse?.orderId || `IMPULSE_${Date.now()}`,
      symbol: orderResponse?.symbol || symbol,
      side: orderResponse?.side || side,
      quantity: Number(orderResponse?.origQty ?? quantity),
      status: orderResponse?.status || 'NEW',
      executed_at: admin.firestore.Timestamp.now()
    };

  } catch (error) {
    console.error('[BINANCE_ORDER_ERROR]', {
      message: error?.message || String(error),
      code: error?.code || null,
      symbol,
      side: direction === 'UP' ? 'BUY' : 'SELL'
    });
    console.error(`[MARKET_ORDER] Execution failed for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Execute impulse trade
 */
async function executeImpulseTrade(signal) {
  try {
    const { symbol, direction, confidence, entry_price, strength_score } = signal;
    const detectionTimeMs = getSignalDetectionTimeMs(signal);

    console.log(`[EXECUTION] Processing ${symbol} ${direction} | confidence: ${confidence.toFixed(3)}`);

    // Check risk controls first
    const riskCheck = await checkRiskControls(symbol);
    if (!riskCheck.allowed) {
      console.log('[EXECUTION_BLOCKED]', {
        reason: riskCheck.reason,
        symbol
      });
      console.log(`[EXECUTION] Blocked: ${riskCheck.reason}`);
      return null;
    }

    // Calculate position size (conservative: 0.25x)
    const positionSizePercent = POSITION_SIZE_PERCENT; // 10%
    const quantity = 1.0; // Simplified - real implementation would calculate based on account balance
    const side = direction === 'UP' ? 'BUY' : 'SELL';
    const leverage = DEFAULT_LEVERAGE;
    const price = Number(entry_price ?? 0);
    let finalQuantity = Number(quantity);
    const symbolRules = await getSymbolOrderRules(symbol);
    if (symbolRules?.stepSize > 0) {
      finalQuantity = roundToStep(finalQuantity, symbolRules.stepSize, 'floor');
    }
    if (symbolRules?.minQty > 0 && finalQuantity < symbolRules.minQty) {
      finalQuantity = symbolRules.stepSize > 0
        ? roundToStep(symbolRules.minQty, symbolRules.stepSize, 'ceil')
        : Number(symbolRules.minQty);
    }
    let notional = price > 0 ? price * finalQuantity : 0;
    if (price > 0 && notional < BINANCE_MIN_NOTIONAL_USDT) {
      const originalQty = finalQuantity;
      let adjustedQty = BINANCE_SAFE_NOTIONAL_USDT / price;
      if (symbolRules?.stepSize > 0) {
        adjustedQty = roundToStep(adjustedQty, symbolRules.stepSize, 'ceil');
      }
      if (symbolRules?.minQty > 0 && adjustedQty < symbolRules.minQty) {
        adjustedQty = symbolRules.stepSize > 0
          ? roundToStep(symbolRules.minQty, symbolRules.stepSize, 'ceil')
          : Number(symbolRules.minQty);
      }
      if (symbolRules?.stepSize > 0) {
        let guard = 0;
        while ((adjustedQty * price) < BINANCE_MIN_NOTIONAL_USDT && guard < 10) {
          adjustedQty = roundToStep(adjustedQty + symbolRules.stepSize, symbolRules.stepSize, 'ceil');
          guard += 1;
        }
      }
      finalQuantity = adjustedQty;
      notional = price * finalQuantity;
      console.log('[NOTIONAL_ADJUSTED]', {
        symbol,
        originalQty,
        newQty: finalQuantity,
        price,
        finalNotional: notional
      });
    }

    console.log('[EXECUTION_ATTEMPT]', {
      symbol,
      side,
      price: entry_price ?? null,
      size: finalQuantity
    });
    console.log('[ORDER_PAYLOAD]', {
      symbol,
      side,
      quantity: finalQuantity,
      price: entry_price ?? null,
      leverage
    });

    // Execute market order
    const orderResult = await executeMarketOrder(symbol, direction, finalQuantity);
    if (!orderResult) {
      console.error('[BINANCE_ORDER_ERROR]', {
        message: 'Order result is null',
        code: null
      });
      console.log(`[EXECUTION] Market order failed for ${symbol}`);
      return null;
    }

    const msFromDetection = Number.isFinite(detectionTimeMs)
      ? Math.max(0, Date.now() - detectionTimeMs)
      : null;
    if (Number.isFinite(msFromDetection)) {
      console.log('[EXECUTION_LATENCY]', {
        symbol,
        ms_from_detection: msFromDetection
      });
    }

    try {
      const positions = await client.futuresPositionRisk(symbol);
      const realPosition = positions.find((position) => Number(position?.positionAmt || 0) !== 0);
      if (realPosition) {
        console.log('[REAL_POSITION_OPENED]', {
          symbol,
          positionAmt: Number(realPosition.positionAmt)
        });
      }
    } catch (err) {
      const message = err?.response?.data?.msg || err?.message || String(err);
      const code = err?.response?.data?.code ?? err?.code ?? null;
      console.log('[BINANCE_ORDER_ERROR]', {
        message,
        code
      });
    }

    // Calculate TP/SL levels
    const moveRange = Math.max(strength_score, 0.5); // Scale 0.5% to 1.0%
    const tpTarget = TP_MIN + (Math.random() * (TP_MAX - TP_MIN)); // Random between 0.6-1.0%
    const slTarget = SL_MIN - (Math.random() * (Math.abs(SL_MAX) - Math.abs(SL_MIN))); // Random between -0.4 to -0.6%

    const tpPrice = direction === 'UP'
      ? entry_price * (1 + tpTarget / 100)
      : entry_price * (1 - tpTarget / 100);

    const slPrice = direction === 'UP'
      ? entry_price * (1 + slTarget / 100)
      : entry_price * (1 - slTarget / 100);

    const executedQuantity = Number(orderResult.quantity ?? finalQuantity);

    // Create trade record
    const tradeRecord = {
      trade_id: orderResult.orderId,
      symbol,
      direction,
      entry_price,
      entry_time: admin.firestore.Timestamp.now(),
      quantity: executedQuantity,
      position_size_percent: positionSizePercent,
      confidence,
      strength_score,
      tp_price: tpPrice,
      tp_target_pct: tpTarget,
      sl_price: slPrice,
      sl_target_pct: slTarget,
      trailing_activated: false,
      trailing_high: entry_price,
      status: 'OPEN',
      pnl: 0,
      pnl_pct: 0,
      reason_exit: null,
      exit_time: null,
      exit_price: null,
      duration_ms: null,
      impulse_metrics: signal.impulse_metrics,
      noise_metrics: signal.noise_metrics,
      created_at: admin.firestore.Timestamp.now(),
      closed_at: null
    };

    // Save to Firestore
    await db.collection('active_impulse_trades').doc(orderResult.orderId).set(tradeRecord);
    console.log('[REAL_TRADE_EXECUTED]', {
      symbol,
      side,
      price: entry_price ?? null,
      size: executedQuantity
    });

    console.log(`[TRADE_OPENED] ${symbol} ${direction} | Entry: ${entry_price.toFixed(4)} | TP: ${tpPrice.toFixed(4)} | SL: ${slPrice.toFixed(4)}`);

    return tradeRecord;

  } catch (error) {
    console.error(`[EXECUTION] Error executing trade for ${signal.symbol}:`, error.message);
    return null;
  }
}

async function closePositionReduceOnly(position, reason, pnlPct = null, durationMs = null) {
  try {
    const symbol = String(position?.symbol || '').toUpperCase();
    const positionAmt = Number(position?.positionAmt || 0);
    if (!symbol || !Number.isFinite(positionAmt) || positionAmt === 0) {
      return false;
    }

    const side = positionAmt > 0 ? 'SELL' : 'BUY';
    const absQty = Math.abs(positionAmt);
    const symbolRules = await getSymbolOrderRules(symbol);
    let closeQty = absQty;
    if (symbolRules?.stepSize > 0) {
      closeQty = roundToStep(closeQty, symbolRules.stepSize, 'floor');
    }
    if (symbolRules?.minQty > 0 && closeQty < symbolRules.minQty) {
      closeQty = symbolRules.stepSize > 0
        ? roundToStep(symbolRules.minQty, symbolRules.stepSize, 'ceil')
        : Number(symbolRules.minQty);
    }
    if (!Number.isFinite(closeQty) || closeQty <= 0) {
      return false;
    }

    console.log('[ORDER_PREPARED]', {
      symbol,
      leverage: DEFAULT_LEVERAGE,
      quantity: closeQty
    });
    await forceLeverage(symbol);
    await client.futuresOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity: closeQty,
      reduceOnly: true
    });
    console.log('[ORDER_SENT]', { symbol });

    const exitPrice = Number(position?.markPrice || 0);
    const exitPriceValue = Number.isFinite(exitPrice) && exitPrice > 0 ? exitPrice : null;
    await syncClosedTradeBySymbol(
      symbol,
      reason,
      Number.isFinite(Number(pnlPct)) ? Number(pnlPct) : null,
      exitPriceValue,
      Number.isFinite(durationMs) ? durationMs : null
    );

    console.log('[POSITION_AUTO_CLOSED_SAFE]', {
      symbol,
      reason
    });
    console.log('[EXIT_EXECUTED]', {
      symbol,
      pnl: pnlPct,
      reason
    });
    if (Number.isFinite(Number(pnlPct)) && Number(pnlPct) > 0) {
      console.log('[WIN_CONFIRMED]', {
        symbol,
        pnl: pnlPct
      });
    } else if (Number.isFinite(Number(pnlPct)) && Number(pnlPct) < 0) {
      console.log('[LOSS_CONFIRMED]', {
        symbol,
        pnl: pnlPct
      });
    }
    return true;
  } catch (err) {
    const message = err?.response?.data?.msg || err?.message || String(err);
    const code = err?.response?.data?.code ?? err?.code ?? null;
    console.log('[BINANCE_ORDER_ERROR]', {
      message,
      code
    });
    return false;
  }
}

async function runActivePositionSafetyControl(pendingSignals = []) {
  try {
    const positions = await client.futuresPositionRisk();
    const openPositions = positions.filter((position) => Number(position?.positionAmt || 0) !== 0);
    const openTradeTimesBySymbol = await getOpenTradeTimesBySymbol();

    for (const position of openPositions) {
      const symbol = String(position?.symbol || '').toUpperCase();
      const size = Number(position?.positionAmt || 0);
      const entryPrice = Number(position?.entryPrice || 0);
      const currentPrice = Number(position?.markPrice || 0);
      const unrealizedProfit = Number(position?.unRealizedProfit || 0);
      const pnlPct = calcDirectionalPnlPct(position);
      const positionDirection = directionFromPositionAmount(size);
      const oppositeSignal = findOppositeSignal(symbol, positionDirection, pendingSignals);
      const openTimeMs = openTradeTimesBySymbol.get(symbol) ?? timestampToMs(position?.updateTime);
      const durationMs = Number.isFinite(openTimeMs) ? Math.max(0, Date.now() - openTimeMs) : null;
      const durationSeconds = Number.isFinite(durationMs) ? Math.floor(durationMs / 1000) : null;

      console.log('[ACTIVE_POSITION_DETECTED]', {
        symbol,
        size,
        entryPrice,
        currentPrice,
        unrealizedProfit,
        entryTime: Number.isFinite(openTimeMs) ? new Date(openTimeMs).toISOString() : null,
        currentTime: new Date().toISOString(),
        duration_seconds: durationSeconds
      });

      let closeReason = null;
      if (Number.isFinite(durationMs) && durationMs > MAX_HOLD_MS) {
        closeReason = 'FORCE_CLOSE_TIMEOUT';
      } else if (Number.isFinite(pnlPct) && pnlPct >= EXIT_TAKE_PROFIT_PNL_PCT) {
        closeReason = 'TAKE_PROFIT';
      } else if (Number.isFinite(pnlPct) && pnlPct <= EXIT_STOP_LOSS_PNL_PCT) {
        closeReason = 'STOP_LOSS';
      } else if (oppositeSignal) {
        closeReason = 'OPPOSITE_SIGNAL';
      }

      if (closeReason) {
        const normalizedPnl = Number.isFinite(pnlPct) ? Number(pnlPct.toFixed(4)) : null;
        if (closeReason === 'FORCE_CLOSE_TIMEOUT') {
          console.log('[FORCE_CLOSE_TIMEOUT]', {
            symbol,
            duration_seconds: durationSeconds
          });
        }
        await closePositionReduceOnly(position, closeReason, normalizedPnl, durationMs);
      }
    }
  } catch (err) {
    const message = err?.response?.data?.msg || err?.message || String(err);
    const code = err?.response?.data?.code ?? err?.code ?? null;
    console.log('[BINANCE_ORDER_ERROR]', {
      message,
      code
    });
  }
}

/**
 * Process all pending impulse signals
 */
async function processImpulseSignals() {
  try {
    const signalsSnapshot = await db.collection('high_conviction_impulse_signals')
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();

    const executedTrades = [];
    const pendingSignals = signalsSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((signal) => signal.status === 'PENDING_EXECUTION')
      .slice(0, 10);

    await runActivePositionSafetyControl(pendingSignals);

    for (const signal of pendingSignals) {
      console.log('[TRADE_CANDIDATE]', {
        symbol: signal.symbol,
        qualityScore: signal.qualityScore ?? null
      });
      const executionResult = await executeHighConvictionTrade(db, {
        ...signal,
        source_profile: 'high_conviction',
        signal_id: signal.id
      });
      const now = admin.firestore.Timestamp.now();
      const signalUpdate = {
        execution_status: executionResult?.reason || (executionResult?.executed ? 'executed' : 'skipped'),
        execution_updated_at: now,
        execution_order_id: executionResult?.order_id || null
      };

      if (executionResult?.executed) {
        executedTrades.push({
          symbol: signal.symbol,
          direction: signal.direction,
          trade_id: executionResult.order_id || null
        });
        await db.collection('high_conviction_impulse_signals').doc(signal.id).update({
          ...signalUpdate,
          status: 'EXECUTED',
          executed_at: now
        });
        continue;
      }

      await db.collection('high_conviction_impulse_signals').doc(signal.id).update(signalUpdate);
    }

    return executedTrades;

  } catch (error) {
    console.error(`[SIGNAL_PROCESSOR] Error:`, error.message);
    return [];
  }
}

/**
 * Update open trades (check TP/SL/Trailing)
 *
 * In real implementation, this would:
 * 1. Get current price
 * 2. Check if TP/SL hit
 * 3. Update trailing stop
 * 4. Close trade if needed
 */
async function updateOpenTrades() {
  try {
    const tradesSnapshot = await db.collection('active_impulse_trades')
      .where('status', '==', 'OPEN')
      .get();

    const closedTrades = [];

    for (const doc of tradesSnapshot.docs) {
      const trade = { id: doc.id, ...doc.data() };

      // Simulate price update (real implementation would fetch from Binance)
      const currentPrice = trade.entry_price * (1 + (Math.random() * 0.02 - 0.01)); // Random ±1% for testing
      const pnlPct = trade.direction === 'UP'
        ? ((currentPrice - trade.entry_price) / trade.entry_price) * 100
        : ((trade.entry_price - currentPrice) / trade.entry_price) * 100;

      // Check TP
      if (trade.direction === 'UP' && currentPrice >= trade.tp_price) {
        closedTrades.push(await closeTrade(trade.id, 'TP_HIT', currentPrice, trade.tp_target_pct));
        continue;
      }

      if (trade.direction === 'DOWN' && currentPrice <= trade.tp_price) {
        closedTrades.push(await closeTrade(trade.id, 'TP_HIT', currentPrice, trade.tp_target_pct));
        continue;
      }

      // Check SL
      if (trade.direction === 'UP' && currentPrice <= trade.sl_price) {
        closedTrades.push(await closeTrade(trade.id, 'SL_HIT', currentPrice, trade.sl_target_pct));
        continue;
      }

      if (trade.direction === 'DOWN' && currentPrice >= trade.sl_price) {
        closedTrades.push(await closeTrade(trade.id, 'SL_HIT', currentPrice, trade.sl_target_pct));
        continue;
      }

      // Check trailing stop activation
      if (!trade.trailing_activated && Math.abs(pnlPct) >= TRAILING_ACTIVATION) {
        await db.collection('active_impulse_trades').doc(trade.id).update({
          trailing_activated: true,
          trailing_high: currentPrice
        });
        console.log(`[TRAILING_ACTIVATED] ${trade.symbol} | PNL: ${pnlPct.toFixed(2)}%`);
      }

      // Update PNL
      await db.collection('active_impulse_trades').doc(trade.id).update({
        current_price: currentPrice,
        pnl_pct: pnlPct,
        updated_at: admin.firestore.Timestamp.now()
      });
    }

    return closedTrades;

  } catch (error) {
    console.error(`[TRADE_UPDATE] Error:`, error.message);
    return [];
  }
}

/**
 * Close a trade
 */
async function closeTrade(tradeId, reason, exitPrice, exitPct) {
  try {
    const tradeSnapshot = await db.collection('active_impulse_trades').doc(tradeId).get();
    const trade = tradeSnapshot.data();

    const pnlPct = trade.direction === 'UP'
      ? ((exitPrice - trade.entry_price) / trade.entry_price) * 100
      : ((trade.entry_price - exitPrice) / trade.entry_price) * 100;

    const durationMs = Date.now() - trade.entry_time.toMillis();

    await db.collection('active_impulse_trades').doc(tradeId).update({
      status: 'CLOSED',
      exit_price: exitPrice,
      exit_time: admin.firestore.Timestamp.now(),
      pnl_pct: pnlPct,
      duration_ms: durationMs,
      reason_exit: reason,
      closed_at: admin.firestore.Timestamp.now()
    });

    console.log(`[TRADE_CLOSED] ${trade.symbol} | ${reason} | Exit: ${exitPrice.toFixed(4)} | PNL: ${pnlPct.toFixed(2)}%`);

    return { tradeId, reason, exitPrice, pnlPct, durationMs };

  } catch (error) {
    console.error(`[CLOSE_TRADE] Error for ${tradeId}:`, error.message);
    return null;
  }
}

module.exports = {
  executeImpulseTrade,
  processImpulseSignals,
  runActivePositionSafetyControl,
  updateOpenTrades,
  closeTrade,
  checkRiskControls
};
