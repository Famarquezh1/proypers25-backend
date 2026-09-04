'use strict';

const BALANCE_DOC = 'real_spot_config/balance';
const DUST_COLLECTION = 'real_spot_dust_residuals';
const VERSION = 'spot_dust_residual_v2_sub_notional';
const EPSILON = 1e-12;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimalPlaces(step) {
  const text = String(step || '');
  if (!text.includes('.')) return 0;
  return text.replace(/0+$/, '').split('.')[1]?.length || 0;
}

function floorToStep(quantity, stepSize) {
  const step = number(stepSize);
  if (!(step > 0)) return 0;
  return Number((Math.floor((Math.max(0, number(quantity)) + Number.EPSILON) / step) * step)
    .toFixed(decimalPlaces(stepSize)));
}

function extractMarketRules(symbolInfo = {}) {
  const filters = Array.isArray(symbolInfo.filters) ? symbolInfo.filters : [];
  const lot = filters.find((item) => item.filterType === 'LOT_SIZE') ||
    filters.find((item) => item.filterType === 'MARKET_LOT_SIZE') || {};
  const notional = filters.find((item) => item.filterType === 'NOTIONAL') ||
    filters.find((item) => item.filterType === 'MIN_NOTIONAL') || {};
  return {
    symbol: String(symbolInfo.symbol || '').toUpperCase(),
    base_asset: String(symbolInfo.baseAsset || '').toUpperCase(),
    step_size: String(lot.stepSize || '0'),
    minimum_quantity: Math.max(0, number(lot.minQty)),
    minimum_notional_usdt: Math.max(0, number(notional.minNotional)),
    spot_trading_allowed: symbolInfo.isSpotTradingAllowed !== false && String(symbolInfo.status || '').toUpperCase() === 'TRADING'
  };
}

function classifyDustResidual({ residualQuantity, currentPrice, symbolInfo, marketRules } = {}) {
  const rules = marketRules || extractMarketRules(symbolInfo || {});
  const residual = Math.max(0, number(residualQuantity));
  const price = Math.max(0, number(currentPrice));
  const normalized = floorToStep(residual, rules.step_size);
  const residualValue = residual * price;
  const normalizedValue = normalized * price;
  const belowStep = residual > EPSILON && normalized <= EPSILON;
  const belowMinimumQuantity = rules.minimum_quantity > 0 && normalized < rules.minimum_quantity;
  const belowMinimumNotional = rules.minimum_notional_usdt > 0 && normalizedValue < rules.minimum_notional_usdt;
  const cleared = residual <= EPSILON;
  const dust = rules.spot_trading_allowed !== false && (cleared || belowStep || belowMinimumQuantity || belowMinimumNotional);
  const reasons = [];
  if (cleared) reasons.push('NO_RESIDUAL_BALANCE');
  if (belowStep) reasons.push('RESIDUAL_BELOW_STEP_SIZE');
  if (belowMinimumQuantity) reasons.push('RESIDUAL_BELOW_MINIMUM_QUANTITY');
  if (belowMinimumNotional) reasons.push('RESIDUAL_BELOW_MINIMUM_NOTIONAL');

  return {
    dust,
    cleared,
    below_step_size: belowStep,
    below_minimum_quantity: belowMinimumQuantity,
    below_minimum_notional: belowMinimumNotional,
    residual_classification: belowMinimumNotional ? 'SUB_MIN_NOTIONAL_RESIDUAL' : dust ? 'DUST_RESIDUAL' : null,
    reasons,
    residual_quantity: residual,
    residual_value_usdt: residualValue,
    normalized_sellable_quantity: normalized,
    normalized_sellable_value_usdt: normalizedValue,
    ...rules,
    version: VERSION
  };
}

