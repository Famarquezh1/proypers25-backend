'use strict';

const POLICY = require('../config/spot-growth-engine-v1.json');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floorCents(value) {
  return Math.floor(Math.max(0, n(value)) * 100) / 100;
}

function priceMap(prices = []) {
  return new Map((Array.isArray(prices) ? prices : [])
    .map((row) => [String(row?.symbol || '').toUpperCase(), n(row?.price)])
    .filter(([symbol, price]) => symbol && price > 0));
}

function assetValueUsdt(asset, quantity, prices) {
  const symbol = String(asset || '').toUpperCase();
  const qty = Math.max(0, n(quantity));
  if (!(qty > 0)) return 0;
  if (symbol === 'USDT') return qty;
  if (['USDC','FDUSD','TUSD','USDP','BUSD'].includes(symbol)) return qty;

  const direct = n(prices.get(`${symbol}USDT`));
  if (direct > 0) return qty * direct;

  const viaBtc = n(prices.get(`${symbol}BTC`));
  const btcUsdt = n(prices.get('BTCUSDT'));
  if (viaBtc > 0 && btcUsdt > 0) return qty * viaBtc * btcUsdt;
  return 0;
}

function estimateAccountEquityUsdt(account = {}, allPrices = []) {
  const prices = priceMap(allPrices);
  return floorCents((Array.isArray(account?.balances) ? account.balances : [])
    .reduce((sum, row) => {
      const qty = Math.max(0, n(row?.free)) + Math.max(0, n(row?.locked));
      return sum + assetValueUsdt(row?.asset, qty, prices);
    }, 0));
}

function estimateManagedExposureUsdt(openOrders = [], allPrices = []) {
  const prices = priceMap(allPrices);
  return floorCents((Array.isArray(openOrders) ? openOrders : [])
    .filter((order) => String(order?.side || '').toUpperCase() === 'SELL')
    .filter((order) => ['NEW','PARTIALLY_FILLED'].includes(String(order?.status || '').toUpperCase()))
    .filter((order) => String(order?.clientOrderId || '').startsWith('proypers-gh-protect-'))
    .reduce((sum, order) => {
      const symbol = String(order?.symbol || '').toUpperCase();
      const remaining = Math.max(0, n(order?.origQty) - n(order?.executedQty));
      const px = n(prices.get(symbol));
      return sum + (remaining * px);
    }, 0));
}

function tierCapUsdt(tier, equityUsdt, policy = POLICY.core) {
  const equity = Math.max(0, n(equityUsdt));
  const t = String(tier || '').toUpperCase();
  if (t === 'EXCEPTIONAL') {
    return floorCents(Math.min(
      n(policy.exceptional_cap_usdt, 70),
      Math.max(n(policy.exceptional_floor_usdt, 50), equity * n(policy.exceptional_equity_pct, 0.10))
    ));
  }
  if (t === 'HIGH') {
    return floorCents(Math.min(
      n(policy.high_cap_usdt, 35),
      Math.max(n(policy.high_floor_usdt, 30), equity * n(policy.high_equity_pct, 0.055))
    ));
  }
  return 0;
}

function resolveGrowthPosition({
  lane = 'CORE',
  tier = 'NORMAL',
  equityUsdt = 0,
  usdtFree = 0,
  managedExposureUsdt = 0,
  baseQuoteOrderQty = 0,
  isLeveraged = false,
  policy = POLICY.core
} = {}) {
  const normalizedLane = String(lane || 'CORE').toUpperCase();
  const equity = Math.max(0, n(equityUsdt));
  const free = Math.max(0, n(usdtFree));
  const exposure = Math.max(0, n(managedExposureUsdt));
  const base = floorCents(baseQuoteOrderQty);

  if (normalizedLane !== 'CORE' || isLeveraged === true || !['HIGH','EXCEPTIONAL'].includes(String(tier || '').toUpperCase())) {
    return {
      enabled: false,
      quote_order_qty: base,
      equity_usdt: floorCents(equity),
      managed_exposure_usdt: floorCents(exposure),
      reason: 'BASE_SIZING'
    };
  }

  const reserve = Math.max(
    n(policy.min_cash_reserve_usdt, 50),
    equity * n(policy.cash_reserve_pct, 0.20)
  );
  const maxDeployment = equity * n(policy.max_deployed_equity_pct, 0.65);
  const remainingDeployment = Math.max(0, maxDeployment - exposure);
  const freeAfterReserve = Math.max(0, free - reserve);
  const tierCap = tierCapUsdt(tier, equity, policy);
  const quote = floorCents(Math.min(tierCap, remainingDeployment, freeAfterReserve));

  return {
    enabled: true,
    version: POLICY.version,
    milestone_usdt: POLICY.milestone_usdt,
    tier: String(tier || '').toUpperCase(),
    equity_usdt: floorCents(equity),
    usdt_free: floorCents(free),
    reserve_usdt: floorCents(reserve),
    managed_exposure_usdt: floorCents(exposure),
    max_deployment_usdt: floorCents(maxDeployment),
    remaining_deployment_usdt: floorCents(remainingDeployment),
    tier_cap_usdt: tierCap,
    base_quote_order_qty: base,
    quote_order_qty: quote,
    reason: quote > 0 ? 'COMPOUNDING_CORE' : 'PORTFOLIO_CAP_OR_RESERVE'
  };
}

module.exports = {
  POLICY,
  floorCents,
  assetValueUsdt,
  estimateAccountEquityUsdt,
  estimateManagedExposureUsdt,
  tierCapUsdt,
  resolveGrowthPosition
};
