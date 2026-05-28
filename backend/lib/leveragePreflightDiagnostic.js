const {
  getMarginLeverageReadinessSnapshot,
  hydrateMarginLeverageReadinessFromFirestore,
  testBinancePrivateConnectivity,
  getBinanceConnectionDebugState
} = require('./binanceFuturesExecutor');

function classifyDiagnostic(report = {}) {
  if (!report.api_key_present || !report.api_secret_present) return 'credentials_issue';
  if (report.binance_private_connectivity_ok === false && report.last_error_message?.toLowerCase?.().includes('timestamp')) {
    return 'timestamp_recvwindow_issue';
  }
  if (report.binance_private_connectivity_ok === false && report.leverage_prefight_timeout > 0) {
    return 'private_api_timeout';
  }
  if (report.leverage_prefight_success > 0 && report.leverage_prefight_failed === 0 && report.leverage_prefight_timeout === 0) {
    return 'already_configured_but_not_detected';
  }
  if (report.leverage_prefight_timeout > 0) return 'leverage_set_timeout';
  if (report.leverage_prefight_failed > 0 && report.last_error_message) return 'binance_rejection';
  return 'unknown';
}

async function getLeveragePreflightDiagnostic(_db, options = {}) {
  await hydrateMarginLeverageReadinessFromFirestore({ force: true }).catch(() => null);
  const snapshot = getMarginLeverageReadinessSnapshot();
  const connectivity = await testBinancePrivateConnectivity({ timeoutMs: 10000 });
  const debugState = getBinanceConnectionDebugState();
  const perSymbol = Array.isArray(snapshot.per_symbol) ? snapshot.per_symbol : [];
  const failedSymbols = perSymbol.filter((item) => item.ready !== true);
  const successSymbols = perSymbol.filter((item) => item.ready === true);
  const timeoutSymbols = failedSymbols.filter((item) =>
    String(item.last_error || '').toLowerCase().includes('timeout')
  );
  const failedButNotTimeout = failedSymbols.filter((item) =>
    !String(item.last_error || '').toLowerCase().includes('timeout')
  );

  const report = {
    symbols_checked: perSymbol.length,
    leverage_prefight_success: successSymbols.length,
    leverage_prefight_timeout: timeoutSymbols.length,
    leverage_prefight_failed: failedButNotTimeout.length,
    avg_duration_ms:
      perSymbol.length > 0
        ? Number(
            (
              perSymbol.reduce((sum, item) => sum + (Number(item.duration_ms || 0) || 0), 0) / perSymbol.length
            ).toFixed(0)
          )
        : 0,
    last_error_message: failedSymbols[0]?.last_error || connectivity.binance_msg || null,
    binance_private_connectivity_ok: Boolean(connectivity.ok),
    futures_account_access_ok: Boolean(connectivity.ok),
    server_time_offset_ms: debugState.server_time_offset_ms,
    recv_window_used: debugState.recv_window_used,
    api_key_present: debugState.api_key_present,
    api_secret_present: debugState.api_secret_present,
    symbols_failed: failedSymbols.map((item) => item.symbol),
    cloud_run_revision: String(process.env.K_REVISION || process.env.CLOUD_RUN_REVISION || '').trim() || null
  };

  return {
    ...report,
    diagnosis: classifyDiagnostic(report)
  };
}

module.exports = {
  getLeveragePreflightDiagnostic
};