async function closeSpotPositionAsDust(db, positionRef, position, classification, options = {}) {
  if (!db || !positionRef || !position?.id || classification?.dust !== true) {
    throw new Error('INVALID_DUST_RESIDUAL_CLOSE');
  }
  const now = options.closedAt || new Date().toISOString();
  const balanceRef = db.doc(BALANCE_DOC);
  const dustRef = db.collection(DUST_COLLECTION).doc(`dust_${position.id}`);

  return db.runTransaction(async (tx) => {
    const [positionSnap, dustSnap, balanceSnap] = await Promise.all([
      tx.get(positionRef),
      tx.get(dustRef),
      tx.get(balanceRef)
    ]);
    if (!positionSnap.exists) throw new Error('POSITION_NOT_FOUND');
    if (dustSnap.exists) return { idempotent: true, dustId: dustRef.id };

    const latest = { id: positionSnap.id, ...positionSnap.data() };
    if (latest.status !== 'REAL_OPEN') {
      return { idempotent: true, skipped: 'POSITION_NOT_OPEN', dustId: dustRef.id };
    }

    const remainingCapital = Math.max(0, number(latest.capital_usdt));
    const balance = balanceSnap.exists ? balanceSnap.data() : {};
    const residualQuantity = Math.max(0, number(classification.residual_quantity));
    const residualValue = Math.max(0, number(classification.residual_value_usdt));
    const residualClassification = classification.residual_classification || 'DUST_RESIDUAL';
    const originalExitReason = latest.last_partial_exit_reason || latest.exit_reason_pending || latest.closing_reason || null;

    tx.update(positionRef, {
      status: 'REAL_CLOSED',
      exit_status: 'DUST_RESIDUAL',
      residual_classification: residualClassification,
      closing_reason: originalExitReason || residualClassification,
      logical_closing_reason: residualClassification,
      close_source: 'BINANCE_BALANCE_RECONCILIATION',
      closed_at: now,
      quantity: 0,
      managed_quantity: 0,
      net_quantity: 0,
      capital_usdt: 0,
      remaining_quantity: 0,
      dust_residual_quantity: residualQuantity,
      dust_residual_value_usdt: residualValue,
      dust_residual_cost_usdt: remainingCapital,
      dust_residual_reasons: classification.reasons || [],
      dust_residual_sellable_quantity: number(classification.normalized_sellable_quantity),
      dust_residual_minimum_quantity: number(classification.minimum_quantity),
      dust_residual_minimum_notional_usdt: number(classification.minimum_notional_usdt),
      dust_asset_unmanaged: residualQuantity > EPSILON,
      exit_claim_id: null,
      exit_error: null,
      dust_residual_closed_at: now,
      dust_residual_version: VERSION
    });

    tx.set(dustRef, {
      id: dustRef.id,
      position_id: position.id,
      symbol: latest.symbol || position.symbol || null,
      asset: classification.base_asset || String(latest.symbol || '').replace(/USDT$/i, ''),
      status: residualQuantity > EPSILON ? 'UNMANAGED_DUST' : 'CLEARED',
      residual_classification: residualClassification,
      residual_quantity: residualQuantity,
      residual_value_usdt: residualValue,
      residual_cost_usdt: remainingCapital,
      normalized_sellable_quantity: number(classification.normalized_sellable_quantity),
      minimum_quantity: number(classification.minimum_quantity),
      minimum_notional_usdt: number(classification.minimum_notional_usdt),
      reasons: classification.reasons || [],
      original_exit_reason: originalExitReason,
      detected_at: now,
      real_mode: true,
      spot_only: true,
      version: VERSION
    });

    tx.set(balanceRef, {
      in_positions_usdt: Math.max(0, number(balance.in_positions_usdt) - remainingCapital),
      dust_residual_cost_usdt: number(balance.dust_residual_cost_usdt) + remainingCapital,
      dust_residual_value_usdt: number(balance.dust_residual_value_usdt) + residualValue,
      updated_at: now,
      source: 'SPOT_DUST_RESIDUAL_RECONCILIATION'
    }, { merge: true });

    return {
      idempotent: false,
      dustId: dustRef.id,
      positionId: position.id,
      residualClassification,
      residualQuantity,
      residualValue,
      residualCost: remainingCapital
    };
  });
}

module.exports = {
  VERSION,
  DUST_COLLECTION,
  number,
  floorToStep,
  extractMarketRules,
  classifyDustResidual,
  closeSpotPositionAsDust
};
