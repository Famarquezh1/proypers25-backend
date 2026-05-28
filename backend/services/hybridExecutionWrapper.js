/**
 * HYBRID EXECUTION WRAPPER
 * 
 * Implementa Opción C: 70% Conservative + 30% Moonshot
 * Controla la asignación de capital y targets según estrategia
 */

const admin = require('firebase-admin');
const db = admin.firestore();

/**
 * Determine strategy type based on candidate and hybrid config
 */
async function determineStrategy(candidate, config) {
    try {
        // Get hybrid config
        const moonshotDoc = await db.collection('real_spot_config').doc('moonshot_strategy').get();
        
        if (!moonshotDoc.exists) {
            return {
                strategy: 'CONSERVATIVE',
                reason: 'MOONSHOT_CONFIG_NOT_FOUND'
            };
        }
        
        const moonshotConfig = moonshotDoc.data();
        
        // Check if candidate is moonshot eligible
        const isMoonshotEligible = await isMoonshotCandidate(candidate, moonshotConfig);
        
        if (isMoonshotEligible) {
            // Check if we have capital for moonshot
            const exposure = await getHybridCapitalExposure();
            
            if (exposure.moonshot_used < (moonshotConfig.moonshot_capital_usdt || 27)) {
                return {
                    strategy: 'MOONSHOT',
                    reason: 'ELIGIBLE_AND_CAPITAL_AVAILABLE',
                    config: moonshotConfig
                };
            }
        }
        
        // Default to conservative
        return {
            strategy: 'CONSERVATIVE',
            reason: isMoonshotEligible ? 'MOONSHOT_CAPITAL_EXHAUSTED' : 'NOT_MOONSHOT_ELIGIBLE'
        };
        
    } catch (error) {
        console.error('[HYBRID] Error determining strategy:', error.message);
        return {
            strategy: 'CONSERVATIVE',
            reason: 'DETERMINATION_ERROR',
            error: error.message
        };
    }
}

/**
 * Check if candidate matches moonshot criteria
 */
async function isMoonshotCandidate(candidate, moonshotConfig) {
    try {
        // Token age check (0.25 - 7 days)
        if (candidate.token_age_days) {
            if (candidate.token_age_days < moonshotConfig.min_token_age_days ||
                candidate.token_age_days > moonshotConfig.max_token_age_days) {
                return false;
            }
        }
        
        // Price range (0.00001 - 0.1 USDT)
        if (candidate.current_price) {
            const price = Number(candidate.current_price);
            if (price < moonshotConfig.min_price_usdt ||
                price > moonshotConfig.max_price_usdt) {
                return false;
            }
        }
        
        // Volume check
        if (candidate.volume_24h_usdt) {
            const vol = Number(candidate.volume_24h_usdt);
            if (vol < moonshotConfig.min_volume_usdt ||
                vol > moonshotConfig.min_volume_usdt * 100) { // cap at 100x min vol
                return false;
            }
        }
        
        // Marker: has moonshot_eligible flag (from scanner)
        if (candidate.moonshot_eligible === false) {
            return false;
        }
        
        return true;
        
    } catch (error) {
        console.warn('[HYBRID] Error checking moonshot eligibility:', error.message);
        return false;
    }
}

/**
 * Get current capital exposure across both strategies
 */
async function getHybridCapitalExposure() {
    try {
        // Get conservative exposure (real_spot_positions with strategy='CONSERVATIVE')
        const conservativeOpen = await db.collection('real_spot_positions')
            .where('strategy', '==', 'CONSERVATIVE')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        let conservative_used = 0;
        conservativeOpen.forEach(doc => {
            conservative_used += Number(doc.data().capital_usdt || 0);
        });
        
        // Get moonshot exposure (real_spot_positions with strategy='MOONSHOT')
        const moonshotOpen = await db.collection('real_spot_positions')
            .where('strategy', '==', 'MOONSHOT')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        let moonshot_used = 0;
        moonshotOpen.forEach(doc => {
            moonshot_used += Number(doc.data().capital_usdt || 0);
        });
        
        return {
            conservative_used,
            moonshot_used,
            total: conservative_used + moonshot_used
        };
        
    } catch (error) {
        console.error('[HYBRID] Error calculating exposure:', error.message);
        return {
            conservative_used: 0,
            moonshot_used: 0,
            total: 0
        };
    }
}

