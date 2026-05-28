const { getBinanceBotConfig } = require('./binanceBotConfig');

function normalizeBooleanEnv(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeMode(value, fallback = 'off') {
  const raw = String(value ?? fallback).trim().toLowerCase();
  if (raw === 'live') return 'live';
  if (raw === 'dry-run' || raw === 'dryrun' || raw === 'dry') return 'dry-run';
  if (raw === 'off') return 'off';
  return fallback;
}

function resolveBinanceCredential(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const sanitized = String(candidate)
      .trim()
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\r/g, '')
      .replace(/\n/g, '')
      .trim();
    if (sanitized) return sanitized;
  }
  return '';
}

function buildFlags(runtimeData = {}, botConfig = {}) {
  const enableBinance = normalizeBooleanEnv(process.env.ENABLE_BINANCE, false);
  const marketDataBinanceEnabled = normalizeBooleanEnv(process.env.MARKET_DATA_BINANCE_ENABLED, true);
  const binanceExecutionDryRun = normalizeBooleanEnv(process.env.BINANCE_EXECUTION_DRY_RUN, false);
  const liveTradingFlag = normalizeBooleanEnv(process.env.LIVE_TRADING_ENABLED, null);
  const paperTradingFlag = normalizeBooleanEnv(process.env.PAPER_TRADING_ENABLED, null);
  const binanceRealOrdersFlag = normalizeBooleanEnv(process.env.BINANCE_REAL_ORDERS_ENABLED, null);
  const executionModeFlag = process.env.EXECUTION_MODE || null;
  const tradingModeFlag = process.env.TRADING_MODE || null;
  const apiKey = resolveBinanceCredential(
    process.env.BINANCE_API_KEY,
    process.env.BINANCE_FUTURES_API_KEY,
    process.env.BINANCE_KEY,
    process.env.BINANCE_APIKEY
  );
  const apiSecret = resolveBinanceCredential(
    process.env.BINANCE_API_SECRET,
    process.env.BINANCE_FUTURES_API_SECRET,
    process.env.BINANCE_SECRET_KEY,
    process.env.BINANCE_SECRET
  );

  return {
    ENABLE_BINANCE: enableBinance,
    MARKET_DATA_BINANCE_ENABLED: marketDataBinanceEnabled,
    BINANCE_EXECUTION_ENABLED: true,
    LIVE_TRADING_ENABLED: liveTradingFlag,
    PAPER_TRADING_ENABLED: paperTradingFlag,
    TRADING_MODE: tradingModeFlag,
    EXECUTION_MODE: executionModeFlag,
    BINANCE_REAL_ORDERS_ENABLED: binanceRealOrdersFlag,
    BINANCE_EXECUTION_DRY_RUN: binanceExecutionDryRun,
    BOT_RUNTIME_EXECUTION_ENABLED: runtimeData.execution_enabled !== false,
    BOT_RUNTIME_AUTO_TRADE_MODE: runtimeData.auto_trade_mode !== false,
    BOT_RUNTIME_STATUS: runtimeData.status || null,
    BOT_RUNTIME_HALTED_REASON: runtimeData.halted_reason || null,
    BINANCE_BOT_CONFIG_EXECUTION_ENABLED: botConfig.execution_enabled !== false,
    BINANCE_BOT_CONFIG_MODE: botConfig.mode || 'off',
    BINANCE_API_KEY_PRESENT: Boolean(apiKey),
    BINANCE_API_SECRET_PRESENT: Boolean(apiSecret),
    K_SERVICE: process.env.K_SERVICE || null,
    K_REVISION: process.env.K_REVISION || null
  };
}

function resolveEnvironment() {
  if (process.env.K_SERVICE) return 'cloud_run';
  return process.env.NODE_ENV || 'local';
}

function resolveBlockState(state = {}) {
  const blocks = [];

  if (state.runtimeExecutionEnabled === false) {
    blocks.push({
      code: 'live_trading_disabled',
      switch: 'system_runtime_config/bot_execution.execution_enabled',
      detail: 'runtime execution safety gate is disabled'
    });
  }

  if (state.runtimeAutoTradeMode === false) {
    blocks.push({
      code: 'live_trading_disabled',
      switch: 'system_runtime_config/bot_execution.auto_trade_mode',
      detail: 'runtime auto trade mode is disabled'
    });
  }

  if (state.runtimeStatus === 'HALTED') {
    blocks.push({
      code: 'live_trading_disabled',
      switch: 'system_runtime_config/bot_execution.status',
      detail: state.runtimeHaltedReason
        ? `runtime status halted by ${state.runtimeHaltedReason}`
        : 'runtime status is HALTED'
    });
  }

  if (state.binanceOrderExecutionEnabled === false) {
    blocks.push({
      code: 'binance_execution_disabled',
      switch: 'binance_bot_config/global.execution_enabled',
      detail: 'binance executor config is disabled'
    });
  }

  if (state.tradingMode === 'off') {
    blocks.push({
      code: 'invalid_trading_mode',
      switch: 'binance_bot_config/global.mode',
      detail: 'trading mode is off'
    });
  }

  if (state.paperTradingEnabled === true && state.liveTradingEnabled === false) {
    blocks.push({
      code: 'paper_mode_only',
      switch: state.binanceExecutionDryRun
        ? 'env.BINANCE_EXECUTION_DRY_RUN'
        : 'binance_bot_config/global.mode',
      detail: 'system is configured for paper execution only'
    });
  }

  if (state.apiKeyPresent === false) {
    blocks.push({
      code: 'missing_api_keys',
      switch: 'env.BINANCE_API_KEY',
      detail: 'missing Binance API key'
    });
  }

  if (state.apiSecretPresent === false) {
    blocks.push({
      code: 'missing_secret',
      switch: 'env.BINANCE_API_SECRET',
      detail: 'missing Binance API secret'
    });
  }

  return blocks;
}

