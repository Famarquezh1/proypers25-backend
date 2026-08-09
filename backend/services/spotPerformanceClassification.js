'use strict';

const RECONCILIATION_REASONS = new Set([
  'MANUAL_RECONCILIATION',
  'AUTO_RECONCILED',
  'PARTIAL_RECONCILIATION'
]);

const EXTERNAL_CLOSE_SOURCES = new Set([
  'BINANCE_CONVERT',
  'BINANCE_SPOT_FILLS',
  'BINANCE_BALANCE_RECONCILIATION'
]);

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedReason(row = {}) {
  return String(row.closing_reason || row.close_reason || row.reason || '').toUpperCase();
}

function normalizedSource(row = {}) {
  return String(row.close_source || row.source || '').toUpperCase();
}

function hasEconomicEvidence(row = {}) {
  const allocated = n(
    row.allocated_capital_usdt ?? row.capital_usdt ?? row.invested_usdt,
    0
  );
  const received = n(
    row.quote_received_usdt ?? row.received_usdt ?? row.received_quote_usdt,
    0
  );
  return allocated > 0 || received > 0;
}

function performanceExclusionReason(row = {}) {
  const reason = normalizedReason(row);
  const source = normalizedSource(row);
  if (row.performance_excluded === true) return row.performance_exclusion_reason || 'PREVIOUSLY_CLASSIFIED_EXCLUDED';
  if (row.external_conversion === true) return 'EXTERNAL_CONVERSION';
  if (row.external_spot_sale === true) return 'EXTERNAL_SPOT_SALE';
  if (RECONCILIATION_REASONS.has(reason)) return `RECONCILIATION_${reason}`;
  if (EXTERNAL_CLOSE_SOURCES.has(source)) return `EXTERNAL_SOURCE_${source}`;
  if (row.pnl_verified === false) return 'PNL_NOT_VERIFIED';
  if (!Number.isFinite(Number(row.net_pnl_usdt))) return 'PNL_MISSING';
  if (!hasEconomicEvidence(row)) return 'ECONOMIC_EVIDENCE_MISSING';
  return null;
}

function isBotPerformanceResult(row = {}) {
  return performanceExclusionReason(row) === null;
}

function buildPerformanceClassificationPatch(row = {}, now = new Date().toISOString()) {
  const exclusionReason = performanceExclusionReason({
    ...row,
    // Re-evaluate the raw record rather than letting an earlier classification
    // short-circuit a corrected classification rule.
    performance_excluded: false,
    performance_exclusion_reason: null
  });
  const excluded = exclusionReason !== null;
  return {
    performance_excluded: excluded,
    performance_exclusion_reason: exclusionReason,
    performance_classification: excluded ? 'EXTERNAL_OR_UNVERIFIED' : 'BOT_EXECUTION',
    performance_classified_at: now,
    // The current dashboard already uses this field to omit external rows from
    // bot PnL. Keep it as a backwards-compatible exclusion flag until the UI
    // consumes performance_excluded directly.
    external_conversion: excluded ? true : row.external_conversion === true
  };
}

function filterBotPerformanceResults(rows = []) {
  return rows.filter(isBotPerformanceResult);
}

module.exports = {
  RECONCILIATION_REASONS,
  EXTERNAL_CLOSE_SOURCES,
  n,
  normalizedReason,
  normalizedSource,
  hasEconomicEvidence,
  performanceExclusionReason,
  isBotPerformanceResult,
  buildPerformanceClassificationPatch,
  filterBotPerformanceResults
};