/**
 * Wrap execution cycle with hybrid strategy logic
 */
async function runHybridExecutionCycle(db, candidate, baseConfig, options = {}) {
    const cycleStart = Date.now();
    
    console.log('[HYBRID] Starting hybrid execution cycle...');
    
    // Determine strategy
    const strategyDecision = await determineStrategy(candidate, baseConfig);
    console.log('[HYBRID] Strategy decided:', strategyDecision.strategy, '-', strategyDecision.reason);
    
    // Prepare config based on strategy
    let executionConfig = { ...baseConfig };
    let strategyMetadata = {
        strategy: strategyDecision.strategy,
        decision_reason: strategyDecision.reason,
        determined_at: new Date().toISOString()
    };
    
    if (strategyDecision.strategy === 'MOONSHOT') {
        const moonshotCfg = strategyDecision.config;
        
        // Use moonshot capital and targets
        executionConfig.max_position_usdt = moonshotCfg.max_position_usdt || 4;
        executionConfig.stop_loss_pct = moonshotCfg.stop_loss_pct || -20;
        executionConfig.take_profit_1_pct = moonshotCfg.take_profit_1_pct || 50;
        executionConfig.take_profit_2_pct = moonshotCfg.take_profit_2_pct || 150;
        executionConfig.take_profit_3_pct = moonshotCfg.take_profit_3_pct || 500;
        executionConfig.timeout_hours = moonshotCfg.timeout_hours || 720;
        
        // Store strategy info
        strategyMetadata.capital_allocated = executionConfig.max_position_usdt;
        strategyMetadata.tp_targets = [50, 150, 500];
        strategyMetadata.sl_target = -20;
        strategyMetadata.timeout_hours = 720;
        strategyMetadata.partial_exit = true;
        
        console.log('[HYBRID] Using MOONSHOT config: TP=%/', moonshotCfg.take_profit_1_pct, '/', moonshotCfg.take_profit_2_pct, '/', moonshotCfg.take_profit_3_pct, ' SL=', moonshotCfg.stop_loss_pct, '%');
        
    } else {
        // CONSERVATIVE strategy
        const conservativeCfg = baseConfig;
        
        executionConfig.max_position_usdt = Math.min(conservativeCfg.max_position_usdt || 15, 15); // cap at 15 for conservative
        executionConfig.stop_loss_pct = conservativeCfg.stop_loss_pct || -3;
        executionConfig.take_profit_1_pct = conservativeCfg.take_profit_1_pct || 3;
        executionConfig.take_profit_2_pct = conservativeCfg.take_profit_2_pct || 6;
        executionConfig.timeout_hours = 24; // 24h timeout for conservative
        
        // Store strategy info
        strategyMetadata.capital_allocated = executionConfig.max_position_usdt;
        strategyMetadata.tp_targets = [3, 6];
        strategyMetadata.sl_target = -3;
        strategyMetadata.timeout_hours = 24;
        strategyMetadata.partial_exit = false;
        
        console.log('[HYBRID] Using CONSERVATIVE config: TP=%/', conservativeCfg.take_profit_1_pct, '/', conservativeCfg.take_profit_2_pct, ' SL=', conservativeCfg.stop_loss_pct, '%');
    }
    
    // Inject strategy metadata into options
    const hybridOptions = {
        ...options,
        strategy_metadata: strategyMetadata
    };
    
    return {
        strategy: strategyDecision.strategy,
        config: executionConfig,
        options: hybridOptions,
        metadata: strategyMetadata,
        duration_ms: Date.now() - cycleStart
    };
}

/**
 * Enhance position document with strategy info
 */
function enrichPositionWithStrategy(positionDoc, strategyMetadata) {
    return {
        ...positionDoc,
        strategy: strategyMetadata.strategy,
        strategy_info: {
            decision_reason: strategyMetadata.decision_reason,
            tp_targets: strategyMetadata.tp_targets,
            sl_target: strategyMetadata.sl_target,
            timeout_hours: strategyMetadata.timeout_hours,
            partial_exit: strategyMetadata.partial_exit
        }
    };
}

module.exports = {
    determineStrategy,
    isMoonshotCandidate,
    getHybridCapitalExposure,
    runHybridExecutionCycle,
    enrichPositionWithStrategy
};
