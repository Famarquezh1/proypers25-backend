const yahooFinance = require('yahoo-finance2').default;
const db = require('../firebase-admin-config');
const { fetchBinanceSpot } = require('../services/dataSources/binance');
const { fetchCandles } = require('../services/dataSources/fetchCandles');
const { applyLearningAdjustments } = require('../lib/learningConfig');
const { evaluateEventContextFilter } = require('../lib/event_context_filter');
const { adjustExecutionTargets } = require('../lib/context_execution_adjuster');
const { executeHighConvictionTrade } = require('../lib/binanceFuturesExecutor');
const {
  shouldSendManualPreAlert,
  sendManualPreAlertNotification,
  shouldEmitHighConvictionSignal,
  registerHighConvictionSignal,
  sendHighConvictionNotification
} = require('../lib/highConvictionSignals');

const timeframes = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240
};
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || null;
const ENABLE_BINANCE = process.env.ENABLE_BINANCE === 'true';

const randomBetween = (min, max) => Number((Math.random() * (max - min) + min).toFixed(4));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const LEARNING_MODE = process.env.LEARNING_MODE || 'observe';
const LEARNING_LOG = process.env.LEARNING_LOG === 'true';
const EVENT_CONTEXT_FILTER_ENABLED = process.env.EVENT_CONTEXT_FILTER_ENABLED === 'true';
const EVENT_CONTEXT_FILTER_MODE =
  (process.env.EVENT_CONTEXT_FILTER_MODE || 'observe').toLowerCase() === 'enforce'
    ? 'enforce'
    : 'observe';
const CONTEXT_EXECUTION_ADJUSTMENT_ENABLED =
  process.env.CONTEXT_EXECUTION_ADJUSTMENT_ENABLED === 'true';

function pricePrecision(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 2;
  }
  if (n >= 100) return 2;
  if (n >= 1) return 4;
  return 6;
}

function roundPrice(value, referenceValue = value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return n;
  }
  const decimals = pricePrecision(referenceValue);
  return Number(n.toFixed(decimals));
}

function normalizeSymbol(symbol) {
  if (!symbol) {
    return symbol;
  }
  const normalized = symbol.toUpperCase().replace('/', '-');
  if (
    normalized === 'BTC-USD' ||
    normalized === 'BTCUSD' ||
    normalized === 'BTC/USDT' ||
    normalized === 'BTCUSDT'
  ) {
    return 'BTC-USDT';
  }
  return normalized;
}

async function fetchAlphaVantageSpot(symbol) {
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('AlphaVantage key missing');
  }
  const cleanSymbol = symbol.replace('-', '').replace('/', '');
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
    cleanSymbol
  )}&apikey=${ALPHA_VANTAGE_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  const quote = data['Global Quote'];
  if (!quote) {
    throw new Error('AlphaVantage no devolviÃ³ cotizaciÃ³n');
  }
  const price = Number(quote['05. price']);
  if (!price) {
    throw new Error('AlphaVantage sin precio vÃ¡lido');
  }
  return price;
}

async function obtenerSpotPrice(symbol, timeframe = '5m') {
  if (!symbol) {
    throw new Error('SÃ­mbolo requerido para spot price');
  }

  if (ENABLE_BINANCE) {
    try {
      const price = await fetchBinanceSpot(symbol);
      console.log('[BINANCE] spot fetch ok', { symbol, price });
      return { price, source: 'binance' };
    } catch (error) {
      if (error?.status === 429) {
        console.warn('[BINANCE] spot fetch failed -> reason: rate_limited');
      } else {
        console.warn('[BINANCE] spot fetch failed -> reason:', error?.message || 'unknown');
      }
    }
  }

  const yahooSymbol = symbol === 'BTC-USDT' ? 'BTC-USD' : symbol;
  try {
    const quote = await yahooFinance.quote(yahooSymbol);
    if (quote?.regularMarketPrice) {
      return { price: Number(quote.regularMarketPrice), source: 'yahoo' };
    }
    throw new Error('Yahoo Finance sin precio');
  } catch (error) {
    if (ALPHA_VANTAGE_KEY) {
      console.warn('[prediccionVelas] fallback AlphaVantage spot price', error.message);
      const price = await fetchAlphaVantageSpot(symbol);
      return { price, source: 'alpha_vantage' };
    }
    console.warn('[YAHOO] spot fetch failed -> reason:', error?.message || 'unknown');
  }

  const candles = await fetchCandles(symbol, timeframe);
  const lastClose = candles.length ? Number(candles[candles.length - 1]?.close) : NaN;
  if (Number.isFinite(lastClose) && lastClose > 0) {
    console.warn('[prediccionVelas] fallback candle close spot price', { symbol, timeframe, lastClose });
    return { price: lastClose, source: 'candles_close' };
  }

  throw new Error(`No se pudo obtener spot price real para ${symbol}`);
}

