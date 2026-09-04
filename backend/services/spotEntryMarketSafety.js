'use strict';

const axios = require('axios');
const { floorToStep, extractMarketRules } = require('./spotDustResidual');

const VERSION = 'spot_entry_market_safety_v1';
const DEFAULT_BASE_FEE_RATE = 0.0015;
const DEFAULT_NORMAL_DROP_BUFFER_PCT = 0.10;
const DEFAULT_MIN_NOTIONAL_HEADROOM_MULTIPLIER = 1.20;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function evaluateSpotEntryMarketSafety({
  symbol,
  quoteOrderQty,
  currentPrice,
  symbolInfo,
  baseFeeRate = DEFAULT_BASE_FEE_RATE,
  normalDropBufferPct = DEFAULT_NORMAL_DROP_BUFFER_PCT,
  minNotionalHeadroomMultiplier = DEFAULT_MIN_NOTIONAL_HEADROOM_MULTIPLIER
} = {}) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const quote = Math.max(0, number(quoteOrderQty));
  const price = Math.max(0, number(currentPrice));
  if (!normalizedSymbol.endsWith('USDT')) return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_NOT_USDT', version: VERSION };
  if (!(quote > 0)) return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_INVALID_NOTIONAL', version: VERSION };
  if (!(price > 0)) return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_INVALID_PRICE', version: VERSION };
  if (!symbolInfo || String(symbolInfo.symbol || '').toUpperCase() !== normalizedSymbol) {
    return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_SYMBOL_INFO_MISSING', version: VERSION };
  }

  const rules = extractMarketRules(symbolInfo);
  if (rules.spot_trading_allowed !== true) return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_SYMBOL_NOT_TRADING', rules, version: VERSION };
  if (!(number(rules.step_size) > 0)) return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_STEP_SIZE_MISSING', rules, version: VERSION };
  if (!(number(rules.minimum_notional_usdt) > 0)) return { allowed: false, reason: 'ENTRY_MARKET_SAFETY_MIN_NOTIONAL_MISSING', rules, version: VERSION };

  const grossEstimatedQuantity = quote / price;
  const postFeeEstimatedQuantity = grossEstimatedQuantity * (1 - Math.max(0, number(baseFeeRate)));
  const sellableQuantityAfterFee = floorToStep(postFeeEstimatedQuantity, rules.step_size);
  const sellableNotionalNow = sellableQuantityAfterFee * price;
  const stressPrice = price * (1 - Math.min(0.5, Math.max(0, number(normalDropBufferPct))));
  const stressSellableNotional = sellableQuantityAfterFee * stressPrice;
  const requiredHeadroomNotional = rules.minimum_notional_usdt * Math.max(1, number(minNotionalHeadroomMultiplier, 1));

  let reason = null;
  if (sellableQuantityAfterFee < number(rules.minimum_quantity)) reason = 'ENTRY_POST_FEE_QUANTITY_BELOW_MINIMUM';
  else if (sellableNotionalNow < rules.minimum_notional_usdt) reason = 'ENTRY_POST_FEE_NOTIONAL_BELOW_MINIMUM';
  else if (stressSellableNotional < requiredHeadroomNotional) reason = 'ENTRY_MIN_NOTIONAL_HEADROOM_INSUFFICIENT';

  return {
    allowed: !reason,
    reason,
    symbol: normalizedSymbol,
    quote_order_qty_usdt: quote,
    current_price: price,
    estimated_gross_quantity: grossEstimatedQuantity,
    estimated_post_fee_quantity: postFeeEstimatedQuantity,
    estimated_sellable_quantity_after_fee: sellableQuantityAfterFee,
    estimated_sellable_notional_now_usdt: sellableNotionalNow,
    stress_drop_pct: normalDropBufferPct,
    stress_price: stressPrice,
    stress_sellable_notional_usdt: stressSellableNotional,
    required_headroom_notional_usdt: requiredHeadroomNotional,
    assumed_base_fee_rate: baseFeeRate,
    rules,
    version: VERSION
  };
}

async function validateSpotEntryMarketSafety(symbol, quoteOrderQty, dependencies = {}) {
  const requestPublic = dependencies.publicRequest || (async (path, params = {}) => {
    const response = await axios.get(`https://api.binance.com${path}`, { params, timeout: 10000 });
    return response.data;
  });
  try {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const [exchangeInfo, ticker] = await Promise.all([
      requestPublic('/api/v3/exchangeInfo', { symbol: normalizedSymbol }),
      requestPublic('/api/v3/ticker/price', { symbol: normalizedSymbol })
    ]);
    const symbolInfo = exchangeInfo?.symbols?.find((item) => String(item.symbol || '').toUpperCase() === normalizedSymbol) || exchangeInfo?.symbols?.[0];
    return evaluateSpotEntryMarketSafety({
      symbol: normalizedSymbol,
      quoteOrderQty,
      currentPrice: ticker?.price,
      symbolInfo,
      baseFeeRate: dependencies.baseFeeRate,
      normalDropBufferPct: dependencies.normalDropBufferPct,
      minNotionalHeadroomMultiplier: dependencies.minNotionalHeadroomMultiplier
    });
  } catch (error) {
    return {
      allowed: false,
      reason: 'ENTRY_MARKET_SAFETY_LOOKUP_FAILED',
      error: String(error?.message || error),
      version: VERSION
    };
  }
}

module.exports = {
  VERSION,
  DEFAULT_BASE_FEE_RATE,
  DEFAULT_NORMAL_DROP_BUFFER_PCT,
  DEFAULT_MIN_NOTIONAL_HEADROOM_MULTIPLIER,
  evaluateSpotEntryMarketSafety,
  validateSpotEntryMarketSafety
};
