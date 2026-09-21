'use strict';

const POLICY = require('../config/spot-growth-engine-v2.json');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function floorCents(value) {
  return Math.floor(Math.max(0, n(value)) * 100) / 100;
}

function growthRatchet({ equityUsdt = 0, previousHwmUsdt = 0, activated = false, policy = POLICY.equity_ratchet } = {}) {
  const equity = Math.max(0, n(equityUsdt));
  const activation = Math.max(0, n(policy.activation_hwm_usdt, 600));
  const previousHwm = Math.max(0, n(previousHwmUsdt));
  const hwm = Math.max(previousHwm, equity);
  const isActivated = activated === true || hwm >= activation;
  const drawdown = isActivated && hwm > 0 ? Math.max(0, 1 - (equity / hwm)) : 0;

  let multiplier = 1;
  if (isActivated) {
    const tiers = [...(Array.isArray(policy.tiers) ? policy.tiers : [])]
      .sort((a, b) => n(b.drawdown_pct) - n(a.drawdown_pct));
    const match = tiers.find((tier) => drawdown + 1e-12 >= n(tier.drawdown_pct));
    multiplier = match ? Math.max(0, Math.min(1, n(match.size_multiplier, 1))) : 1;
  }

  return {
    activated: isActivated,
    equity_usdt: floorCents(equity),
    previous_hwm_usdt: floorCents(previousHwm),
    hwm_usdt: floorCents(hwm),
    drawdown_pct: drawdown,
    size_multiplier: multiplier
  };
}

function pyramidDecision({
  lane = 'CORE',
  symbol = '',
  isLeveraged = false,
  hasAddOn = false,
  hasFilledExit = false,
  hasNativeProtection = false,
  historyCoversOwned = true,
  ageHours = 0,
  currentGainPct = 0,
  mfePct = 0,
  pullbackFromHighPct = 0,
  currentPrice = 0,
  nativeStopPrice = 0,
  initialCostUsdt = 0,
  currentPositionValueUsdt = 0,
  equityUsdt = 0,
  usdtFree = 0,
  cashReserveUsdt = 0,
  ratchetMultiplier = 1,
  policy = POLICY.pyramiding
} = {}) {
  const normalizedLane = String(lane || 'CORE').toUpperCase();
  const normalizedSymbol = String(symbol || '').toUpperCase();

  if (policy.enabled !== true) return { allow: false, reason: 'PYRAMIDING_DISABLED' };
  if (normalizedLane !== 'CORE') return { allow: false, reason: 'CORE_ONLY' };
  if (normalizedSymbol === 'XECUSDT') return { allow: false, reason: 'XEC_EXCLUDED' };
  if (isLeveraged === true) return { allow: false, reason: 'LEVERAGED_EXCLUDED' };
  if (hasAddOn) return { allow: false, reason: 'MAX_ADDS_REACHED' };
  if (hasFilledExit) return { allow: false, reason: 'RESIDUAL_OR_EXITED_POSITION' };
  if (!hasNativeProtection) return { allow: false, reason: 'NATIVE_PROTECTION_REQUIRED' };
  if (!historyCoversOwned) return { allow: false, reason: 'OWNERSHIP_NOT_PROVEN' };

  const age = Math.max(0, n(ageHours));
  const gain = n(currentGainPct);
  const mfe = n(mfePct);
  const pullback = Math.max(0, n(pullbackFromHighPct));
  if (age > n(policy.max_age_hours, 12)) return { allow: false, reason: 'POSITION_TOO_OLD' };
  if (mfe < n(policy.trigger_mfe_pct, 0.08)) return { allow: false, reason: 'MFE_NOT_CONFIRMED' };
  if (gain < n(policy.min_current_gain_pct, 0.05)) return { allow: false, reason: 'CURRENT_GAIN_NOT_CONFIRMED' };
  if (pullback > n(policy.max_pullback_from_high_pct, 0.025)) return { allow: false, reason: 'PULLBACK_TOO_LARGE' };

  const current = Math.max(0, n(currentPrice));
  const stop = Math.max(0, n(nativeStopPrice));
  const minGap = Math.max(0, n(policy.min_gap_above_native_stop_pct, 0.01));
  if (!(current > 0 && stop > 0) || current <= stop * (1 + minGap)) {
    return { allow: false, reason: 'INSUFFICIENT_STOP_HEADROOM' };
  }

  const equity = Math.max(0, n(equityUsdt));
  const currentValue = Math.max(0, n(currentPositionValueUsdt));
  const initialCost = Math.max(0, n(initialCostUsdt));
  const free = Math.max(0, n(usdtFree));
  const reserve = Math.max(0, n(cashReserveUsdt));
  const ratchet = Math.max(0, Math.min(1, n(ratchetMultiplier, 1)));
  if (!(equity > 0 && initialCost > 0)) return { allow: false, reason: 'INVALID_CAPITAL_BASE' };
  if (!(ratchet > 0)) return { allow: false, reason: 'EQUITY_RATCHET_BLOCK' };

  const byInitial = initialCost * n(policy.add_fraction_of_initial_cost, 0.30);
  const byEquity = equity * n(policy.add_equity_pct, 0.025);
  const cap = n(policy.add_cap_usdt, 20);
  const symbolRoom = Math.max(0, equity * n(policy.max_symbol_equity_pct, 0.125) - currentValue);
  const reserveSafeFree = Math.max(0, free - reserve);
  const quote = floorCents(Math.min(byInitial, byEquity, cap, symbolRoom, reserveSafeFree) * ratchet);
  const minimum = n(policy.add_min_usdt, 5);

  if (quote < minimum) {
    return {
      allow: false,
      reason: 'PYRAMID_SIZE_BELOW_MINIMUM',
      quote_order_qty: quote,
      symbol_room_usdt: floorCents(symbolRoom),
      reserve_safe_free_usdt: floorCents(reserveSafeFree)
    };
  }

  return {
    allow: true,
    reason: 'WINNER_CONFIRMED',
    quote_order_qty: quote,
    symbol_room_usdt: floorCents(symbolRoom),
    reserve_safe_free_usdt: floorCents(reserveSafeFree),
    ratchet_multiplier: ratchet
  };
}

function parseGrowthState(body = '') {
  const match = String(body || '').match(/<!--\s*PROYPERS_GROWTH_V2_STATE\s+({[\s\S]*?})\s*-->/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      hwm_usdt: Math.max(0, n(parsed.hwm_usdt)),
      activated: parsed.activated === true,
      updated_at: parsed.updated_at || null
    };
  } catch {
    return null;
  }
}

function growthStateBody(state = {}, ratchet = {}) {
  const payload = {
    version: POLICY.version,
    hwm_usdt: floorCents(state.hwm_usdt ?? ratchet.hwm_usdt),
    activated: state.activated ?? ratchet.activated ?? false,
    updated_at: state.updated_at || new Date().toISOString()
  };
  return [
    'Estado operativo interno de Growth Engine V2. No representa una señal de compra o venta.',
    '',
    `- High-water mark: ${payload.hwm_usdt} USDT`,
    `- Ratchet activo: ${payload.activated ? 'sí' : 'no'}`,
    '',
    `<!-- PROYPERS_GROWTH_V2_STATE ${JSON.stringify(payload)} -->`
  ].join('\n');
}

module.exports = {
  POLICY,
  floorCents,
  growthRatchet,
  pyramidDecision,
  parseGrowthState,
  growthStateBody
};