function computeExitWindow(timeframe, entryTime) {
  if (timeframe !== '1m') {
    return {
      exit_time: new Date(entryTime.getTime() + 60000),
      exit_window_seconds: null,
      max_time_seconds: null,
      exit_rule: null
    };
  }

  const minExit = 20;
  const maxExit = 45;
  const exitTime = new Date(entryTime.getTime() + maxExit * 1000);

  return {
    exit_time: exitTime,
    exit_window_seconds: { min: minExit, max: maxExit, preferred: 35 },
    max_time_seconds: 60,
    exit_rule: 'impulse_exhausted_or_max_time'
  };
}

function computeImpulseMetrics() {
  const momentum = randomBetween(0.2, 1.2);
  const acceleration = randomBetween(0.1, 1.0);
  const volumeSpike = randomBetween(0, 1);
  const impulseStrength = clamp(momentum * 0.45 + acceleration * 0.35 + volumeSpike * 0.2, 0, 1);
  const impulsePresent = impulseStrength >= 0.6 && acceleration >= 0.4;

  return {
    momentum: Number(momentum.toFixed(3)),
    acceleration: Number(acceleration.toFixed(3)),
    volume_spike: Number(volumeSpike.toFixed(3)),
    strength: Number(impulseStrength.toFixed(3)),
    impulse_present: impulsePresent
  };
}

async function loadTrainingStats(symbolNormalized) {
  if (!symbolNormalized) {
    return null;
  }
  const docRef = db.collection('velas_training_stats').doc(symbolNormalized);
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    return null;
  }
  return snapshot.data() || null;
}

function applyTrainingFeedback(confidence, quantumScore, stats) {
  if (!stats || !stats.samples) {
    return { confidence, quantumScore, adjustment: 0, note: 'no_history' };
  }

  const samples = stats.samples || 0;
  if (samples < 5) {
    return { confidence, quantumScore, adjustment: 0, note: 'insufficient_history' };
  }

  const validWins = stats.valid_wins || 0;
  const luckyWins = stats.lucky_wins || 0;
  const losses = stats.losses || 0;
  const avgTiming = stats.avg_timing_score ?? 0.5;

  const validRate = validWins / samples;
  const luckyRate = luckyWins / samples;
  const lossRate = losses / samples;

  let adjustment = 0;
  adjustment += (validRate - 0.5) * 0.2;
  adjustment -= luckyRate * 0.15;
  adjustment -= lossRate * 0.25;
  adjustment += (avgTiming - 0.6) * 0.1;

  const adjustedConfidence = clamp(confidence + adjustment, 0.1, 0.99);
  const adjustedQuantum = clamp(quantumScore + adjustment * 0.8, 0.1, 0.99);

  return {
    confidence: adjustedConfidence,
    quantumScore: adjustedQuantum,
    adjustment: Number(adjustment.toFixed(3)),
    note: 'training_feedback'
  };
}

