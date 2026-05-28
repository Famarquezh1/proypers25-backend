/**
 * HYBRID MODE DIAGNOSTICS ENDPOINT
 * GET /api/diagnostico/hybrid-mode
 * 
 * Returns current hybrid strategy configuration and exposure
 */

const express = require('express');
const router = express.Router();
const db = require('../firebase-admin-config');

/**
 * Get hybrid mode status
 */
router.get('/hybrid-mode', async (req, res) => {
    try {
        // Get main config
        const configDoc = await db.collection('real_spot_config').doc('control').get();
        const moonshotDoc = await db.collection('real_spot_config').doc('moonshot_strategy').get();
        
        if (!configDoc.exists || !moonshotDoc.exists) {
            return res.status(400).json({
                ok: false,
                error: 'HYBRID_CONFIG_NOT_FOUND'
            });
        }
        
        const mainConfig = configDoc.data();
        const moonshotConfig = moonshotDoc.data();
        
        // Get open positions by strategy
        const conservativeOpen = await db.collection('real_spot_positions')
            .where('strategy', '==', 'CONSERVATIVE')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        const moonshotOpen = await db.collection('real_spot_positions')
            .where('strategy', '==', 'MOONSHOT')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        // Calculate exposure
        let conservative_capital_used = 0;
        let moonshot_capital_used = 0;
        const conservative_positions = [];
        const moonshot_positions = [];
        
        conservativeOpen.forEach(doc => {
            const pos = doc.data();
            conservative_capital_used += Number(pos.capital_usdt || 0);
            conservative_positions.push({
                id: doc.id,
                symbol: pos.symbol,
                capital_usdt: pos.capital_usdt,
                entry_price: pos.entry_price,
                targets: {
                    tp1_pct: pos.take_profit_1_pct,
                    tp2_pct: pos.take_profit_2_pct,
                    sl_pct: pos.stop_loss_pct
                }
            });
        });
        
        moonshotOpen.forEach(doc => {
            const pos = doc.data();
            moonshot_capital_used += Number(pos.capital_usdt || 0);
            moonshot_positions.push({
                id: doc.id,
                symbol: pos.symbol,
                capital_usdt: pos.capital_usdt,
                entry_price: pos.entry_price,
                targets: {
                    tp1_pct: pos.take_profit_1_pct,
                    tp2_pct: pos.take_profit_2_pct,
                    tp3_pct: pos.strategy_info?.tp_targets?.[2] || null,
                    sl_pct: pos.stop_loss_pct
                },
                timeout_days: pos.strategy_info?.timeout_hours ? Math.round(pos.strategy_info.timeout_hours / 24) : 1
            });
        });
        
        res.json({
            ok: true,
            mode: mainConfig.strategy_mode || 'HYBRID_70_30',
            enabled: mainConfig.enabled === true,
            
            allocation: {
                total_available_usdt: mainConfig.available_for_trading_usdt || 90,
                conservative_pct: mainConfig.conservative_strategy_pct || 70,
                moonshot_pct: mainConfig.moonshot_strategy_pct || 30,
                conservative_total_usdt: mainConfig.conservative_capital_usdt || 63,
                moonshot_total_usdt: mainConfig.moonshot_capital_usdt || 27
            },
            
            conservative_strategy: {
                capital_available: (mainConfig.conservative_capital_usdt || 63) - conservative_capital_used,
                capital_used: conservative_capital_used,
                capital_limit: mainConfig.conservative_capital_usdt || 63,
                targets: {
                    tp1_pct: mainConfig.take_profit_1_pct || 3,
                    tp2_pct: mainConfig.take_profit_2_pct || 6,
                    sl_pct: mainConfig.stop_loss_pct || -3
                },
                timeout_hours: 24,
                max_position_usdt: 15,
                open_positions_count: conservativeOpen.size,
                open_positions: conservative_positions
            },
            
            moonshot_strategy: {
                enabled: moonshotConfig.enabled === true,
                capital_available: (moonshotConfig.moonshot_capital_usdt || 27) - moonshot_capital_used,
                capital_used: moonshot_capital_used,
                capital_limit: moonshotConfig.moonshot_capital_usdt || 27,
                max_position_usdt: moonshotConfig.max_position_usdt || 4,
                max_open_positions: moonshotConfig.max_open_positions || 3,
                targets: {
                    tp1_pct: moonshotConfig.take_profit_1_pct || 50,
                    tp2_pct: moonshotConfig.take_profit_2_pct || 150,
                    tp3_pct: moonshotConfig.take_profit_3_pct || 500,
                    sl_pct: moonshotConfig.stop_loss_pct || -20
                },
                token_criteria: {
                    min_age_days: moonshotConfig.min_token_age_days,
                    max_age_days: moonshotConfig.max_token_age_days,
                    min_price_usd: moonshotConfig.min_price_usdt,
                    max_price_usd: moonshotConfig.max_price_usdt,
                    min_volume_usdt: moonshotConfig.min_volume_usdt,
                    min_holders: moonshotConfig.min_holders
                },
                timeout_hours: moonshotConfig.timeout_hours || 720,
                timeout_days: Math.round((moonshotConfig.timeout_hours || 720) / 24),
                open_positions_count: moonshotOpen.size,
                open_positions: moonshot_positions
            },
            
            summary: {
                total_capital_exposed: conservative_capital_used + moonshot_capital_used,
                total_available: (mainConfig.conservative_capital_usdt || 63) + (moonshotConfig.moonshot_capital_usdt || 27),
                total_open_positions: conservativeOpen.size + moonshotOpen.size,
                conservative_positions: conservativeOpen.size,
                moonshot_positions: moonshotOpen.size
            },
            
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[HYBRID_DIAG] Error:', error.message);
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

module.exports = router;
