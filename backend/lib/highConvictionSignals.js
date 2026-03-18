const { FieldValue } = require('firebase-admin/firestore');

const HIGH_CONVICTION_MAX_DAILY_SIGNALS = Math.max(
  1,
  Number(process.env.HIGH_CONVICTION_MAX_DAILY_SIGNALS || 20)
);
const HIGH_CONVICTION_SYMBOL_COOLDOWN_HOURS = Math.max(
  0,
  Number(process.env.HIGH_CONVICTION_SYMBOL_COOLDOWN_HOURS || 4)
);

const DEFAULTS = {
  minConfidence: 0.85,
  minQuantum: 0.8,
  minTiming: 0.75,
  maxDailySignals: HIGH_CONVICTION_MAX_DAILY_SIGNALS,
  symbolCooldownHours: HIGH_CONVICTION_SYMBOL_COOLDOWN_HOURS
};
const STABILITY_VERSION = Number(process.env.STABILITY_VERSION || 1);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_ALERTS_ENABLED = process.env.TELEGRAM_ALERTS_ENABLED === 'true';
const ALERT_TIMEZONE = process.env.ALERT_TIMEZONE || 'America/Punta_Arenas';
const TELEGRAM_MIN_LEAD_SECONDS = Number(process.env.TELEGRAM_MIN_LEAD_SECONDS || 180);
const MANUAL_PREALERTS_ENABLED = process.env.MANUAL_PREALERTS_ENABLED !== 'false';
const MANUAL_PREALERT_MIN_CONFIDENCE = Number(process.env.MANUAL_PREALERT_MIN_CONFIDENCE || 0.82);
const MANUAL_PREALERT_MIN_QUANTUM = Number(process.env.MANUAL_PREALERT_MIN_QUANTUM || 0.78);
const MANUAL_PREALERT_MIN_TIMING = Number(process.env.MANUAL_PREALERT_MIN_TIMING || 0.75);
const MANUAL_PREALERT_MIN_STABILITY = Number(process.env.MANUAL_PREALERT_MIN_STABILITY || 0.8);
const MANUAL_PREALERT_MIN_TIMEFRAME_MINUTES = Number(process.env.MANUAL_PREALERT_MIN_TIMEFRAME_MINUTES || 5);
const MANUAL_PREALERT_SYMBOL_COOLDOWN_MINUTES = Number(process.env.MANUAL_PREALERT_SYMBOL_COOLDOWN_MINUTES || 120);
const TELEGRAM_SEND_TIMEOUT_MS = Math.max(1000, Number(process.env.TELEGRAM_SEND_TIMEOUT_MS || 4000));

function startOfDayInTimezone(date = new Date(), timezone = ALERT_TIMEZONE) {
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const tzMidnight = new Date(tzDate);
  tzMidnight.setHours(0, 0, 0, 0);
  const offsetMs = date.getTime() - tzDate.getTime();
  return new Date(tzMidnight.getTime() + offsetMs);
}

function isEventDriven(prediction) {
  const mode = (prediction.execution_mode || prediction.mode || '').toString().toLowerCase();
  return mode === 'event_driven' || mode === 'event-driven';
}

function normalizePercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function computeSignalStabilityMetrics(confidenceRaw, quantumRaw, timingRaw) {
  const confidence = normalizePercent(confidenceRaw);
  const quantum = normalizePercent(quantumRaw);
  const timing = normalizePercent(timingRaw);
  const avg = (confidence + quantum + timing) / 3;
  const dispersion =
    (Math.abs(confidence - avg) + Math.abs(quantum - avg) + Math.abs(timing - avg)) / 3;
  const stability = avg * (1 - Math.min(dispersion, 0.5));
  return {
    stability: Math.max(0, Math.min(1, stability)),
    components: {
      confidence,
      quantum_score: quantum,
      timing_score: timing,
      dispersion
    }
  };
}

function formatPercentLabel(value) {
  return `${Math.round(normalizePercent(value) * 100)}%`;
}

function formatPriceLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 'n/a';
  }
  let decimals = 2;
  if (n < 1) decimals = 6;
  else if (n < 100) decimals = 4;
  return `$${n.toFixed(decimals)}`;
}