function applyConfidenceReweighting({
  confidence,
  quantumScore,
  timingScore,
  isEventDriven,
  neutralRate
}) {
  // Reweighting only changes scoring, not base thresholds.
  const notes = [];
  const baseConfidence = confidence;
  let adjusted = confidence;

  const alignedQuantumTiming = quantumScore >= 0.85 && timingScore >= 0.75;
  if (isEventDriven && baseConfidence >= 0.8) {
    adjusted = clamp(adjusted * 1.12, 0.05, 0.99);
    notes.push('event_boost');
  }
  if (alignedQuantumTiming) {
    adjusted = clamp(adjusted * 1.04, 0.05, 0.99);
    notes.push('aligned_boost');
  }

  if (neutralRate != null && neutralRate >= 0.8) {
    adjusted = clamp(adjusted * 0.85, 0.05, 0.99);
    notes.push('neutral_penalty');
  }

  let lowConfidencePenalty = false;
  if (adjusted < 0.6) {
    adjusted = clamp(adjusted * 0.85, 0.05, 0.99);
    lowConfidencePenalty = true;
    notes.push('low_confidence_penalty');
  }

  return {
    confidence_before: baseConfidence,
    confidence_after: adjusted,
    lowConfidencePenalty,
    notes
  };
}

function evaluateTimeframeGate(timeframe, confidence, quantumScore, direction, impulsePresent) {
  if (timeframe !== '1m') {
    return { pass: true, reason: 'non_1m' };
  }
  const reasons = [];
  if (confidence < 0.8) reasons.push('confidence');
  if (quantumScore < 0.85) reasons.push('quantum');
  if (direction === 'neutral') reasons.push('direction');
  if (!impulsePresent) reasons.push('impulse');
  return { pass: reasons.length === 0, reason: reasons.length ? `missing:${reasons.join(',')}` : 'quality_gate' };
}

function evaluateEventGate(confidence, quantumScore, timingScore, direction, impulsePresent) {
  const reasons = [];
  if (confidence < 0.85) reasons.push('confidence');
  if (quantumScore < 0.9) reasons.push('quantum');
  if (timingScore < 0.7) reasons.push('timing');
  if (direction === 'neutral') reasons.push('direction');
  if (!impulsePresent) reasons.push('impulse');
  return { pass: reasons.length === 0, reason: reasons.length ? `missing:${reasons.join(',')}` : 'quality_gate' };
}

function formatTimeUTC(date) {
  return date.toISOString().slice(11, 19);
}

function buildEventDrivenWindows(referenceTime, impulseConfig, impulseMetrics) {
  const entryOffsetMs = Math.round(randomBetween(4000, 15000));
  const entryDurationMs = Math.round(randomBetween(12000, 25000));
  const entryStart = new Date(referenceTime.getTime() + entryOffsetMs);
  const entryEnd = new Date(entryStart.getTime() + entryDurationMs);

  const impulseMin = Math.max(20, Math.round(impulseMetrics.strength * 40));
  const impulseMax = impulseMin + Math.round(randomBetween(10, 25));
  const exitDelayMs = Math.round(randomBetween(3000, 10000));
  const exitStart = new Date(entryEnd.getTime() + exitDelayMs);
  const exitEnd = new Date(exitStart.getTime() + impulseMax * 1000);

  return {
    entryWindow: {
      start: formatTimeUTC(entryStart),
      end: formatTimeUTC(entryEnd)
    },
    exitWindow: {
      start: formatTimeUTC(exitStart),
      end: formatTimeUTC(exitEnd)
    },
    impulseDurationSeconds: {
      min: impulseMin,
      max: impulseMax
    },
    exitTime: exitEnd,
    exitWindowSeconds: {
      min: impulseMin,
      max: impulseMax,
      preferred: impulseConfig?.preferred || impulseMax
    },
    entryStart,
    entryEnd,
    exitStart,
    exitEnd
  };
}

function buildTradePlan({ spotPrice, modelPriceEstimate, direction, timeframeMinutes }) {
  const entry = Number(spotPrice);
  const target = Number(modelPriceEstimate);

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(target) || (direction !== 'up' && direction !== 'down')) {
    return null;
  }

  const rewardDistance = Math.max(
    Math.abs(target - entry),
    entry * 0.0035
  );
  const riskDistance = rewardDistance * 0.6;

  const stopLoss = direction === 'up'
    ? entry - riskDistance
    : entry + riskDistance;
  const takeProfit = direction === 'up'
    ? entry + rewardDistance
    : entry - rewardDistance;
  const referencePrice = Math.min(Math.abs(entry), Math.abs(target)) || entry;

  return {
    entry_price: roundPrice(entry, referencePrice),
    stop_loss: roundPrice(stopLoss, referencePrice),
    take_profit: roundPrice(takeProfit, referencePrice),
    target_exit_price: roundPrice(target, referencePrice),
    risk_per_unit: roundPrice(riskDistance, referencePrice),
    reward_per_unit: roundPrice(rewardDistance, referencePrice),
    risk_reward_ratio: Number((rewardDistance / riskDistance).toFixed(2)),
    estimated_holding_minutes: Number(timeframeMinutes || 0),
    plan_version: 'conservative_v1'
  };
}


