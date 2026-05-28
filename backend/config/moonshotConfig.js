/**
 * Moonshot Strategy Configuration
 * Aggressive strategy for newly listed tokens with high growth potential
 * Risk: HIGH | Reward: VERY HIGH
 */

const MOONSHOT_CONFIG = {
    // === STRATEGY ENABLED ===
    enabled: true,
    strategy_name: 'MOONSHOT_30PCT',
    
    // === CAPITAL ALLOCATION ===
    moonshot_capital_pct: 30, // 30% of total capital for moonshots
    conservative_capital_pct: 70, // 70% for standard strategy
    
    // === TOKEN SELECTION CRITERIA ===
    // Target newly listed tokens with potential exponential growth
    min_token_age_days: 0.25, // Tokens listed in last 6 hours
    max_token_age_days: 7, // Up to 7 days old (sweet spot for growth)
    min_price_usdt: 0.0000001, // Very small prices (high volatility)
    max_price_usdt: 0.1, // Under 10 cents (high growth potential)
    min_volume_usdt: 500000, // At least $500k volume (liquidity check)
    max_volume_usdt: 50000000, // Not too massive (room to grow)
    min_holders: 100, // Minimum holders (not a honeypot)
    max_single_holder_pct: 15, // No single wallet > 15%
    
    // === TRADING TARGETS (AGGRESSIVE) ===
    take_profit_1_pct: 50, // TP1 at +50% (take 25% position)
    take_profit_2_pct: 150, // TP2 at +150% (take another 25%)
    take_profit_3_pct: 500, // TP3 at +500% (let it run)
    stop_loss_pct: -20, // Hard SL at -20% (cut losses quick on dead tokens)
    
    // === RISK MANAGEMENT ===
    max_position_usdt: 4, // 4 USDT per moonshot (with 12 USDT total = max 3 positions)
    max_open_moonshots: 3, // Max 3 simultaneous moonshot positions
    timeout_hours: 720, // 30 days max per position (let moonshots cook)
    
    // === FILTERING & SAFETY ===
    require_contract_verified: false, // Many new tokens aren't verified yet
    require_realistic_name: true, // Filter out obvious scams
    filter_known_rug_pulls: true, // Avoid tokens with rug pull patterns
    min_market_cap_usdt: 50000, // At least $50k market cap (avoids micro rugs)
    
    // === REBALANCING ===
    check_interval_minutes: 60, // Check for new tokens every hour
    
    metadata: {
        description: 'High-risk, high-reward strategy for newly listed tokens',
        expected_win_rate_pct: 15, // ~15% win rate (1 in 6-7 hits)
        expected_avg_gain_pct: 200, // When it wins, average 200%+ gain
        expected_loss_pct: 20, // When it loses, lose ~20% (SL)
    }
};

module.exports = MOONSHOT_CONFIG;
