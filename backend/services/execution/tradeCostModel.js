function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round4(value) {
  return Number(toFinite(value, 0).toFixed(4));
}

function resolveTradeCostConfig(overrides = {}) {
  const feePerSidePct = Math.max(
    0,
    toFinite(
      overrides.fee_per_side_pct ??
        overrides.taker_fee_pct ??
        process.env.BINANCE_FEE_PER_SIDE_PCT ??
        process.env.BINANCE_TAKER_FEE_PCT,
      0.05
    )
  );
  const roundtripFeePct = Math.max(
    0,
    toFinite(
      overrides.roundtrip_fee_pct ?? process.env.BINANCE_ROUNDTRIP_FEE_PCT,
      feePerSidePct * 2
    )
  );
  const slippageBufferPct = Math.max(
    0,
    toFinite(
      overrides.slippage_buffer_pct ?? process.env.BINANCE_NET_SLIPPAGE_BUFFER_PCT,
      0.03
    )
  );
  const minimumNetProfitPct = Math.max(
    0,
    toFinite(
      overrides.minimum_net_profit_pct ?? process.env.BINANCE_MIN_NET_PROFIT_PCT,
      0.02
    )
  );
  const costFloorPct = round4(roundtripFeePct + slippageBufferPct);
  return {
    fee_per_side_pct: round4(feePerSidePct),
    roundtrip_fee_pct: round4(roundtripFeePct),
    slippage_buffer_pct: round4(slippageBufferPct),
    cost_floor_pct: costFloorPct,
    minimum_net_profit_pct: round4(minimumNetProfitPct),
    minimum_gross_profit_pct: round4(costFloorPct + minimumNetProfitPct)
  };
}

function estimateNetPnlPct(grossPnlPct, overrides = {}) {
  const config = resolveTradeCostConfig(overrides);
  return round4(toFinite(grossPnlPct, 0) - config.cost_floor_pct);
}

function resolveNetOutcome(grossPnlPct, overrides = {}) {
  const netPnlPct = estimateNetPnlPct(grossPnlPct, overrides);
  if (netPnlPct > 0.0001) return 'WIN';
  if (netPnlPct < -0.0001) return 'LOSS';
  return 'BREAKEVEN';
}

module.exports = {
  resolveTradeCostConfig,
  estimateNetPnlPct,
  resolveNetOutcome
};
