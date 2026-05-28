const DEFAULT_CONFIG = {
    mode: 'off', // off | dry-run | live
    execution_enabled: true,
    position_size_percent: 0.05,
    max_concurrent_trades: 1,
    use_funds_percent: 35,
    account_capital_usdt: 100,
    dynamic_sizing_enabled: true,
    sizing_low_context_factor: 0.7,
    sizing_high_context_factor: 1.15,
    default_leverage: 3,
    margin_type: 'ISOLATED', // CROSSED | ISOLATED
    order_type: 'MARKET',
    enable_tp_sl: true,
    tp_order_type: 'TAKE_PROFIT_MARKET',
    sl_order_type: 'STOP_MARKET',
    tp_buffer_pct: 0,
    sl_buffer_pct: 0,
    max_daily_trades: 1,
    symbols_allowlist: [],
    allow_unlisted_symbols: false,
    max_notional_usdt: 35,
    min_recent_valid_records: 0,
    recent_records_window_minutes: 180,
    symbol_cooldown_minutes: 0,
    min_confidence: 0.65,
    min_quantum: 0.6,
    min_timing: 0.6,
    min_context_score: 3,
    min_context_quality: 0,
    min_risk_reward: 1.2,
    min_expected_move_pct: 0.4,
    min_net_edge_expected_pct: 0.50,
    net_edge_gate_enabled: true,
    early_exit_enabled: false,
    early_exit_drawdown_pct: 0.25,
    execution_guard: {},
    market_stream: {},
    impulse_lifecycle: {},
    adaptive_exit: {},
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
        use_funds_percent: 18,
        max_notional_usdt: 18,
        min_confidence: 0.65,
        min_quantum: 0.6,
        min_timing: 0.6,
        min_context_score: 0,
        min_context_quality: 0,
        min_risk_reward: 1.35,
        min_expected_move_pct: 0.15,
        min_net_edge_expected_pct: 0.50,
        net_edge_gate_enabled: true
    },
    manual_prealert: {
        enabled: true,
        mode: 'inherit',
        allow_unlisted_symbols: true,
        min_confidence: 0.65,
        min_quantum: 0.6,
        min_timing: 0.6,
        min_context_score: 0,
        min_context_quality: 0
    }
};

const CACHE_TTL_MS = Math.max(15000, Number(process.env.BINANCE_CONFIG_CACHE_TTL_MS || 60000));
let cache = {
    value: null,
    loadedAt: 0
};

const RELAXED_ENTRY_MIN_CONFIDENCE = 0.65;
const RELAXED_ENTRY_MIN_QUANTUM = 0.6;
const RELAXED_ENTRY_MIN_TIMING = 0.6;

function normalizeRelaxedThreshold(value, relaxedValue) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return relaxedValue;
    }
    return Math.max(relaxedValue, Math.min(numeric, relaxedValue));
}

function normalizeFeatureMode(value, fallback = 'off') {
    const raw = String(value ?? fallback).toLowerCase();
    if (raw === 'observe') return 'observe';
    if (raw === 'enforce') return 'enforce';
    if (raw === 'true') return 'observe';
    return 'off';
}

function normalizeFeatureSymbols(value) {
    return Array.isArray(value) ?
        value.map((item) => String(item || '').toUpperCase()).filter(Boolean) :
        [];
}

function normalizeFeatureScope(value, fallback = 'all') {
    const raw = String(value || fallback).toLowerCase();
    if (['all', 'high_conviction', 'event_emitted', 'manual_prealert'].includes(raw)) {
        return raw;
    }
    return fallback;
}

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
    return Array.isArray(value) ?
        value.map((s) => String(s).toUpperCase()).filter(Boolean) :
        [];
}

