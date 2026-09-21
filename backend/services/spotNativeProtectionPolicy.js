'use strict';

const DEFAULT_ENTRY_BUFFER_PCT = 0.01;
const DEFAULT_STOP_BUFFER_PCT = 0.005;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimalPlaces(step) {
  const text = String(step);
  if (!text.includes('.')) return 0;
  return (text.replace(/0+$/, '').split('.')[1] || '').length;
}

function ceilToStep(value, stepSize) {
  const step = n(stepSize);
  if (!(step > 0)) return n(value);
  return Number((Math.ceil((n(value) - Number.EPSILON) / step) * step).toFixed(decimalPlaces(stepSize)));
}

function ceilCents(value) {
  return Math.ceil(Math.max(0, n(value)) * 100 - Number.EPSILON) / 100;
}

function minimumNotional(info = {}, orderType = 'STOP_LOSS') {
  const filters = Array.isArray(info?.filters) ? info.filters : [];
  const notional = filters.find((f) => f.filterType === 'NOTIONAL');
  if (notional) {
    if (orderType === 'MARKET' && notional.applyMinToMarket === false) return 0;
    return Math.max(0, n(notional.minNotional));
  }
  const minNotional = filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  if (minNotional) {
    if (orderType === 'MARKET' && minNotional.applyToMarket === false) return 0;
    return Math.max(0, n(minNotional.minNotional));
  }
  return 0;
}

function protectionOrderType(info = {}) {
  const types = Array.isArray(info?.orderTypes) ? info.orderTypes : [];
  if (types.includes('STOP_LOSS')) return 'STOP_LOSS';
  if (types.includes('STOP_LOSS_LIMIT')) return 'STOP_LOSS_LIMIT';
  return null;
}

function minimumProtectedQuoteUsdt(info = {}, stopLossPct = 0.05, options = {}) {
  const orderType = protectionOrderType(info);
  if (!orderType) return { ok: false, reason: 'NATIVE_STOP_UNSUPPORTED', order_type: null, quote_floor_usdt: 0, min_notional_usdt: 0 };

  const minNotional = minimumNotional(info, orderType);
  if (!(minNotional > 0)) {
    return { ok: true, reason: 'NO_MIN_NOTIONAL', order_type: orderType, quote_floor_usdt: 0, min_notional_usdt: 0 };
  }

  const stopPct = Math.max(0, Math.min(0.50, n(stopLossPct, 0.05)));
  const entryBufferPct = Math.max(0, n(options.entryBufferPct, DEFAULT_ENTRY_BUFFER_PCT));
  const stopLimitGapPct = orderType === 'STOP_LOSS_LIMIT'
    ? Math.max(0, Math.min(0.10, n(options.stopLimitGapPct, 0.006)))
    : 0;
  const stopFactor = (1 - stopPct) * (1 - stopLimitGapPct);
  if (!(stopFactor > 0)) return { ok: false, reason: 'INVALID_STOP_FACTOR', order_type: orderType, quote_floor_usdt: 0, min_notional_usdt: minNotional };

  const quoteFloor = ceilCents((minNotional * (1 + entryBufferPct)) / stopFactor);
  return {
    ok: true,
    reason: 'MIN_NOTIONAL_PROTECTION_FLOOR',
    order_type: orderType,
    quote_floor_usdt: quoteFloor,
    min_notional_usdt: minNotional,
    stop_loss_pct: stopPct,
    stop_limit_gap_pct: stopLimitGapPct,
    entry_buffer_pct: entryBufferPct
  };
}

function resolveNativeProtectionStop({
  info = {},
  quantity = 0,
  desiredStopPrice = 0,
  currentPrice = 0,
  stopLimitGapPct = 0.006,
  stopBufferPct = DEFAULT_STOP_BUFFER_PCT
} = {}) {
  const qty = Math.max(0, n(quantity));
  const desired = Math.max(0, n(desiredStopPrice));
  const current = Math.max(0, n(currentPrice));
  const orderType = protectionOrderType(info);
  if (!orderType) return { ok: false, action: 'UNPROTECTABLE', reason: 'NATIVE_STOP_UNSUPPORTED', order_type: null };
  if (!(qty > 0 && desired > 0 && current > 0)) {
    return { ok: false, action: 'UNPROTECTABLE', reason: 'INVALID_PROTECTION_INPUT', order_type: orderType };
  }

  const minNotional = minimumNotional(info, orderType);
  const priceFilter = (Array.isArray(info?.filters) ? info.filters : []).find((f) => f.filterType === 'PRICE_FILTER');
  const tickSize = n(priceFilter?.tickSize);
  const limitFactor = orderType === 'STOP_LOSS_LIMIT' ? (1 - Math.max(0, Math.min(0.10, n(stopLimitGapPct, 0.006)))) : 1;
  const desiredNotional = qty * desired * limitFactor;

  if (!(minNotional > 0) || desiredNotional + Number.EPSILON >= minNotional) {
    return {
      ok: true,
      action: 'PLACE',
      reason: 'DESIRED_STOP_MEETS_NOTIONAL',
      order_type: orderType,
      stop_price: desired,
      desired_stop_price: desired,
      min_notional_usdt: minNotional,
      effective_notional_usdt: desiredNotional,
      tightened_for_notional: false
    };
  }

  const buffer = 1 + Math.max(0, n(stopBufferPct, DEFAULT_STOP_BUFFER_PCT));
  const requiredStopRaw = (minNotional * buffer) / (qty * limitFactor);
  const requiredStop = tickSize > 0 ? ceilToStep(requiredStopRaw, tickSize) : requiredStopRaw;
  const maxPlaceableStop = tickSize > 0 ? current - tickSize : current * (1 - 1e-8);

  if (requiredStop > 0 && requiredStop < maxPlaceableStop) {
    return {
      ok: true,
      action: 'PLACE_TIGHTENED',
      reason: 'STOP_RAISED_TO_MEET_MIN_NOTIONAL',
      order_type: orderType,
      stop_price: requiredStop,
      desired_stop_price: desired,
      min_notional_usdt: minNotional,
      effective_notional_usdt: qty * requiredStop * limitFactor,
      tightened_for_notional: true
    };
  }

  return {
    ok: false,
    action: 'UNPROTECTABLE',
    reason: 'MIN_NOTIONAL_CANNOT_BE_MET_BELOW_MARKET',
    order_type: orderType,
    desired_stop_price: desired,
    required_stop_price: requiredStop,
    current_price: current,
    min_notional_usdt: minNotional,
    current_notional_usdt: qty * current
  };
}

module.exports = {
  DEFAULT_ENTRY_BUFFER_PCT,
  DEFAULT_STOP_BUFFER_PCT,
  minimumNotional,
  protectionOrderType,
  minimumProtectedQuoteUsdt,
  resolveNativeProtectionStop
};