function formatCountdownLabel(ms) {
  const totalSeconds = Math.max(Math.round(ms / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseUtcClockWithReference(utcClock, referenceIso) {
  if (!utcClock) return null;
  const parts = String(utcClock).split(':').map(Number);
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  const [hours, minutes, seconds] = parts;
  const base = referenceIso ? new Date(referenceIso) : new Date();
  if (Number.isNaN(base.getTime())) {
    return null;
  }

  return new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hours, minutes, seconds)
  );
}

function formatLocalClockFromUtc(utcClock, referenceIso, timezone) {
  const date = parseUtcClockWithReference(utcClock, referenceIso);
  if (!date) {
    return null;
  }

  return new Intl.DateTimeFormat('es-CL', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function formatWindow(window) {
  if (!window?.start || !window?.end) {
    return 'sin ventana';
  }
  return `${window.start} - ${window.end} UTC`;
}

function formatLocalWindow(window, referenceIso, timezone) {
  if (!window?.start || !window?.end) {
    return null;
  }

  const localStart = formatLocalClockFromUtc(window.start, referenceIso, timezone);
  const localEnd = formatLocalClockFromUtc(window.end, referenceIso, timezone);
  if (!localStart || !localEnd) {
    return null;
  }

  return `${localStart} - ${localEnd}`;
}

function buildTelegramMessage(signalData) {
  const direction = signalData?.direction === 'down'
    ? 'Baja'
    : signalData?.direction === 'up'
      ? 'Alza'
      : 'Neutral';
  const localWindow = formatLocalWindow(
    signalData.estimated_window,
    signalData.timestamp,
    ALERT_TIMEZONE
  );

  const startDate = parseUtcClockWithReference(
    signalData?.estimated_window?.start,
    signalData?.timestamp
  );
  const msToStart = startDate ? startDate.getTime() - Date.now() : null;

  const lines = [
    'ALERTA HIGH CONVICTION',
    `${signalData.symbol || 'N/A'} · ${direction}`,
    `Precio actual: ${formatPriceLabel(signalData.spot_price)}`,
    `Confianza: ${formatPercentLabel(signalData.confidence)}`,
    `Quantum: ${formatPercentLabel(signalData.quantum_score)}`,
    `Timing: ${formatPercentLabel(signalData.timing_score)}`,
    `Stability: ${formatPercentLabel(signalData.stability)}`,
    localWindow
      ? `Ventana local (${ALERT_TIMEZONE}): ${localWindow}`
      : `Ventana: ${formatWindow(signalData.estimated_window)}`,
    `UTC: ${formatWindow(signalData.estimated_window)}`,
    `Modo: ${signalData.mode || 'unknown'}`
  ];
  const tradePlan = signalData?.trade_plan;

  if (msToStart != null) {
    lines.splice(7, 0, `Comienza en: ${formatCountdownLabel(msToStart)}`);
  }

  if (tradePlan) {
    lines.push(
      `Entrada: ${formatPriceLabel(tradePlan.entry_price)}`,
      `Stop Loss: ${formatPriceLabel(tradePlan.stop_loss)}`,
      `Take Profit: ${formatPriceLabel(tradePlan.take_profit)}`,
      `Salida objetivo: ${formatPriceLabel(tradePlan.target_exit_price)}`,
      `R:R ${tradePlan.risk_reward_ratio}:1`
    );
  }

  return lines.join('\n');
}

function formatDateTimeInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function buildManualPreAlertMessage(alertData) {
  const direction = alertData?.direction === 'down' ? 'Baja' : 'Alza';
  const generatedAt = alertData?.generated_at ? new Date(alertData.generated_at) : new Date();
  const horizonMinutes = Number(alertData?.timeframe_minutes || 0);
  const horizonEnd = new Date(generatedAt.getTime() + horizonMinutes * 60000);
  const tradePlan = alertData?.trade_plan;

  const lines = [
    'PRE-ALERTA OPERABLE',
    `${alertData.symbol || 'N/A'} · ${direction}`,
    `Precio actual: ${formatPriceLabel(alertData.spot_price)}`,
    `Confianza: ${formatPercentLabel(alertData.confidence)}`,
    `Quantum: ${formatPercentLabel(alertData.quantum_score)}`,
    `Timing: ${formatPercentLabel(alertData.timing_score)}`,
    `Stability: ${formatPercentLabel(alertData.stability)}`,
    `Horizonte estimado: ${horizonMinutes} min`,
    `Vigilar entre ${formatDateTimeInTimezone(generatedAt, ALERT_TIMEZONE)} y ${formatDateTimeInTimezone(horizonEnd, ALERT_TIMEZONE)} (${ALERT_TIMEZONE})`,
    `Modo: ${alertData.mode || 'event_driven'}`
  ];

  if (tradePlan) {
    lines.push(
      `Entrada: ${formatPriceLabel(tradePlan.entry_price)}`,
      `Stop Loss: ${formatPriceLabel(tradePlan.stop_loss)}`,
      `Take Profit: ${formatPriceLabel(tradePlan.take_profit)}`,
      `Salida objetivo: ${formatPriceLabel(tradePlan.target_exit_price)}`,
      `R:R ${tradePlan.risk_reward_ratio}:1`
    );
  }

  return lines.join('\n');
}

async function sendTelegramMessage(text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_SEND_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text
      })
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed (${response.status}): ${body}`);
  }
}

function launchDetached(task, label) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.warn(label, err?.message || err);
      });
  });
}

async function shouldSendManualPreAlert(db, prediction) {
  if (!MANUAL_PREALERTS_ENABLED) {
    return { ok: false, reason: 'disabled' };
  }

  if (!isEventDriven(prediction)) {
    return { ok: false, reason: 'not_event_driven' };
  }

  const symbol = (prediction.simbolo || prediction.symbol || '').toUpperCase();
  const direction = (prediction.direction || '').toLowerCase();
  const confidence = normalizePercent(prediction.confianza ?? prediction.confidence);
  const quantum = normalizePercent(prediction.quantum_score ?? prediction.quantumScore);
  const timing = normalizePercent(prediction.timing_score ?? prediction.timingScore);
  const stability = prediction.stability != null
    ? normalizePercent(prediction.stability)
    : computeSignalStabilityMetrics(confidence, quantum, timing).stability;
  const timeframeMinutes = Number(prediction.timeframe_minutes || 0);

  if (!symbol) return { ok: false, reason: 'symbol_missing' };
  if (direction !== 'up' && direction !== 'down') return { ok: false, reason: 'neutral_direction' };
  if (timeframeMinutes < MANUAL_PREALERT_MIN_TIMEFRAME_MINUTES) return { ok: false, reason: 'timeframe_too_short' };
  if (confidence < MANUAL_PREALERT_MIN_CONFIDENCE) return { ok: false, reason: 'confidence_low' };
  if (quantum < MANUAL_PREALERT_MIN_QUANTUM) return { ok: false, reason: 'quantum_low' };
  if (timing < MANUAL_PREALERT_MIN_TIMING) return { ok: false, reason: 'timing_low' };
  if (stability < MANUAL_PREALERT_MIN_STABILITY) return { ok: false, reason: 'stability_low' };

  const since = new Date(Date.now() - MANUAL_PREALERT_SYMBOL_COOLDOWN_MINUTES * 60 * 1000);
  const snapshot = await db
    .collection('telegram_notifications')
    .where('type', '==', 'manual_prealert')
    .where('symbol', '==', symbol)
    .where('created_at', '>=', since)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    return { ok: false, reason: 'symbol_cooldown' };
  }

  return { ok: true };
}

async function sendManualPreAlertNotification(db, prediction) {
  const alertData = {
    symbol: (prediction.simbolo || prediction.symbol || '').toUpperCase(),
    prediction_id: prediction.id || prediction.prediction_id || null,
    direction: prediction.direction,
    spot_price: Number(prediction.spot_price ?? prediction.precio_actual ?? 0),
    confidence: normalizePercent(prediction.confianza ?? prediction.confidence),
    quantum_score: normalizePercent(prediction.quantum_score ?? prediction.quantumScore),
    timing_score: normalizePercent(prediction.timing_score ?? prediction.timingScore),
    stability: prediction.stability != null
      ? normalizePercent(prediction.stability)
      : computeSignalStabilityMetrics(
          prediction.confianza ?? prediction.confidence,
          prediction.quantum_score ?? prediction.quantumScore,
          prediction.timing_score ?? prediction.timingScore
        ).stability,
    timeframe_minutes: Number(prediction.timeframe_minutes || 0),
    mode: prediction.execution_mode || prediction.mode || 'event_driven',
    generated_at: prediction.ahora || new Date().toISOString(),
    trade_plan: prediction.trade_plan || null
  };

  if (!TELEGRAM_ALERTS_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[MANUAL_PREALERT] signal', alertData);
    return { sent: false, channel: 'console' };
  }

  const logPayload = {
    ...alertData,
    type: 'manual_prealert',
    channel: 'telegram',
    sent: false,
    queued: true,
    created_at: FieldValue.serverTimestamp()
  };
  const logRef = await db.collection('telegram_notifications').add(logPayload);

  launchDetached(async () => {
    await sendTelegramMessage(buildManualPreAlertMessage(alertData));
    await logRef.set(
      {
        sent: true,
        queued: false,
        sent_at: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    console.log('[MANUAL_PREALERT] telegram_sent', alertData);
  }, '[MANUAL_PREALERT] telegram_async_failed');

  return { sent: false, channel: 'telegram', queued: true, type: 'manual_prealert' };
}

async function shouldEmitHighConvictionSignal(db, prediction, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const confidence = Number(prediction.confianza ?? prediction.confidence ?? 0);
  const quantumScore = Number(prediction.quantum_score ?? prediction.quantumScore ?? 0);
  const timingScore = Number(prediction.timing_score ?? prediction.timingScore ?? 0);
  const symbol = (prediction.simbolo || prediction.symbol || '').toUpperCase();

  if (!isEventDriven(prediction)) {
    return { ok: false, reason: 'not_event_driven' };
  }
  if (confidence < config.minConfidence) {
    return { ok: false, reason: 'confidence_low' };
  }
  if (quantumScore < config.minQuantum) {
    return { ok: false, reason: 'quantum_low' };
  }
  if (timingScore < config.minTiming) {
    return { ok: false, reason: 'timing_low' };
  }

  const todayStart = startOfDayInTimezone(new Date(), ALERT_TIMEZONE);
  const dailyPromise = db
    .collection('high_conviction_signals')
    .where('created_at', '>=', todayStart)
    .limit(config.maxDailySignals)
    .get();

  const symbolPromise = symbol
    ? db
        .collection('high_conviction_signals')
        .where('symbol', '==', symbol)
        .where('created_at', '>=', new Date(Date.now() - config.symbolCooldownHours * 60 * 60 * 1000))
        .limit(1)
        .get()
    : Promise.resolve(null);

  const [dailySnapshot, recent] = await Promise.all([dailyPromise, symbolPromise]);
  if (dailySnapshot.size >= config.maxDailySignals) {
    return { ok: false, reason: 'daily_limit' };
  }

  if (recent && !recent.empty) {
    return { ok: false, reason: 'symbol_cooldown' };
  }

  return { ok: true };
}

async function registerHighConvictionSignal(db, prediction) {
  const symbol = (prediction.simbolo || prediction.symbol || '').toUpperCase();
  const confidence = Number(prediction.confianza ?? prediction.confidence ?? 0);
  const quantumScore = Number(prediction.quantum_score ?? prediction.quantumScore ?? 0);
  const timingScore = Number(prediction.timing_score ?? prediction.timingScore ?? 0);
  const predictionId = prediction.id || prediction.prediction_id || null;

  const directRef = predictionId ? db.collection('high_conviction_signals').doc(predictionId) : null;
  if (directRef) {
    const docSnap = await directRef.get();
    if (docSnap.exists) {
      const existing = docSnap.data() || {};
      if (existing.stability != null) {
        return { id: docSnap.id, ...existing };
      }

      const metrics = computeSignalStabilityMetrics(
        existing.confidence ?? confidence,
        existing.quantum_score ?? quantumScore,
        existing.timing_score ?? timingScore
      );

      await directRef.set(
        {
          stability: metrics.stability,
          stability_version: STABILITY_VERSION,
          stability_calculated_at: FieldValue.serverTimestamp(),
          stability_components: metrics.components
        },
        { merge: true }
      );

      const refreshed = await directRef.get();
      return { id: refreshed.id, ...(refreshed.data() || {}) };
    }
  }

  const existingSignal = predictionId
    ? await db
        .collection('high_conviction_signals')
        .where('prediction_id', '==', predictionId)
        .limit(1)
        .get()
    : null;

  if (existingSignal && !existingSignal.empty) {
    const docSnap = existingSignal.docs[0];
    const existing = docSnap.data() || {};
    if (existing.stability != null) {
      return { id: docSnap.id, ...existing };
    }

    const metrics = computeSignalStabilityMetrics(
      existing.confidence ?? confidence,
      existing.quantum_score ?? quantumScore,
      existing.timing_score ?? timingScore
    );

    await docSnap.ref.update({
      stability: metrics.stability,
      stability_version: STABILITY_VERSION,
      stability_calculated_at: FieldValue.serverTimestamp(),
      stability_components: metrics.components
    });

    const refreshed = await docSnap.ref.get();
    return { id: refreshed.id, ...(refreshed.data() || {}) };
  }

  const metrics = computeSignalStabilityMetrics(confidence, quantumScore, timingScore);

  const payload = {
    symbol,
    prediction_id: predictionId,
    confidence,
    quantum_score: quantumScore,
    timing_score: timingScore,
    direction: prediction.direction || 'neutral',
    spot_price: Number(prediction.spot_price ?? prediction.precio_actual ?? 0),
    stability: metrics.stability,
    stability_version: STABILITY_VERSION,
    stability_calculated_at: FieldValue.serverTimestamp(),
    stability_components: metrics.components,
    mode: prediction.execution_mode || prediction.mode || 'unknown',
    estimated_window: prediction.entry_window || prediction.entry_window_utc || null,
    status: prediction.status || 'pendiente',
    verification_outcome: null,
    timestamp: new Date().toISOString(),
    created_at: FieldValue.serverTimestamp()
  };

  const ref = directRef || db.collection('high_conviction_signals').doc();
  await ref.set(payload, { merge: true });
  return { id: ref.id, ...payload };
}

async function sendHighConvictionNotification(signalData) {
  const payload = {
    symbol: signalData.symbol,
    direction: signalData.direction,
    spot_price: signalData.spot_price,
    confidence: signalData.confidence,
    quantum_score: signalData.quantum_score,
    timing_score: signalData.timing_score,
    stability: signalData.stability,
    mode: signalData.mode,
    estimated_window: signalData.estimated_window
  };

  if (!TELEGRAM_ALERTS_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[HIGH_CONVICTION] signal', payload);
    return { sent: false, channel: 'console' };
  }

  const direction = String(signalData?.direction || '').toLowerCase();
  if (direction !== 'up' && direction !== 'down') {
    console.log('[HIGH_CONVICTION] telegram_skipped_neutral', payload);
    return { sent: false, channel: 'telegram', reason: 'neutral_direction' };
  }

  const startDate = parseUtcClockWithReference(
    signalData?.estimated_window?.start,
    signalData?.timestamp
  );
  if (startDate) {
    const leadSeconds = Math.floor((startDate.getTime() - Date.now()) / 1000);
    if (leadSeconds < TELEGRAM_MIN_LEAD_SECONDS) {
      console.log('[HIGH_CONVICTION] telegram_skipped_lead_time', {
        ...payload,
        lead_seconds: leadSeconds,
        required_seconds: TELEGRAM_MIN_LEAD_SECONDS
      });
      return { sent: false, channel: 'telegram', reason: 'insufficient_lead_time' };
    }
  }

  launchDetached(async () => {
    await sendTelegramMessage(buildTelegramMessage(signalData));
    console.log('[HIGH_CONVICTION] telegram_sent', payload);
  }, '[HIGH_CONVICTION] telegram_async_failed');

  return { sent: false, channel: 'telegram', queued: true };
}

module.exports = {
  shouldSendManualPreAlert,
  sendManualPreAlertNotification,
  shouldEmitHighConvictionSignal,
  registerHighConvictionSignal,
  sendHighConvictionNotification
};