async function generarPrediccion({
  symbol,
  timeframe = '5m',
  monto = 1000,
  execution_mode = 'timeframe',
  origin
} = {}) {
  const frameMinutes = timeframes[timeframe] || 5;
  const now = new Date();
  const entryTime = new Date(now.getTime() + frameMinutes * 60000);
  const exitWindow = computeExitWindow(timeframe, entryTime);

  const symbolInput = symbol ? symbol.toUpperCase() : '';
  const symbolNormalized = normalizeSymbol(symbolInput);
  const executionMode = execution_mode === 'event_driven' ? 'event_driven' : 'timeframe';
  const isEventDriven = executionMode === 'event_driven';

  let spotPrice = null;
  let spotPriceSource = 'unresolved';
  try {
    const fetchedSpot = await obtenerSpotPrice(symbolNormalized || symbolInput, timeframe);
    if (Number.isFinite(fetchedSpot?.price)) {
      spotPrice = roundPrice(fetchedSpot.price);
      spotPriceSource = fetchedSpot.source || 'unknown';
    }
  } catch (error) {
    console.warn('[prediccionVelas] spot price fetch failed', {
      symbol: symbolInput,
      message: error?.message || 'sin detalle'
    });
  }

  if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
    throw new Error(`No se pudo generar prediccion sin spot price valido para ${symbolInput || symbolNormalized}`);
  }

  const precioActual = spotPrice;
  let contextFilter = {
    compression_detected: false,
    range_break_detected: false,
    volume_confirmation: false,
    volatility_expansion_detected: false,
    context_score: 0,
    allow_event: true,
    would_block_event: false,
    event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
    relative_volume: null,
    volume_acceleration: null,
    volatility_expansion_ratio: null,
    metrics: null,
    details: null
  };
  const impulseMetrics = computeImpulseMetrics();
  const impulseMinPercent = timeframe === '1m' ? 0.2 : 0.5;

  const minMove = timeframe === '1m' ? 0.15 : 0.4;
  const maxMove = timeframe === '1m' ? 1.2 : 3.5;
  const expectedMovePercent = Number(
    clamp(randomBetween(minMove, maxMove) * impulseMetrics.strength, 0, maxMove).toFixed(2)
  );

  let direction = 'neutral';
  if (impulseMetrics.impulse_present) {
    direction = Math.random() >= 0.5 ? 'up' : 'down';
  }
  const directionSign = direction === 'down' ? -1 : direction === 'up' ? 1 : 0;

  if (EVENT_CONTEXT_FILTER_ENABLED && (direction === 'up' || direction === 'down')) {
    try {
      const contextCandles = await fetchCandles(symbolNormalized || symbolInput, timeframe);
      contextFilter = evaluateEventContextFilter({
        candles: contextCandles,
        direction,
        currentPrice: spotPrice,
        mode: EVENT_CONTEXT_FILTER_MODE
      });
    } catch (err) {
      contextFilter = {
        compression_detected: false,
        range_break_detected: false,
        volume_confirmation: false,
        volatility_expansion_detected: false,
        context_score: 0,
        allow_event: EVENT_CONTEXT_FILTER_MODE === 'observe',
        would_block_event: true,
        event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
        relative_volume: null,
        volume_acceleration: null,
        volatility_expansion_ratio: null,
        metrics: null,
        details: { error: err?.message || 'context_filter_failed' }
      };
    }
  }

  const baseConfidence = clamp(0.45 + impulseMetrics.strength * 0.4 + randomBetween(-0.08, 0.08), 0.2, 0.99);
  const timingScore = clamp(0.5 + impulseMetrics.strength * 0.4 + randomBetween(-0.1, 0.1), 0, 1);
  const baseQuantum = clamp(0.4 + impulseMetrics.strength * 0.5 + randomBetween(-0.06, 0.06), 0.1, 0.99);

  let confidence = baseConfidence;
  let quantumScore = clamp(baseQuantum * (0.7 + timingScore * 0.3), 0.1, 0.99);

  const trainingStats = await loadTrainingStats(symbolNormalized);
  const trainingFeedback = applyTrainingFeedback(confidence, quantumScore, trainingStats);
  confidence = trainingFeedback.confidence;
  quantumScore = trainingFeedback.quantumScore;
  const neutralRate = trainingStats?.neutral_rate ?? trainingStats?.neutralRate ?? null;

  const preLearningScores = { confidence, quantumScore, timingScore };
  const preTimeframeGate = evaluateTimeframeGate(
    timeframe,
    confidence,
    quantumScore,
    direction,
    impulseMetrics.impulse_present
  );
  const preEventGate = evaluateEventGate(
    confidence,
    quantumScore,
    timingScore,
    direction,
    impulseMetrics.impulse_present
  );

  const learningResult = await applyLearningAdjustments(
    symbolNormalized || symbolInput,
    executionMode,
    timeframe,
    preLearningScores
  );
  const postLearningScores = {
    confidence: learningResult.confidence,
    quantumScore: learningResult.quantumScore,
    timingScore: learningResult.timingScore
  };
  const learningMeta = learningResult.learning;
  if (learningMeta && LEARNING_LOG) {
    console.log(
      `[learning:v${learningMeta.version}]`,
      `${learningMeta.scope.symbol}/${learningMeta.scope.mode}/${learningMeta.scope.timeframe}`,
      learningMeta.adjustments
    );
  }

  const postTimeframeGate = evaluateTimeframeGate(
    timeframe,
    postLearningScores.confidence,
    postLearningScores.quantumScore,
    direction,
    impulseMetrics.impulse_present
  );
  const postEventGate = evaluateEventGate(
    postLearningScores.confidence,
    postLearningScores.quantumScore,
    postLearningScores.timingScore,
    direction,
    impulseMetrics.impulse_present
  );

  let signalEmitted = isEventDriven
    ? preEventGate.pass
    : timeframe !== '1m'
    ? true
    : preTimeframeGate.pass;

  let signalEmittedPost = isEventDriven
    ? postEventGate.pass
    : timeframe !== '1m'
    ? true
    : postTimeframeGate.pass;

  const signedDeltaPct = directionSign === 0 ? 0 : Number((expectedMovePercent * directionSign).toFixed(2));
  const modelPriceEstimate = roundPrice(spotPrice * (1 + signedDeltaPct / 100), spotPrice);
  const gananciaEstim = Number((monto * (signedDeltaPct / 100)).toFixed(2));
  const porcentaje = signedDeltaPct;
  const computedTradePlan = buildTradePlan({
    spotPrice,
    modelPriceEstimate,
    direction,
    timeframeMinutes: frameMinutes
  });

  const eventDrivenInfo = isEventDriven
    ? buildEventDrivenWindows(now, { preferred: 35 }, impulseMetrics)
    : null;
  const entryTimeIso = isEventDriven
    ? eventDrivenInfo?.entryStart.toISOString()
    : entryTime.toISOString();
  const exitTimeIso = isEventDriven
    ? eventDrivenInfo?.exitEnd.toISOString()
    : exitWindow.exit_time.toISOString();
  const exitWindowSeconds = isEventDriven
    ? eventDrivenInfo?.exitWindowSeconds || { min: 0, max: 60, preferred: 60 }
    : exitWindow.exit_window_seconds;
  const maxTimeSeconds = isEventDriven ? 60 : exitWindow.max_time_seconds;
  const finalExitRule = isEventDriven
    ? 'Impulse exhausted or max 60s hard cap for event-driven mode'
    : exitWindow.exit_rule;

  const actualGateInfo =
    isEventDriven || timeframe !== '1m'
      ? isEventDriven
        ? preEventGate
        : { pass: true, reason: 'non_1m' }
      : preTimeframeGate;
  const postGateInfo =
    isEventDriven || timeframe !== '1m'
      ? isEventDriven
        ? postEventGate
        : { pass: true, reason: 'non_1m' }
      : postTimeframeGate;
  const reweighted = applyConfidenceReweighting({
    confidence: postLearningScores.confidence,
    quantumScore: postLearningScores.quantumScore,
    timingScore: postLearningScores.timingScore,
    isEventDriven,
    neutralRate
  });
  if (reweighted.lowConfidencePenalty) {
    signalEmitted = false;
    signalEmittedPost = false;
  }
  const signalBeforeContext = signalEmitted;
  let suppressionReason = signalEmitted ? null : reweighted.lowConfidencePenalty ? 'low_confidence' : 'quality_gate';

  if (
    EVENT_CONTEXT_FILTER_ENABLED &&
    EVENT_CONTEXT_FILTER_MODE === 'enforce' &&
    !contextFilter.allow_event
  ) {
    signalEmitted = false;
    signalEmittedPost = false;
    suppressionReason = 'event_context';
  }

  const contextWouldBlock =
    Boolean(EVENT_CONTEXT_FILTER_ENABLED) && !Boolean(contextFilter.allow_event);
  const shadowObserveSignalEmitted = Boolean(signalBeforeContext);
  const shadowEnforceSignalEmitted = Boolean(signalBeforeContext) && !contextWouldBlock;
  const shadowMode = EVENT_CONTEXT_FILTER_MODE === 'enforce' ? 'enforce' : 'observe';

  let executionAdjustment = {
    enabled: CONTEXT_EXECUTION_ADJUSTMENT_ENABLED,
    applied: false,
    reason: signalEmitted ? 'not_evaluated' : 'signal_not_emitted'
  };
  let finalTradePlan = computedTradePlan;

  if (signalEmitted && computedTradePlan) {
    if (CONTEXT_EXECUTION_ADJUSTMENT_ENABLED) {
      const adjustment = adjustExecutionTargets(
        {
          entry_price: computedTradePlan.entry_price,
          direction,
          base_tp: computedTradePlan.take_profit,
          base_sl: computedTradePlan.stop_loss
        },
        {
          context_score: contextFilter.context_score,
          volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
          relative_volume: contextFilter.relative_volume,
          volume_acceleration: contextFilter.volume_acceleration
        }
      );

      executionAdjustment = {
        enabled: true,
        ...adjustment
      };

      if (adjustment?.applied) {
        finalTradePlan = {
          ...computedTradePlan,
          stop_loss: adjustment.adjusted_sl,
          take_profit: adjustment.adjusted_tp,
          target_exit_price: adjustment.adjusted_tp,
          plan_version: `${computedTradePlan.plan_version}+context_exec_v1`
        };
      }
    } else {
      executionAdjustment = {
        enabled: false,
        applied: false,
        reason: 'disabled_by_env'
      };
    }
  }

  const decision_pre_learning = {
    signal_emitted: signalEmitted,
    quality_gate_passed: actualGateInfo.pass,
    gate_reason: actualGateInfo.reason,
    suppression_reason: suppressionReason,
    event_context_filter: {
      enabled: EVENT_CONTEXT_FILTER_ENABLED,
      mode: EVENT_CONTEXT_FILTER_MODE,
      allow_event: contextFilter.allow_event,
      context_score: contextFilter.context_score,
      would_block_event: contextFilter.would_block_event,
      shadow: {
        mode: shadowMode,
        would_block_event: contextWouldBlock,
        signal_emitted_observe: shadowObserveSignalEmitted,
        signal_emitted_enforce: shadowEnforceSignalEmitted
      }
    }
  };
  const decision_post_learning = {
    signal_emitted: signalEmittedPost,
    quality_gate_passed: postGateInfo.pass,
    gate_reason: postGateInfo.reason,
    suppression_reason: suppressionReason,
    event_context_filter: {
      enabled: EVENT_CONTEXT_FILTER_ENABLED,
      mode: EVENT_CONTEXT_FILTER_MODE,
      allow_event: contextFilter.allow_event,
      context_score: contextFilter.context_score,
      would_block_event: contextFilter.would_block_event,
      shadow: {
        mode: shadowMode,
        would_block_event: contextWouldBlock,
        signal_emitted_observe: shadowObserveSignalEmitted,
        signal_emitted_enforce: shadowEnforceSignalEmitted
      }
    }
  };
  if (LEARNING_MODE === 'observe') {
    console.log('decision_pre_learning', decision_pre_learning);
    console.log('decision_post_learning', decision_post_learning);
    console.log('confidence_reweighting', {
      before: reweighted.confidence_before,
      after: reweighted.confidence_after,
      notes: reweighted.notes
    });
    if (EVENT_CONTEXT_FILTER_ENABLED) {
      console.log('event_context_filter', {
        compression_detected: contextFilter.compression_detected,
        range_break_detected: contextFilter.range_break_detected,
        volume_confirmation: contextFilter.volume_confirmation,
        volatility_expansion_detected: contextFilter.volatility_expansion_detected,
        volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
        relative_volume: contextFilter.relative_volume,
        volume_acceleration: contextFilter.volume_acceleration,
        event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
        context_score: contextFilter.context_score,
        allow_event: contextFilter.allow_event,
        would_block_event: contextFilter.would_block_event,
        metrics: contextFilter.metrics,
        shadow: {
          mode: shadowMode,
          would_block_event: contextWouldBlock,
          signal_emitted_observe: shadowObserveSignalEmitted,
          signal_emitted_enforce: shadowEnforceSignalEmitted
        }
      });
    }
    if (CONTEXT_EXECUTION_ADJUSTMENT_ENABLED) {
      console.log('execution_adjustment', executionAdjustment);
    }
  }

  const recomendacion = {
    simbolo: symbolInput,
    simbolo_normalizado: symbolNormalized,
    origin: origin || 'manual',
    tipo: 'velas',
    timeframe,
    execution_mode: executionMode,
    mode: isEventDriven ? 'event-driven' : 'timeframe',
    timeframe_minutes: frameMinutes,
    monto,
    spot_price: spotPrice,
    spot_price_source: spotPriceSource,
    precio_actual: precioActual,
    precio_estimado: modelPriceEstimate,
    porcentaje,
    expected_move_percent: expectedMovePercent,
    expected_delta_pct: expectedMovePercent,
    signed_delta_pct: signedDeltaPct,
    model_price_estimate: modelPriceEstimate,
    trade_plan: signalEmitted ? finalTradePlan : null,
    execution_adjustment: executionAdjustment,
    ganancia_estim: signalEmitted ? gananciaEstim : 0,
    ahora: now.toISOString(),
    entry_time: entryTimeIso,
    exit_time: exitTimeIso,
    exit_window_seconds: exitWindowSeconds,
    max_time_seconds: maxTimeSeconds,
    exit_rule: finalExitRule,
    exit_rule_description: finalExitRule,
    direction,
    observaciones: signalEmitted
      ? direction === 'up'
        ? 'Se espera impulso alcista. Salir temprano si el impulso se agota.'
        : 'Se espera impulso bajista. Salir temprano si el impulso se agota.'
      : suppressionReason === 'event_context'
      ? 'Senal suprimida por filtro de contexto de evento.'
      : 'Senal suprimida por control de calidad.',
    confianza: Number(reweighted.confidence_after.toFixed(2)),
    confidence_before: Number(reweighted.confidence_before.toFixed(4)),
    confidence_after: Number(reweighted.confidence_after.toFixed(4)),
    confidence_reweighting: {
      notes: reweighted.notes,
      neutral_rate: neutralRate ?? null
    },
    quantum_score: Number(quantumScore.toFixed(2)),
    quantum_model: 'Quantum-LSTM',
    timing_score: Number(timingScore.toFixed(2)),
    impulse_metrics: impulseMetrics,
    compression_detected: contextFilter.compression_detected,
    range_break_detected: contextFilter.range_break_detected,
    volume_confirmation: contextFilter.volume_confirmation,
    volatility_expansion_detected: contextFilter.volatility_expansion_detected,
    volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
    relative_volume: contextFilter.relative_volume,
    volume_acceleration: contextFilter.volume_acceleration,
    context_score: contextFilter.context_score,
    event_context_filter: {
      enabled: EVENT_CONTEXT_FILTER_ENABLED,
      mode: EVENT_CONTEXT_FILTER_MODE,
      allow_event: contextFilter.allow_event,
      would_block_event: contextFilter.would_block_event,
      shadow: {
        mode: shadowMode,
        would_block_event: contextWouldBlock,
        signal_emitted_observe: shadowObserveSignalEmitted,
        signal_emitted_enforce: shadowEnforceSignalEmitted
      },
      metrics: contextFilter.metrics,
      details: contextFilter.details
    },
    impulse_min_percent: impulseMinPercent,
    signal_emitted: signalEmitted,
    suppression_reason: suppressionReason,
    entry_window: eventDrivenInfo?.entryWindow || null,
    exit_window: eventDrivenInfo?.exitWindow || null,
    expected_duration_seconds: eventDrivenInfo?.impulseDurationSeconds || null,
    entry_window_utc: eventDrivenInfo?.entryWindow || null,
    exit_window_utc: eventDrivenInfo?.exitWindow || null,
    expected_impulse_duration_seconds: eventDrivenInfo?.impulseDurationSeconds || null,
    estimation_mode: 'displacement',
    estimation_note: 'Precio estimado es desplazamiento, no un objetivo.',
    training_feedback: trainingFeedback,
    learning_applied: Boolean(learningMeta),
    learning_config_version: learningMeta?.version || null,
    learning_adjustments: learningMeta?.adjustments || null,
    pre_learning_scores: {
      confidence: preLearningScores.confidence,
      quantum_score: preLearningScores.quantumScore,
      timing_score: preLearningScores.timingScore
    },
    post_learning_scores: {
      confidence: postLearningScores.confidence,
      quantum_score: postLearningScores.quantumScore,
      timing_score: postLearningScores.timingScore
    },
    decision_pre_learning: decision_pre_learning,
    decision_post_learning: decision_post_learning
  };

  const status = signalEmitted ? 'pendiente' : 'suprimida';

  const docRef = await db.collection('velas_predicciones').add({
    ...recomendacion,
    status,
    verification: null,
    timestamp: now.toISOString(),
    created_at: now.toISOString()
  });

  try {
    const preAlertDecision = await shouldSendManualPreAlert(db, {
      ...recomendacion,
      id: docRef.id,
      trade_plan: finalTradePlan
    });
    if (preAlertDecision.ok) {
      await sendManualPreAlertNotification(db, {
        ...recomendacion,
        id: docRef.id,
        trade_plan: finalTradePlan
      });
    }
  } catch (err) {
    console.warn('[MANUAL_PREALERT] skipped', err?.message || err);
  }

  // High Conviction Mode: only for event-driven signals that pass strict thresholds.
  try {
    const decision = await shouldEmitHighConvictionSignal(db, {
      ...recomendacion,
      confianza: Number(reweighted.confidence_after.toFixed(4)),
      quantum_score: Number(quantumScore.toFixed(4)),
      timing_score: Number(timingScore.toFixed(4))
    });
    if (decision.ok) {
      const signalData = await registerHighConvictionSignal(db, {
        ...recomendacion,
        id: docRef.id,
        status,
        trade_plan: finalTradePlan
      });
      const notificationResult = await sendHighConvictionNotification(signalData);
      const executionResult = await executeHighConvictionTrade(db, signalData);
      if (signalData?.id) {
        await db.collection('high_conviction_signals').doc(signalData.id).update({
          telegram_notification: {
            sent: Boolean(notificationResult?.sent),
            channel: notificationResult?.channel || 'unknown',
            sent_at: new Date().toISOString()
          },
          binance_execution: {
            attempted: true,
            executed: Boolean(executionResult?.executed),
            dry_run: Boolean(executionResult?.dry_run),
            reason: executionResult?.reason || null,
            order_id: executionResult?.order_id || null,
            updated_at: new Date().toISOString()
          }
        });
      }
    }
  } catch (err) {
    console.warn('[HIGH_CONVICTION] skipped', err?.message || err);
  }

  return { id: docRef.id, ...recomendacion, status, verification: null };
}

module.exports = generarPrediccion;
