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
  updated_at: null
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

function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
  cfg.mode = normalizeMode(cfg.mode);
  cfg.use_funds_percent = Math.max(1, Math.min(100, Number(cfg.use_funds_percent || DEFAULT_CONFIG.use_funds_percent)));
  cfg.account_capital_usdt = Math.max(5, Number(cfg.account_capital_usdt || DEFAULT_CONFIG.account_capital_usdt));
  cfg.dynamic_sizing_enabled = cfg.dynamic_sizing_enabled !== false;
  cfg.sizing_low_context_factor = Math.max(0.1, Number(cfg.sizing_low_context_factor || DEFAULT_CONFIG.sizing_low_context_factor));
  cfg.sizing_high_context_factor = Math.max(0.1, Number(cfg.sizing_high_context_factor || DEFAULT_CONFIG.sizing_high_context_factor));
  cfg.default_leverage = Math.max(1, Math.floor(Number(cfg.default_leverage || DEFAULT_CONFIG.default_leverage)));
  cfg.margin_type = String(cfg.margin_type || DEFAULT_CONFIG.margin_type).toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED';
  cfg.order_type = 'MARKET';
  cfg.enable_tp_sl = cfg.enable_tp_sl !== false;
  cfg.tp_order_type = 'TAKE_PROFIT_MARKET';
  cfg.sl_order_type = 'STOP_MARKET';
  cfg.tp_buffer_pct = Math.max(0, Number(cfg.tp_buffer_pct || 0));
  cfg.sl_buffer_pct = Math.max(0, Number(cfg.sl_buffer_pct || 0));
  cfg.max_daily_trades = Math.max(1, Math.floor(Number(cfg.max_daily_trades || DEFAULT_CONFIG.max_daily_trades)));
  cfg.min_confidence = Number(cfg.min_confidence || DEFAULT_CONFIG.min_confidence);
  cfg.min_quantum = Number(cfg.min_quantum || DEFAULT_CONFIG.min_quantum);
  cfg.min_timing = Number(cfg.min_timing || DEFAULT_CONFIG.min_timing);
  cfg.min_context_score = Math.max(0, Math.min(4, Number(cfg.min_context_score || DEFAULT_CONFIG.min_context_score)));
  cfg.min_risk_reward = Math.max(0.1, Number(cfg.min_risk_reward || DEFAULT_CONFIG.min_risk_reward));
  cfg.min_expected_move_pct = Math.max(0, Number(cfg.min_expected_move_pct || DEFAULT_CONFIG.min_expected_move_pct));
  cfg.early_exit_enabled = Boolean(cfg.early_exit_enabled);
  cfg.early_exit_drawdown_pct = Number(cfg.early_exit_drawdown_pct || DEFAULT_CONFIG.early_exit_drawdown_pct);
  cfg.symbols_allowlist = Array.isArray(cfg.symbols_allowlist)
    ? cfg.symbols_allowlist.map((s) => String(s).toUpperCase()).filter(Boolean)
    : [];
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