function normalizeProfileConfig(baseConfig, rawProfile, defaultProfile) {
    const profile = {...(defaultProfile || {}), ...(rawProfile || {}) };
    return {
        enabled: profile.enabled !== false,
        mode: normalizeProfileMode(profile.mode || 'inherit'),
        allow_unlisted_symbols: profile.allow_unlisted_symbols === true ||
            (defaultProfile ?.allow_unlisted_symbols === true && profile.allow_unlisted_symbols !== false),
        execution_enabled: profile.execution_enabled ?? baseConfig.execution_enabled,
        position_size_percent: Math.max(
            0.01,
            Math.min(1, Number(profile.position_size_percent ?? baseConfig.position_size_percent ?? 0.1))
        ),
        max_concurrent_trades: Math.max(
            1,
            Math.floor(Number(profile.max_concurrent_trades ?? baseConfig.max_concurrent_trades ?? 1))
        ),
        use_funds_percent: Math.max(1, Math.min(100, Number(profile.use_funds_percent ?? baseConfig.use_funds_percent))),
        account_capital_usdt: Math.max(5, Number(profile.account_capital_usdt ?? baseConfig.account_capital_usdt)),
        dynamic_sizing_enabled: profile.dynamic_sizing_enabled ?? baseConfig.dynamic_sizing_enabled,
        sizing_low_context_factor: Math.max(0.1, Number(profile.sizing_low_context_factor ?? baseConfig.sizing_low_context_factor)),
        sizing_high_context_factor: Math.max(0.1, Number(profile.sizing_high_context_factor ?? baseConfig.sizing_high_context_factor)),
        default_leverage: Math.max(1, Math.floor(Number(profile.default_leverage ?? baseConfig.default_leverage))),
        margin_type: String(profile.margin_type || baseConfig.margin_type).toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
        order_type: 'MARKET',
        enable_tp_sl: profile.enable_tp_sl ?? baseConfig.enable_tp_sl,
        tp_order_type: 'TAKE_PROFIT_MARKET',
        sl_order_type: 'STOP_MARKET',
        tp_buffer_pct: Math.max(0, Number(profile.tp_buffer_pct ?? baseConfig.tp_buffer_pct)),
        sl_buffer_pct: Math.max(0, Number(profile.sl_buffer_pct ?? baseConfig.sl_buffer_pct)),
        max_daily_trades: Math.max(1, Math.floor(Number(profile.max_daily_trades ?? baseConfig.max_daily_trades))),
        symbols_allowlist: normalizeSymbolsAllowlist(profile.symbols_allowlist),
        max_notional_usdt: Math.max(5, Number(profile.max_notional_usdt ?? baseConfig.max_notional_usdt)),
        min_recent_valid_records: Math.max(
            0,
            Math.floor(Number(profile.min_recent_valid_records ?? baseConfig.min_recent_valid_records))
        ),
        recent_records_window_minutes: Math.max(
            30,
            Math.floor(Number(profile.recent_records_window_minutes ?? baseConfig.recent_records_window_minutes))
        ),
        symbol_cooldown_minutes: Math.max(
            0,
            Math.floor(Number(profile.symbol_cooldown_minutes ?? baseConfig.symbol_cooldown_minutes))
        ),
        min_confidence: normalizeRelaxedThreshold(
            profile.min_confidence ?? baseConfig.min_confidence,
            RELAXED_ENTRY_MIN_CONFIDENCE
        ),
        min_quantum: normalizeRelaxedThreshold(
            profile.min_quantum ?? baseConfig.min_quantum,
            RELAXED_ENTRY_MIN_QUANTUM
        ),
        min_timing: normalizeRelaxedThreshold(
            profile.min_timing ?? baseConfig.min_timing,
            RELAXED_ENTRY_MIN_TIMING
        ),
        min_context_score: Math.max(0, Math.min(4, Number(profile.min_context_score ?? baseConfig.min_context_score))),
        min_context_quality: Math.max(
            0,
            Math.min(100, Number(profile.min_context_quality ?? baseConfig.min_context_quality))
        ),
        min_risk_reward: Math.max(0.1, Number(profile.min_risk_reward ?? baseConfig.min_risk_reward)),
        min_expected_move_pct: Math.max(0, Number(profile.min_expected_move_pct ?? baseConfig.min_expected_move_pct)),
        min_net_edge_expected_pct: Math.max(0, Number(profile.min_net_edge_expected_pct ?? baseConfig.min_net_edge_expected_pct)),
        net_edge_gate_enabled: profile.net_edge_gate_enabled ?? baseConfig.net_edge_gate_enabled,
        early_exit_enabled: Boolean(profile.early_exit_enabled ?? baseConfig.early_exit_enabled),
        early_exit_drawdown_pct: Number(profile.early_exit_drawdown_pct ?? baseConfig.early_exit_drawdown_pct)
    };
}

