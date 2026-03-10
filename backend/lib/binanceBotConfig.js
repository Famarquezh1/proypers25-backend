const DEFAULT_CONFIG = {
  mode: 'off', // off | dry-run | live
  use_funds_percent: 35,
  account_capital_usdt: 100,
  dynamic_sizing_enabled: true,
  sizing_low_context_factor: 0.7,
  sizing_high_context_factor: 1.15,
  default_leverage: 5,
  margin_type: 'CROSSED', // CROSSED | ISOLATED
  order_type: 'MARKET',
  enable_tp_sl: true,
  tp_order_type: 'TAKE_PROFIT_MARKET',
  sl_order_type: 'STOP_MARKET',
  tp_buffer_pct: 0,
  sl_buffer_pct: 0,
  max_daily_trades: 1,
  symbols_allowlist: [],
  min_confidence: 0.9,
  min_quantum: 0.85,
  min_timing: 0.8,
  min_context_score: 3,
  min_risk_reward: 1.2,
  min_expected_move_pct: 0.4,
  early_exit_enabled: false,
  early_exit_drawdown_pct: 0.25,
  // Backward-compatible profile routing. If missing, defaults below are applied.
  execution_profiles: {},
  updated_at: null
};

const DEFAULT_EXECUTION_PROFILES = {
  high_conviction: {
    enabled: true,
    mode: 'inherit', // inherit | off | dry-run | live
    allow_unlisted_symbols: false
  },
  event_emitted: {
    enabled: true,
    mode: 'inherit',
    // Allow broader coverage for emitted opportunities unless explicitly restricted.
    allow_unlisted_symbols: true,
    min_confidence: 0.85,
    min_quantum: 0.7,
    min_timing: 0.7,
    min_context_score: 0
  },
  manual_prealert: {
    enabled: true,
    mode: 'inherit',
    allow_unlisted_symbols: true,
    min_confidence: 0.82,
    min_quantum: 0.78,
    min_timing: 0.7,
    min_context_score: 0
  }
};

const CACHE_TTL_MS = Math.max(15000, Number(process.env.BINANCE_CONFIG_CACHE_TTL_MS || 60000));
let cache = {
  value: null,
  loadedAt: 0
};

function normalizeMode(mode) {
  const raw = String(mode || '').toLowerCase();
  if (raw === 'live') return 'live';
  if (raw === 'dry-run' || raw === 'dryrun' || raw === 'dry') return 'dry-run';
  return 'off';
}

function normalizeProfileMode(mode) {
  const raw = String(mode || '').toLowerCase();
  if (raw === 'inherit') return 'inherit';
  return normalizeMode(mode);
}

function normalizeSymbolsAllowlist(value) {
  return Array.isArray(value)
    ? value.map((s) => String(s).toUpperCase()).filter(Boolean)
    : [];
}