function resolveDiagnosis(primaryBlock) {
  const code = String(primaryBlock?.code || '').toLowerCase();
  if (!code) return 'ready_for_live_execution';
  if (code === 'paper_mode_only') return 'paper_mode_only';
  if (code === 'missing_api_keys' || code === 'missing_secret') return 'missing_credentials';
  if (code === 'live_trading_disabled' || code === 'binance_execution_disabled') {
    return 'execution_disabled_by_env';
  }
  return 'unknown';
}

async function getExecutionReadinessDiagnostic(db) {
  const [runtimeDoc, botConfig] = await Promise.all([
    db.collection('system_runtime_config').doc('bot_execution').get().catch(() => null),
    getBinanceBotConfig(db)
  ]);

  const runtimeData = runtimeDoc?.exists ? (runtimeDoc.data() || {}) : {};
  const flags = buildFlags(runtimeData, botConfig);
  const tradingMode = normalizeMode(botConfig.mode || 'off');
  const marketDataEnabled = Boolean(
    flags.ENABLE_BINANCE ||
    flags.MARKET_DATA_BINANCE_ENABLED ||
    process.env.ALPHA_VANTAGE_KEY
  );
  const binanceMarketDataEnabled = Boolean(flags.ENABLE_BINANCE || flags.MARKET_DATA_BINANCE_ENABLED);
  const runtimeExecutionEnabled = runtimeData.execution_enabled !== false;
  const runtimeAutoTradeMode = runtimeData.auto_trade_mode !== false;
  const binanceOrderExecutionEnabled = botConfig.execution_enabled !== false;
  const apiKeyPresent = Boolean(flags.BINANCE_API_KEY_PRESENT);
  const apiSecretPresent = Boolean(flags.BINANCE_API_SECRET_PRESENT);
  const binanceExecutionDryRun = Boolean(flags.BINANCE_EXECUTION_DRY_RUN);
  const paperTradingEnabled = tradingMode === 'dry-run' || binanceExecutionDryRun === true;
  const liveTradingEnabled =
    runtimeExecutionEnabled &&
    runtimeAutoTradeMode &&
    binanceOrderExecutionEnabled &&
    tradingMode === 'live' &&
    !paperTradingEnabled &&
    apiKeyPresent &&
    apiSecretPresent;

  const blockCandidates = resolveBlockState({
    runtimeExecutionEnabled,
    runtimeAutoTradeMode,
    runtimeStatus: String(runtimeData.status || '').toUpperCase() || null,
    runtimeHaltedReason: runtimeData.halted_reason || null,
    binanceOrderExecutionEnabled,
    tradingMode,
    paperTradingEnabled,
    liveTradingEnabled,
    apiKeyPresent,
    apiSecretPresent,
    binanceExecutionDryRun
  });
  const primaryBlock = blockCandidates[0] || null;

  return {
    execution_enabled: runtimeExecutionEnabled,
    market_data_enabled: marketDataEnabled,
    binance_market_data_enabled: binanceMarketDataEnabled,
    binance_order_execution_enabled: binanceOrderExecutionEnabled,
    live_trading_enabled: liveTradingEnabled,
    paper_trading_enabled: paperTradingEnabled,
    trading_mode: tradingMode,
    environment: resolveEnvironment(),
    cloud_run_revision: process.env.K_REVISION || null,
    flags,
    block_reason: primaryBlock?.code || null,
    diagnosis: resolveDiagnosis(primaryBlock),
    blocking_switch: primaryBlock?.switch || null,
    secondary_blocking_switches: blockCandidates.slice(1).map((item) => ({
      code: item.code,
      switch: item.switch,
      detail: item.detail
    })),
    runtime_status: runtimeData.status || null,
    runtime_halted_reason: runtimeData.halted_reason || null
  };
}

module.exports = {
  getExecutionReadinessDiagnostic
};
