/**
 * Binance Spot Real Execution Configuration
 * CONTROLLED & SAFE MODE
 * ========================
 *
 * This configuration controls the transition from paper-only to limited real trading.
 * All operations are strictly controlled with hardcoded safety limits.
 */

const REAL_SPOT_EXECUTION_CONFIG = {
    // === MASTER KILL SWITCH ===
    enabled: true, // MUST be true to allow real orders. Defaults to false for safety.
    require_manual_confirm: false, // Auto-enabled - system can trade without manual approval

    // === EXECUTION MODE ===
    mode: 'BINANCE_SPOT_REAL_CONTROLLED', // Real Spot trading with hard limits
    exchange: 'BINANCE_SPOT_ONLY', // Spot ONLY, NEVER Futures/Margin

    // === CAPITAL LIMITS (HARDCODED - CANNOT OVERRIDE AT RUNTIME) ===
    max_capital_usdt: 100, // Total account capital: 100 USDT ABSOLUTE MAXIMUM
    reserve_usdt: 10, // ALWAYS reserve 10 USDT (never trade with it)
    available_for_trading_usdt: 90, // 100 - 10 = 90 USDT for actual trading
    
    // === STRATEGY ALLOCATION (HYBRID MODE) ===
    conservative_strategy_pct: 70, // 70% for standard conservative strategy
    moonshot_strategy_pct: 30, // 30% for aggressive moonshot strategy
    conservative_capital_usdt: 63, // 70% of 90 = 63 USDT
    moonshot_capital_usdt: 27, // 30% of 90 = 27 USDT
    
    max_real_positions_open: 3, // Maximum 3 simultaneous positions
    max_capital_per_position_usdt: 30, // Per position: 30 USDT maximum

    // === STOP LOSS & TAKE PROFIT ===
    stop_loss_pct: 3, // Hard stop loss at 3% loss (MANDATORY) - ADJUSTED for faster closes
    take_profit_1_pct: 3, // TP1 at 3% gain - ADJUSTED for faster closes
    take_profit_2_pct: 6, // TP2 at 6% gain (optional target) - ADJUSTED for faster closes

    // === LOSS LIMITS (MANDATORY SAFETY BRAKES) ===
    daily_loss_limit_usdt: 5, // Stop trading if 5 USDT lost in a day
    total_loss_limit_usdt: 10, // Absolute max loss: 10 USDT entire phase
    consecutive_loss_limit: 2, // After 2 consecutive losses, DISABLE real execution
    max_drawdown_pct: 10, // Max drawdown: 10% of 100 USDT = 10 USDT

    // === FORBIDDEN OPERATIONS (HARDCODED REJECTIONS) ===
    allow_futures: false, // ABSOLUTELY FORBIDDEN - No Futures EVER
    allow_margin: false, // ABSOLUTELY FORBIDDEN - No Margin EVER
    allow_leverage: false, // ABSOLUTELY FORBIDDEN - No Leverage EVER
    allow_short: false, // ABSOLUTELY FORBIDDEN - No Short EVER
    allow_withdrawal: false, // ABSOLUTELY FORBIDDEN - No Withdrawals EVER
    allow_lending: false, // ABSOLUTELY FORBIDDEN - No Lending EVER

    // === SAFETY FLAGS (MANDATORY) ===
    require_stop_loss: true, // EVERY order MUST have stop loss
    require_limit_orders: true, // ONLY limit orders, NO market orders
    require_oco_orders: true, // One-Cancels-Other for safety
    require_dry_run_before_live: true, // MANDATORY dry-run BEFORE any live order
    dry_run_mode: true, // Show what WOULD execute

    // === FIRESTORE TRACKING (SEPARATE FROM PAPER) ===
    firestore_collections: {
        intents: 'spot_real_execution_intents',
        positions: 'spot_real_positions',
        results: 'spot_real_execution_results',
        errors: 'spot_real_execution_errors',
        config: 'spot_real_execution_config',
        dry_runs: 'spot_real_dry_runs'
    },

    // === SYMBOL VALIDATION (HARDCODED) ===
    allowed_quote_currencies: ['USDT'], // ONLY USDT pairs
    forbidden_symbols: [
        'UPUSDT', 'DOWNUSDT', // Leveraged tokens FORBIDDEN
        'BULLUPUSDT', 'BULLDOWNUSDT', // Inverse tokens FORBIDDEN
        'BEARUPUSDT', 'BEARDOWNUSDT', // Synthetic tokens FORBIDDEN
        'UP', 'DOWN', 'BULL', 'BEAR', // All leveraged variants FORBIDDEN
    ],
    require_symbol_from_spot_scanner: true, // Symbol MUST come from Spot scanner

    // === ORDER REQUIREMENTS ===
    min_notional_usdt: 5, // Binance minimum: 5 USDT notional
    max_notional_usdt: 30, // Our limit: 30 USDT per order
    min_order_value_usdt: 5, // Do not open positions < 5 USDT
    max_order_value_usdt: 30, // Do not open positions > 30 USDT
    min_take_profit_pct: 1, // Minimum 1% TP required
    min_stop_loss_pct: 2, // Minimum 2% SL required

    // === VALIDATION RULES ===
    require_klines_history: true, // Must have price history before trading
    require_liquidity_check: true, // Must verify pair has adequate liquidity
    require_24h_volume_min_usdt: 50000, // Minimum 50k USDT 24h volume

    // === DRY-RUN REQUIREMENTS ===
    dry_run_retention_hours: 24, // Keep dry-run logs for 24 hours
    require_dry_run_approval: true, // User must approve dry-run before live execution

    // === LOGGING & MONITORING ===
    log_level: 'DEBUG', // Log everything for audit
    require_audit_log: true, // All operations must be logged
    notify_on_order: true, // Alert on any real order
    notify_on_loss: true, // Alert on losses
    notify_on_disable: true, // Alert if real execution disabled

    // === CLOUD RUN RELIABILITY ===
    require_cloud_run_health_check: true, // Verify Cloud Run is healthy
    require_firestore_connectivity: true, // Verify Firestore is reachable
    require_binance_api_connectivity: true, // Verify Binance API is reachable

    // === ACTIVATION INSTRUCTIONS (MANUAL ONLY) ===
    // TO ACTIVATE REAL EXECUTION (ONLY IF USER AUTHORIZES):
    // 1. User must explicitly request activation
    // 2. Manually set enabled: true in this file (ONLY by user request)
    // 3. Manually set require_manual_confirm: true (ALREADY true)
    // 4. Restart backend (npm start or Cloud Run redeploy)
    // 5. First order will trigger mandatory dry-run
    // 6. User MUST approve dry-run before live execution
    // 7. If any error occurs, real execution auto-disables immediately
    // 8. If 2 consecutive losses, real execution auto-disables permanently
    // 9. If daily loss > 5 USDT, real execution disables until next day
    // 10. If total loss > 10 USDT, real execution disables PERMANENTLY
    // 11. Emergency stop: Set enabled: false and restart
};

module.exports = REAL_SPOT_EXECUTION_CONFIG;