function normalizeProfileConfig(baseConfig, rawProfile, defaultProfile) {
  const profile = { ...(defaultProfile || {}), ...(rawProfile || {}) };
  return {
    enabled: profile.enabled !== false,
    mode: normalizeProfileMode(profile.mode || 'inherit'),
    allow_unlisted_symbols:
      profile.allow_unlisted_symbols === true ||
      (defaultProfile?.allow_unlisted_symbols === true && profile.allow_unlisted_symbols !== false),
    use_funds_percent: Math.max(1, Math.min(100, Number(profile.use_funds_percent ?? baseConfig.use_funds_percent))),
    account_capital_usdt: Math.max(5, Number(profile.account_capital_usdt ?? baseConfig.account_capital_usdt)),
    dynamic_sizing_enabled: profile.dynamic_sizing_enabled ?? baseConfig.dynamic_sizing_enabled,
    sizing_low_context_factor: Math.max(0.1, Number(profile.sizing_low_context_factor ?? baseConfig.sizing_low_context_factor)),
    sizing_high_context_factor: Math.max(0.1, Number(profile.sizing_high_context_factor ?? baseConfig.sizing_high_context_factor)),
    default_leverage: Math.max(1, Math.floor(Number(profile.default_leverage ?? baseConfig.default_leverage))),
    margin_type:
      String(profile.margin_type || baseConfig.margin_type).toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
    order_type: 'MARKET',
    enable_tp_sl: profile.enable_tp_sl ?? baseConfig.enable_tp_sl,
    tp_order_type: 'TAKE_PROFIT_MARKET',
    sl_order_type: 'STOP_MARKET',
    tp_buffer_pct: Math.max(0, Number(profile.tp_buffer_pct ?? baseConfig.tp_buffer_pct)),
    sl_buffer_pct: Math.max(0, Number(profile.sl_buffer_pct ?? baseConfig.sl_buffer_pct)),
    max_daily_trades: Math.max(1, Math.floor(Number(profile.max_daily_trades ?? baseConfig.max_daily_trades))),
    symbols_allowlist: normalizeSymbolsAllowlist(profile.symbols_allowlist),
    min_confidence: Number(profile.min_confidence ?? baseConfig.min_confidence),
    min_quantum: Number(profile.min_quantum ?? baseConfig.min_quantum),
    min_timing: Number(profile.min_timing ?? baseConfig.min_timing),
    min_context_score: Math.max(0, Math.min(4, Number(profile.min_context_score ?? baseConfig.min_context_score))),
    min_risk_reward: Math.max(0.1, Number(profile.min_risk_reward ?? baseConfig.min_risk_reward)),
    min_expected_move_pct: Math.max(0, Number(profile.min_expected_move_pct ?? baseConfig.min_expected_move_pct)),
    early_exit_enabled: Boolean(profile.early_exit_enabled ?? baseConfig.early_exit_enabled),
    early_exit_drawdown_pct: Number(profile.early_exit_drawdown_pct ?? baseConfig.early_exit_drawdown_pct)
  };
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
  cfg.mode = normalizeMode(cfg.mode);
  cfg.use_funds_percent = Math.max(1, Math.min(100, Number(cfg.use_funds_percent ?? DEFAULT_CONFIG.use_funds_percent)));
  cfg.account_capital_usdt = Math.max(5, Number(cfg.account_capital_usdt ?? DEFAULT_CONFIG.account_capital_usdt));
  cfg.dynamic_sizing_enabled = cfg.dynamic_sizing_enabled !== false;
  cfg.sizing_low_context_factor = Math.max(0.1, Number(cfg.sizing_low_context_factor ?? DEFAULT_CONFIG.sizing_low_context_factor));
  cfg.sizing_high_context_factor = Math.max(0.1, Number(cfg.sizing_high_context_factor ?? DEFAULT_CONFIG.sizing_high_context_factor));
  cfg.default_leverage = Math.max(1, Math.floor(Number(cfg.default_leverage ?? DEFAULT_CONFIG.default_leverage)));
  cfg.margin_type = String(cfg.margin_type || DEFAULT_CONFIG.margin_type).toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED';
  cfg.order_type = 'MARKET';
  cfg.enable_tp_sl = cfg.enable_tp_sl !== false;
  cfg.tp_order_type = 'TAKE_PROFIT_MARKET';
  cfg.sl_order_type = 'STOP_MARKET';
  cfg.tp_buffer_pct = Math.max(0, Number(cfg.tp_buffer_pct ?? 0));
  cfg.sl_buffer_pct = Math.max(0, Number(cfg.sl_buffer_pct ?? 0));
  cfg.max_daily_trades = Math.max(1, Math.floor(Number(cfg.max_daily_trades ?? DEFAULT_CONFIG.max_daily_trades)));
  cfg.min_confidence = Number(cfg.min_confidence ?? DEFAULT_CONFIG.min_confidence);
  cfg.min_quantum = Number(cfg.min_quantum ?? DEFAULT_CONFIG.min_quantum);
  cfg.min_timing = Number(cfg.min_timing ?? DEFAULT_CONFIG.min_timing);
  cfg.min_context_score = Math.max(0, Math.min(4, Number(cfg.min_context_score ?? DEFAULT_CONFIG.min_context_score)));
  cfg.min_risk_reward = Math.max(0.1, Number(cfg.min_risk_reward ?? DEFAULT_CONFIG.min_risk_reward));
  cfg.min_expected_move_pct = Math.max(0, Number(cfg.min_expected_move_pct ?? DEFAULT_CONFIG.min_expected_move_pct));
  cfg.early_exit_enabled = Boolean(cfg.early_exit_enabled);
  cfg.early_exit_drawdown_pct = Number(cfg.early_exit_drawdown_pct ?? DEFAULT_CONFIG.early_exit_drawdown_pct);
  cfg.symbols_allowlist = normalizeSymbolsAllowlist(cfg.symbols_allowlist);

  const rawProfiles = cfg.execution_profiles && typeof cfg.execution_profiles === 'object'
    ? cfg.execution_profiles
    : {};
  cfg.execution_profiles = {
    high_conviction: normalizeProfileConfig(cfg, rawProfiles.high_conviction, DEFAULT_EXECUTION_PROFILES.high_conviction),
    event_emitted: normalizeProfileConfig(cfg, rawProfiles.event_emitted, DEFAULT_EXECUTION_PROFILES.event_emitted),
    manual_prealert: normalizeProfileConfig(cfg, rawProfiles.manual_prealert, DEFAULT_EXECUTION_PROFILES.manual_prealert)
  };
  return cfg;
}

async function getBinanceBotConfig(db) {
  const now = Date.now();
  if (cache.value && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  try {
    const snap = await db.collection('binance_bot_config').doc('global').get();
    const value = normalizeConfig(snap.exists ? snap.data() : null);
    cache = { value, loadedAt: now };
    return value;
  } catch (_) {
    const value = normalizeConfig(null);
    cache = { value, loadedAt: now };
    return value;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  getBinanceBotConfig
};