function normalizeConfig(raw) {
    const cfg = {...DEFAULT_CONFIG, ...(raw || {}) };
    cfg.mode = normalizeMode(cfg.mode);
    cfg.execution_enabled = cfg.execution_enabled !== false;
    cfg.position_size_percent = Math.max(
        0.01,
        Math.min(1, Number(cfg.position_size_percent ?? DEFAULT_CONFIG.position_size_percent))
    );
    cfg.max_concurrent_trades = Math.max(
        1,
        Math.floor(Number(cfg.max_concurrent_trades ?? DEFAULT_CONFIG.max_concurrent_trades))
    );
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
    cfg.allow_unlisted_symbols = cfg.allow_unlisted_symbols === true;
    cfg.max_notional_usdt = Math.max(5, Number(cfg.max_notional_usdt ?? DEFAULT_CONFIG.max_notional_usdt));
    cfg.min_recent_valid_records = Math.max(
        0,
        Math.floor(Number(cfg.min_recent_valid_records ?? DEFAULT_CONFIG.min_recent_valid_records))
    );
    cfg.recent_records_window_minutes = Math.max(
        30,
        Math.floor(Number(cfg.recent_records_window_minutes ?? DEFAULT_CONFIG.recent_records_window_minutes))
    );
    cfg.symbol_cooldown_minutes = Math.max(
        0,
        Math.floor(Number(cfg.symbol_cooldown_minutes ?? DEFAULT_CONFIG.symbol_cooldown_minutes))
    );
    cfg.min_confidence = normalizeRelaxedThreshold(cfg.min_confidence ?? DEFAULT_CONFIG.min_confidence, RELAXED_ENTRY_MIN_CONFIDENCE);
    cfg.min_quantum = normalizeRelaxedThreshold(cfg.min_quantum ?? DEFAULT_CONFIG.min_quantum, RELAXED_ENTRY_MIN_QUANTUM);
    cfg.min_timing = normalizeRelaxedThreshold(cfg.min_timing ?? DEFAULT_CONFIG.min_timing, RELAXED_ENTRY_MIN_TIMING);
    cfg.min_context_score = Math.max(0, Math.min(4, Number(cfg.min_context_score ?? DEFAULT_CONFIG.min_context_score)));
    cfg.min_context_quality = Math.max(
        0,
        Math.min(100, Number(cfg.min_context_quality ?? DEFAULT_CONFIG.min_context_quality))
    );
    cfg.min_risk_reward = Math.max(0.1, Number(cfg.min_risk_reward ?? DEFAULT_CONFIG.min_risk_reward));
    cfg.min_expected_move_pct = Math.max(0, Number(cfg.min_expected_move_pct ?? DEFAULT_CONFIG.min_expected_move_pct));
    cfg.min_net_edge_expected_pct = Math.max(0, Number(cfg.min_net_edge_expected_pct ?? DEFAULT_CONFIG.min_net_edge_expected_pct));
    cfg.net_edge_gate_enabled = cfg.net_edge_gate_enabled !== false;
    cfg.early_exit_enabled = Boolean(cfg.early_exit_enabled);
    cfg.early_exit_drawdown_pct = Number(cfg.early_exit_drawdown_pct ?? DEFAULT_CONFIG.early_exit_drawdown_pct);
    cfg.symbols_allowlist = normalizeSymbolsAllowlist(cfg.symbols_allowlist);

    const rawProfiles = cfg.execution_profiles && typeof cfg.execution_profiles === 'object' ?
        cfg.execution_profiles :
        {};
    cfg.execution_profiles = {
        high_conviction: normalizeProfileConfig(cfg, rawProfiles.high_conviction, DEFAULT_EXECUTION_PROFILES.high_conviction),
        event_emitted: normalizeProfileConfig(cfg, rawProfiles.event_emitted, DEFAULT_EXECUTION_PROFILES.event_emitted),
        manual_prealert: normalizeProfileConfig(cfg, rawProfiles.manual_prealert, DEFAULT_EXECUTION_PROFILES.manual_prealert)
    };

    const marketStreamRaw = cfg.market_stream && typeof cfg.market_stream === 'object' ?
        cfg.market_stream :
        {};
    const marketStreamMode = normalizeFeatureMode(
        marketStreamRaw.mode ?? marketStreamRaw.enabled ?? process.env.MARKET_STREAM_ENABLED,
        'off'
    );
    cfg.market_stream = {
        mode: marketStreamMode,
        enabled: marketStreamMode !== 'off',
        snapshot_enabled: marketStreamRaw.snapshot_enabled ??
            String(process.env.MICROSTRUCTURE_SNAPSHOT_ENABLED || 'false').toLowerCase() === 'true',
        snapshot_interval_ms: Math.max(
            1000,
            Number(marketStreamRaw.snapshot_interval_ms ?? process.env.MARKET_STREAM_SNAPSHOT_INTERVAL_MS ?? 2000)
        ),
        snapshot_publish_interval_ms: Math.max(
            2000,
            Number(
                marketStreamRaw.snapshot_publish_interval_ms ??
                process.env.MARKET_STREAM_SNAPSHOT_PUBLISH_INTERVAL_MS ??
                15000
            )
        ),
        recent_signal_ttl_ms: Math.max(
            60 * 1000,
            Number(marketStreamRaw.recent_signal_ttl_ms ?? process.env.MARKET_STREAM_RECENT_SIGNAL_TTL_MS ?? 20 * 60 * 1000)
        ),
        allowlist_ttl_ms: Math.max(
            60 * 1000,
            Number(marketStreamRaw.allowlist_ttl_ms ?? process.env.MARKET_STREAM_ALLOWLIST_TTL_MS ?? 30 * 60 * 1000)
        ),
        position_ttl_ms: Math.max(
            60 * 1000,
            Number(marketStreamRaw.position_ttl_ms ?? process.env.MARKET_STREAM_POSITION_TTL_MS ?? 30 * 60 * 1000)
        ),
        intent_ttl_ms: Math.max(
            60 * 1000,
            Number(marketStreamRaw.intent_ttl_ms ?? process.env.MARKET_STREAM_INTENT_TTL_MS ?? 20 * 60 * 1000)
        )
    };

    const executionGuardRaw = cfg.execution_guard && typeof cfg.execution_guard === 'object' ?
        cfg.execution_guard :
        {};
    const legacyExecutionGuardMinEntryQualityRaw = Number(
        executionGuardRaw.min_entry_quality_score ??
        process.env.EXECUTION_GUARD_MIN_ENTRY_QUALITY_SCORE ??
        0.7
    );
    const normalizedExecutionGuardHighQuality =
        legacyExecutionGuardMinEntryQualityRaw <= 1 ?
        legacyExecutionGuardMinEntryQualityRaw * 100 :
        legacyExecutionGuardMinEntryQualityRaw;
    const executionGuardHighQualityScore = Math.max(
        45,
        Math.min(
            95,
            Number(
                executionGuardRaw.high_quality_score ??
                process.env.EXECUTION_GUARD_HIGH_QUALITY_SCORE ??
                normalizedExecutionGuardHighQuality
            )
        )
    );
    const executionGuardMediumQualityScore = Math.max(
        20,
        Math.min(
            executionGuardHighQualityScore - 5,
            Number(
                executionGuardRaw.medium_quality_score ??
                process.env.EXECUTION_GUARD_MEDIUM_QUALITY_SCORE ??
                38
            )
        )
    );
    cfg.execution_guard = {
        enabled: executionGuardRaw.enabled ??
            String(process.env.EXECUTION_GUARD_ENABLED || 'true').toLowerCase() !== 'false',
        signal_expiration_ms: Math.max(
            15000,
            Number(
                executionGuardRaw.signal_expiration_ms ??
                process.env.EXECUTION_GUARD_SIGNAL_EXPIRATION_MS ??
                45000
            )
        ),
        snapshot_wait_ms: Math.max(
            0,
            Number(
                executionGuardRaw.snapshot_wait_ms ??
                process.env.EXECUTION_GUARD_SNAPSHOT_WAIT_MS ??
                2500
            )
        ),
        snapshot_poll_interval_ms: Math.max(
            100,
            Number(
                executionGuardRaw.snapshot_poll_interval_ms ??
                process.env.EXECUTION_GUARD_SNAPSHOT_POLL_INTERVAL_MS ??
                200
            )
        ),
        max_snapshot_staleness_ms: Math.max(
            1000,
            Number(
                executionGuardRaw.max_snapshot_staleness_ms ??
                process.env.EXECUTION_GUARD_MAX_SNAPSHOT_STALENESS_MS ??
                8000
            )
        ),
        high_quality_score: executionGuardHighQualityScore,
        medium_quality_score: executionGuardMediumQualityScore,
        min_entry_quality_score: Math.max(
            0,
            Math.min(1, executionGuardHighQualityScore / 100)
        ),
        max_price_deviation_pct: Math.max(
            0.02,
            Number(
                executionGuardRaw.max_price_deviation_pct ??
                process.env.EXECUTION_GUARD_MAX_PRICE_DEVIATION_PCT ??
                0.75
            )
        ),
        hard_price_deviation_pct: Math.max(
            0.05,
            Number(
                executionGuardRaw.hard_price_deviation_pct ??
                process.env.EXECUTION_GUARD_HARD_PRICE_DEVIATION_PCT ??
                1.4
            )
        ),
        max_estimated_slippage_pct: Math.max(
            0.02,
            Number(
                executionGuardRaw.max_estimated_slippage_pct ??
                process.env.EXECUTION_GUARD_MAX_ESTIMATED_SLIPPAGE_PCT ??
                0.45
            )
        ),
        hard_estimated_slippage_pct: Math.max(
            0.05,
            Number(
                executionGuardRaw.hard_estimated_slippage_pct ??
                process.env.EXECUTION_GUARD_HARD_ESTIMATED_SLIPPAGE_PCT ??
                0.85
            )
        ),
        max_spread_bps: Math.max(
            0.1,
            Number(executionGuardRaw.max_spread_bps ?? process.env.EXECUTION_GUARD_MAX_SPREAD_BPS ?? 8)
        ),
        min_recent_trades_window: Math.max(
            0,
            Math.floor(
                Number(
                    executionGuardRaw.min_recent_trades_window ??
                    process.env.EXECUTION_GUARD_MIN_RECENT_TRADES_WINDOW ??
                    1
                )
            )
        ),
        good_velocity_bps_per_sec: Math.max(
            0.5,
            Number(
                executionGuardRaw.good_velocity_bps_per_sec ??
                process.env.EXECUTION_GUARD_GOOD_VELOCITY_BPS_PER_SEC ??
                5
            )
        ),
        adverse_velocity_bps_per_sec: -Math.max(
            0.5,
            Number(
                executionGuardRaw.adverse_velocity_bps_per_sec ??
                process.env.EXECUTION_GUARD_ADVERSE_VELOCITY_BPS_PER_SEC ??
                7
            )
        ),
        good_acceleration_bps_per_sec2: Math.max(
            0.1,
            Number(
                executionGuardRaw.good_acceleration_bps_per_sec2 ??
                process.env.EXECUTION_GUARD_GOOD_ACCELERATION_BPS_PER_SEC2 ??
                1.2
            )
        ),
        adverse_acceleration_bps_per_sec2: -Math.max(
            0.1,
            Number(
                executionGuardRaw.adverse_acceleration_bps_per_sec2 ??
                process.env.EXECUTION_GUARD_ADVERSE_ACCELERATION_BPS_PER_SEC2 ??
                2.4
            )
        ),
        positive_imbalance: Math.max(
            0.01,
            Math.min(
                1,
                Number(
                    executionGuardRaw.positive_imbalance ??
                    process.env.EXECUTION_GUARD_POSITIVE_IMBALANCE ??
                    0.12
                )
            )
        ),
        adverse_imbalance: -Math.max(
            0.01,
            Math.min(
                1,
                Number(executionGuardRaw.adverse_imbalance ?? process.env.EXECUTION_GUARD_ADVERSE_IMBALANCE ?? 0.22)
            )
        ),
        stall_velocity_ceiling_bps_per_sec: Math.max(
            0.1,
            Number(
                executionGuardRaw.stall_velocity_ceiling_bps_per_sec ??
                process.env.EXECUTION_GUARD_STALL_VELOCITY_CEILING_BPS_PER_SEC ??
                0.9
            )
        ),
        deterioration_negative_signals_threshold: Math.max(
            3,
            Math.floor(
                Number(
                    executionGuardRaw.deterioration_negative_signals_threshold ??
                    process.env.EXECUTION_GUARD_DETERIORATION_NEGATIVE_SIGNALS_THRESHOLD ??
                    4
                )
            )
        ),
        invalidation_negative_signals_threshold: Math.max(
            4,
            Math.floor(
                Number(
                    executionGuardRaw.invalidation_negative_signals_threshold ??
                    process.env.EXECUTION_GUARD_INVALIDATION_NEGATIVE_SIGNALS_THRESHOLD ??
                    5
                )
            )
        ),
        stale_snapshot_penalty_points: Math.max(
            0,
            Number(
                executionGuardRaw.stale_snapshot_penalty_points ??
                process.env.EXECUTION_GUARD_STALE_SNAPSHOT_PENALTY_POINTS ??
                10
            )
        ),
        weak_snapshot_penalty_points: Math.max(
            0,
            Number(
                executionGuardRaw.weak_snapshot_penalty_points ??
                process.env.EXECUTION_GUARD_WEAK_SNAPSHOT_PENALTY_POINTS ??
                5
            )
        ),
        medium_high_quality_score: Math.max(
            executionGuardMediumQualityScore,
            Math.min(
                executionGuardHighQualityScore,
                Number(
                    executionGuardRaw.medium_high_quality_score ??
                    process.env.EXECUTION_GUARD_MEDIUM_HIGH_QUALITY_SCORE ??
                    55
                )
            )
        ),
        high_quality_size_factor: Math.max(
            0.2,
            Math.min(
                1,
                Number(
                    executionGuardRaw.high_quality_size_factor ??
                    process.env.EXECUTION_GUARD_HIGH_QUALITY_SIZE_FACTOR ??
                    1
                )
            )
        ),
        medium_high_quality_size_factor: Math.max(
            0.2,
            Math.min(
                1,
                Number(
                    executionGuardRaw.medium_high_quality_size_factor ??
                    process.env.EXECUTION_GUARD_MEDIUM_HIGH_QUALITY_SIZE_FACTOR ??
                    0.7
                )
            )
        ),
        medium_low_quality_size_factor: Math.max(
            0.2,
            Math.min(
                1,
                Number(
                    executionGuardRaw.medium_low_quality_size_factor ??
                    process.env.EXECUTION_GUARD_MEDIUM_LOW_QUALITY_SIZE_FACTOR ??
                    0.4
                )
            )
        )
    };

    const lifecycleRaw = cfg.impulse_lifecycle && typeof cfg.impulse_lifecycle === 'object' ?
        cfg.impulse_lifecycle :
        {};
    const lifecycleMode = normalizeFeatureMode(
        lifecycleRaw.mode ?? lifecycleRaw.enabled ?? process.env.IMPULSE_LIFECYCLE_ENABLED,
        'off'
    );
    cfg.impulse_lifecycle = {
        mode: lifecycleMode,
        enabled: lifecycleMode !== 'off',
        incubation_ms: Math.max(
            60000,
            Number(lifecycleRaw.incubation_ms ?? process.env.IMPULSE_INCUBATION_MS ?? 90000)
        ),
        evaluation_ms: Math.max(
            15000,
            Number(lifecycleRaw.evaluation_ms ?? process.env.IMPULSE_EVALUATION_MS ?? 45000)
        ),
        no_ignition_ms: Math.max(
            3000,
            Number(lifecycleRaw.no_ignition_ms ?? process.env.IMPULSE_NO_IGNITION_MS ?? 15000)
        ),
        no_ignition_min_negative_signals: Math.max(
            2,
            Number(
                lifecycleRaw.no_ignition_min_negative_signals ??
                process.env.IMPULSE_NO_IGNITION_MIN_NEGATIVE_SIGNALS ??
                3
            )
        ),
        no_ignition_velocity_ceiling_bps_per_sec: Math.max(
            0.5,
            Number(
                lifecycleRaw.no_ignition_velocity_ceiling_bps_per_sec ??
                process.env.IMPULSE_NO_IGNITION_VELOCITY_CEILING_BPS_PER_SEC ??
                2
            )
        ),
        no_ignition_required_stall_ratio: Math.max(
            0.3,
            Math.min(
                1.5,
                Number(
                    lifecycleRaw.no_ignition_required_stall_ratio ??
                    process.env.IMPULSE_NO_IGNITION_REQUIRED_STALL_RATIO ??
                    0.75
                )
            )
        ),
        no_ignition_imbalance_ceiling: Number(
            lifecycleRaw.no_ignition_imbalance_ceiling ??
            process.env.IMPULSE_NO_IGNITION_IMBALANCE_CEILING ??
            0.05
        ),
        stall_ms: Math.max(
            5000,
            Number(lifecycleRaw.stall_ms ?? process.env.IMPULSE_STALL_MS ?? 25000)
        ),
        decay_threshold: Math.max(
            0.1,
            Math.min(0.95, Number(lifecycleRaw.decay_threshold ?? process.env.IMPULSE_DECAY_THRESHOLD ?? 0.62))
        ),
        ignition_expansion_pct: Math.max(
            0.01,
            Number(lifecycleRaw.ignition_expansion_pct ?? process.env.IMPULSE_IGNITION_EXPANSION_PCT ?? 0.05)
        ),
        expansion_min_pnl_pct: Math.max(
            0.02,
            Number(lifecycleRaw.expansion_min_pnl_pct ?? process.env.IMPULSE_EXPANSION_MIN_PNL_PCT ?? 0.08)
        ),
        expansion_min_new_extremes: Math.max(
            1,
            Number(lifecycleRaw.expansion_min_new_extremes ?? process.env.IMPULSE_EXPANSION_MIN_NEW_EXTREMES ?? 2)
        ),
        expansion_hold_ms: Math.max(
            30000,
            Number(lifecycleRaw.expansion_hold_ms ?? process.env.IMPULSE_EXPANSION_HOLD_MS ?? 60000)
        ),
        evaluation_positive_velocity_bps_per_sec: Number(
            lifecycleRaw.evaluation_positive_velocity_bps_per_sec ??
            process.env.IMPULSE_EVALUATION_POSITIVE_VELOCITY_BPS_PER_SEC ??
            4
        ),
        evaluation_negative_velocity_bps_per_sec: Number(
            lifecycleRaw.evaluation_negative_velocity_bps_per_sec ??
            process.env.IMPULSE_EVALUATION_NEGATIVE_VELOCITY_BPS_PER_SEC ??
            -4
        ),
        evaluation_positive_imbalance: Number(
            lifecycleRaw.evaluation_positive_imbalance ??
            process.env.IMPULSE_EVALUATION_POSITIVE_IMBALANCE ??
            0.12
        ),
        evaluation_negative_imbalance: Number(
            lifecycleRaw.evaluation_negative_imbalance ??
            process.env.IMPULSE_EVALUATION_NEGATIVE_IMBALANCE ??
            -0.12
        ),
        evaluation_positive_signal_threshold: Math.max(
            1,
            Number(
                lifecycleRaw.evaluation_positive_signal_threshold ??
                process.env.IMPULSE_EVALUATION_POSITIVE_SIGNAL_THRESHOLD ??
                2
            )
        ),
        stall_velocity_bps_per_sec: Number(
            lifecycleRaw.stall_velocity_bps_per_sec ?? process.env.IMPULSE_STALL_VELOCITY_BPS_PER_SEC ?? 6
        ),
        severe_pullback_pct: Math.max(
            0.02,
            Number(lifecycleRaw.severe_pullback_pct ?? process.env.IMPULSE_SEVERE_PULLBACK_PCT ?? 0.18)
        ),
        deterioration_pullback_pct: Math.max(
            0.03,
            Number(
                lifecycleRaw.deterioration_pullback_pct ?? process.env.IMPULSE_DETERIORATION_PULLBACK_PCT ?? 0.12
            )
        ),
        deterioration_negative_signal_threshold: Math.max(
            2,
            Number(
                lifecycleRaw.deterioration_negative_signal_threshold ??
                process.env.IMPULSE_DETERIORATION_NEGATIVE_SIGNAL_THRESHOLD ??
                3
            )
        )
    };

    const adaptiveRaw = cfg.adaptive_exit && typeof cfg.adaptive_exit === 'object' ?
        cfg.adaptive_exit :
        {};
    const adaptiveMode = normalizeFeatureMode(
        adaptiveRaw.mode ?? adaptiveRaw.enabled ?? process.env.ADAPTIVE_EXIT_MODE ?? process.env.ADAPTIVE_EXIT_ENABLED,
        'off'
    );
    cfg.adaptive_exit = {
        mode: adaptiveMode,
        enabled: adaptiveMode !== 'off',
        scope: normalizeFeatureScope(adaptiveRaw.scope ?? process.env.ADAPTIVE_EXIT_SCOPE, 'all'),
        symbols: normalizeFeatureSymbols(adaptiveRaw.symbols ?? process.env.ADAPTIVE_EXIT_SYMBOLS ?.split(',') ?? []),
        min_confidence: Math.max(
            0,
            Math.min(1, Number(adaptiveRaw.min_confidence ?? process.env.ADAPTIVE_EXIT_MIN_CONFIDENCE ?? 0.9))
        ),
        min_profit_lock_pct: Math.max(
            0.02,
            Number(adaptiveRaw.min_profit_lock_pct ?? process.env.ADAPTIVE_EXIT_MIN_PROFIT_LOCK ?? 0.12)
        ),
        incubation_ms: Math.max(
            60000,
            Number(
                adaptiveRaw.incubation_ms ??
                process.env.ADAPTIVE_EXIT_INCUBATION_MS ??
                lifecycleRaw.incubation_ms ??
                process.env.IMPULSE_INCUBATION_MS ??
                90000
            )
        ),
        evaluation_ms: Math.max(
            15000,
            Number(
                adaptiveRaw.evaluation_ms ??
                process.env.ADAPTIVE_EXIT_EVALUATION_MS ??
                lifecycleRaw.evaluation_ms ??
                process.env.IMPULSE_EVALUATION_MS ??
                45000
            )
        ),
        no_ignition_ms: Math.max(
            3000,
            Number(adaptiveRaw.no_ignition_ms ?? process.env.IMPULSE_NO_IGNITION_MS ?? 15000)
        ),
        no_ignition_min_negative_signals: Math.max(
            2,
            Number(
                adaptiveRaw.no_ignition_min_negative_signals ??
                process.env.ADAPTIVE_EXIT_NO_IGNITION_MIN_NEGATIVE_SIGNALS ??
                lifecycleRaw.no_ignition_min_negative_signals ??
                process.env.IMPULSE_NO_IGNITION_MIN_NEGATIVE_SIGNALS ??
                3
            )
        ),
        no_ignition_velocity_ceiling_bps_per_sec: Math.max(
            0.5,
            Number(
                adaptiveRaw.no_ignition_velocity_ceiling_bps_per_sec ??
                process.env.ADAPTIVE_EXIT_NO_IGNITION_VELOCITY_CEILING_BPS_PER_SEC ??
                lifecycleRaw.no_ignition_velocity_ceiling_bps_per_sec ??
                process.env.IMPULSE_NO_IGNITION_VELOCITY_CEILING_BPS_PER_SEC ??
                2
            )
        ),
        no_ignition_required_stall_ratio: Math.max(
            0.3,
            Math.min(
                1.5,
                Number(
                    adaptiveRaw.no_ignition_required_stall_ratio ??
                    process.env.ADAPTIVE_EXIT_NO_IGNITION_REQUIRED_STALL_RATIO ??
                    lifecycleRaw.no_ignition_required_stall_ratio ??
                    process.env.IMPULSE_NO_IGNITION_REQUIRED_STALL_RATIO ??
                    0.75
                )
            )
        ),
        no_ignition_imbalance_ceiling: Number(
            adaptiveRaw.no_ignition_imbalance_ceiling ??
            process.env.ADAPTIVE_EXIT_NO_IGNITION_IMBALANCE_CEILING ??
            lifecycleRaw.no_ignition_imbalance_ceiling ??
            process.env.IMPULSE_NO_IGNITION_IMBALANCE_CEILING ??
            0.05
        ),
        stall_ms: Math.max(
            5000,
            Number(adaptiveRaw.stall_ms ?? process.env.IMPULSE_STALL_MS ?? 25000)
        ),
        stall_confirmation_negative_signals: Math.max(
            2,
            Number(
                adaptiveRaw.stall_confirmation_negative_signals ??
                process.env.ADAPTIVE_EXIT_STALL_CONFIRMATION_NEGATIVE_SIGNALS ??
                3
            )
        ),
        stall_confirmation_window_ms: Math.max(
            5000,
            Number(
                adaptiveRaw.stall_confirmation_window_ms ??
                process.env.ADAPTIVE_EXIT_STALL_CONFIRMATION_WINDOW_MS ??
                10000
            )
        ),
        stall_negative_velocity_bps_per_sec: Number(
            adaptiveRaw.stall_negative_velocity_bps_per_sec ??
            process.env.ADAPTIVE_EXIT_STALL_NEGATIVE_VELOCITY_BPS_PER_SEC ??
            -0.6
        ),
        stall_imbalance_ceiling: Number(
            adaptiveRaw.stall_imbalance_ceiling ??
            process.env.ADAPTIVE_EXIT_STALL_IMBALANCE_CEILING ??
            -0.08
        ),
        stall_pullback_pct: Math.max(
            0.02,
            Number(
                adaptiveRaw.stall_pullback_pct ??
                process.env.ADAPTIVE_EXIT_STALL_PULLBACK_PCT ??
                0.04
            )
        ),
        stall_recent_high_loss_ms: Math.max(
            5000,
            Number(
                adaptiveRaw.stall_recent_high_loss_ms ??
                process.env.ADAPTIVE_EXIT_STALL_RECENT_HIGH_LOSS_MS ??
                10000
            )
        ),
        stall_break_even_floor_pct: Math.max(
            0,
            Number(
                adaptiveRaw.stall_break_even_floor_pct ??
                process.env.ADAPTIVE_EXIT_STALL_BREAK_EVEN_FLOOR_PCT ??
                0.01
            )
        ),
        stall_recovery_velocity_floor_bps_per_sec: Number(
            adaptiveRaw.stall_recovery_velocity_floor_bps_per_sec ??
            process.env.ADAPTIVE_EXIT_STALL_RECOVERY_VELOCITY_FLOOR_BPS_PER_SEC ??
            -0.05
        ),
        stall_recovery_imbalance_floor: Number(
            adaptiveRaw.stall_recovery_imbalance_floor ??
            process.env.ADAPTIVE_EXIT_STALL_RECOVERY_IMBALANCE_FLOOR ??
            -0.02
        ),
        decay_threshold: Math.max(
            0.1,
            Math.min(0.95, Number(adaptiveRaw.decay_threshold ?? process.env.IMPULSE_DECAY_THRESHOLD ?? 0.62))
        ),
        strong_deterioration_score: Math.max(
            0.2,
            Math.min(
                0.99,
                Number(adaptiveRaw.strong_deterioration_score ?? process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_SCORE ?? 0.78)
            )
        ),
        strong_deterioration_negative_velocity_bps_per_sec: Number(
            adaptiveRaw.strong_deterioration_negative_velocity_bps_per_sec ??
            process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_NEGATIVE_VELOCITY_BPS_PER_SEC ??
            -1
        ),
        strong_deterioration_negative_acceleration_bps_per_sec2: Number(
            adaptiveRaw.strong_deterioration_negative_acceleration_bps_per_sec2 ??
            process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_NEGATIVE_ACCELERATION_BPS_PER_SEC2 ??
            0
        ),
        strong_deterioration_pullback_pct: Math.max(
            0.03,
            Number(
                adaptiveRaw.strong_deterioration_pullback_pct ??
                process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_PULLBACK_PCT ??
                0.08
            )
        ),
        strong_deterioration_imbalance_ceiling: Number(
            adaptiveRaw.strong_deterioration_imbalance_ceiling ??
            process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_IMBALANCE_CEILING ??
            -0.05
        ),
        strong_deterioration_min_negative_signals: Math.max(
            2,
            Number(
                adaptiveRaw.strong_deterioration_min_negative_signals ??
                process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_MIN_NEGATIVE_SIGNALS ??
                3
            )
        ),
        strong_deterioration_confirmation_window_ms: Math.max(
            5000,
            Number(
                adaptiveRaw.strong_deterioration_confirmation_window_ms ??
                process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_CONFIRMATION_WINDOW_MS ??
                10000
            )
        ),
        strong_deterioration_min_deterioration_ms: Math.max(
            5000,
            Number(
                adaptiveRaw.strong_deterioration_min_deterioration_ms ??
                process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_MIN_DETERIORATION_MS ??
                8000
            )
        ),
        strong_deterioration_expansion_exception_loss_pct: Number(
            adaptiveRaw.strong_deterioration_expansion_exception_loss_pct ??
            process.env.ADAPTIVE_EXIT_STRONG_DETERIORATION_EXPANSION_EXCEPTION_LOSS_PCT ??
            -0.12
        ),
        invalidation_loss_pct: Number(
            adaptiveRaw.invalidation_loss_pct ?? process.env.ADAPTIVE_EXIT_INVALIDATION_LOSS_PCT ?? -0.85
        ),
        profit_lock_activation_multiplier: Math.max(
            1,
            Math.min(
                3,
                Number(
                    adaptiveRaw.profit_lock_activation_multiplier ??
                    process.env.ADAPTIVE_EXIT_PROFIT_LOCK_ACTIVATION_MULTIPLIER ??
                    1.35
                )
            )
        ),
        profit_lock_floor_ratio: Math.max(
            0.2,
            Math.min(
                0.95,
                Number(adaptiveRaw.profit_lock_floor_ratio ?? process.env.ADAPTIVE_EXIT_PROFIT_LOCK_FLOOR_RATIO ?? 0.55)
            )
        ),
        profit_lock_min_negative_signals: Math.max(
            1,
            Number(
                adaptiveRaw.profit_lock_min_negative_signals ??
                process.env.ADAPTIVE_EXIT_PROFIT_LOCK_MIN_NEGATIVE_SIGNALS ??
                2
            )
        ),
        profit_lock_min_decay_score: Math.max(
            0.1,
            Math.min(
                0.95,
                Number(
                    adaptiveRaw.profit_lock_min_decay_score ??
                    process.env.ADAPTIVE_EXIT_PROFIT_LOCK_MIN_DECAY_SCORE ??
                    0.55
                )
            )
        ),
        profit_lock_min_expansion_age_ms: Math.max(
            15000,
            Number(
                adaptiveRaw.profit_lock_min_expansion_age_ms ??
                process.env.ADAPTIVE_EXIT_PROFIT_LOCK_MIN_EXPANSION_AGE_MS ??
                lifecycleRaw.evaluation_ms ??
                process.env.IMPULSE_EVALUATION_MS ??
                45000
            )
        ),
        trailing_retrace_ratio: Math.max(
            0.2,
            Math.min(0.95, Number(adaptiveRaw.trailing_retrace_ratio ?? process.env.ADAPTIVE_EXIT_TRAILING_RETRACE_RATIO ?? 0.55))
        ),
        trailing_min_mfe_pct: Math.max(
            0.03,
            Number(adaptiveRaw.trailing_min_mfe_pct ?? process.env.ADAPTIVE_EXIT_TRAILING_MIN_MFE_PCT ?? 0.14)
        ),
        enforce_source_profiles: normalizeFeatureSymbols(
            adaptiveRaw.enforce_source_profiles ?? process.env.ADAPTIVE_EXIT_ENFORCE_SOURCE_PROFILES ?.split(',') ?? []
        )
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
        const value = {
            ...normalizeConfig(snap.exists ? snap.data() : null),
            _config_source: snap.exists ? 'binance_bot_config/global' : 'binance_bot_config/defaults'
        };
        cache = { value, loadedAt: now };
        return value;
    } catch (_) {
        const value = {
            ...normalizeConfig(null),
            _config_source: 'binance_bot_config/defaults'
        };
        cache = { value, loadedAt: now };
        return value;
    }
}

module.exports = {
    DEFAULT_CONFIG,
    getBinanceBotConfig
};