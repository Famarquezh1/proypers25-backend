const db = require('./firebase-admin-config.js');

/**
 * UTILIDADES FORENSES - Herramientas para auditar decisiones de ejecución
 *
 * Uso:
 * - Extraer información sobre POR QUÉ se ejecutó cada trade
 * - Validar consistencia de decisiones
 * - Reconstruir config histórica
 * - Comparar snapshot vs resultados
 */

// =================================================================
// QUERY 1: Obtener todos los snapshots disponibles
// =================================================================

async function getAllExecutionSnapshots() {
    console.log('\n[FORENSIC] Obteniendo todos los execution_decision_snapshots...\n');

    const positionsSnap = await db.collection('real_spot_positions')
        .where('execution_decision_snapshot', '!=', null)
        .get();

    const snapshots = [];
    positionsSnap.forEach(doc => {
        const pos = doc.data();
        snapshots.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: pos.status,
            opened_at: pos.opened_at,
            snapshot: pos.execution_decision_snapshot
        });
    });

    console.log(`Encontrados ${snapshots.length} snapshots\n`);
    return snapshots;
}

// =================================================================
// QUERY 2: Analizar por símbolo
// =================================================================

async function analyzeSymbol(symbol) {
    console.log(`\n[FORENSIC] Análisis de decisiones para ${symbol}\n`);

    const positionsSnap = await db.collection('real_spot_positions')
        .where('symbol', '==', symbol)
        .get();

    const positions = [];
    positionsSnap.forEach(doc => {
        positions.push({
            id: doc.id,
            ...doc.data()
        });
    });

    console.log(`Total trades de ${symbol}: ${positions.length}\n`);

    positions.forEach((pos, idx) => {
        console.log(`Trade ${idx + 1}:`);
        console.log(`  Status: ${pos.status}`);
        console.log(`  Opened: ${pos.opened_at || 'N/A'}`);

        if (pos.execution_decision_snapshot) {
            const snap = pos.execution_decision_snapshot;
            console.log(`  ✓ Snapshot presente`);
            console.log(`    Score: ${snap.score_at_execution} (required: ${snap.min_score_required})`);
            console.log(`    Category: ${snap.category_at_execution}`);
            console.log(`    Passed score? ${snap.passed_score_filter}`);
            console.log(`    Passed category? ${snap.passed_category_filter}`);
            console.log(`    Reason: ${snap.validation_reason}`);
        } else {
            console.log(`  ❌ Snapshot no presente (trade anterior a implementación)`);
        }
        console.log('');
    });

    return positions;
}

// =================================================================
// QUERY 3: Validar consistencia
// =================================================================

async function validateConsistency() {
    console.log('\n[FORENSIC] Validando consistencia de decisiones\n');

    const positionsSnap = await db.collection('real_spot_positions')
        .where('execution_decision_snapshot', '!=', null)
        .get();

    let consistencyIssues = [];

    positionsSnap.forEach(doc => {
        const pos = doc.data();
        const snap = pos.execution_decision_snapshot;

        // VALIDACIÓN 1: Score pasó pero dice que no
        if (snap.score_at_execution >= snap.min_score_required && !snap.passed_score_filter) {
            consistencyIssues.push({
                symbol: pos.symbol,
                issue: `Score check inconsistency: ${snap.score_at_execution} >= ${snap.min_score_required} pero passed_score_filter=false`,
                severity: 'WARNING'
            });
        }

        // VALIDACIÓN 2: Category pasó pero dice que no
        if (snap.allowed_categories_at_execution.includes(snap.category_at_execution) && !snap.passed_category_filter) {
            consistencyIssues.push({
                symbol: pos.symbol,
                issue: `Category check inconsistency: ${snap.category_at_execution} in allowed pero passed_category_filter=false`,
                severity: 'WARNING'
            });
        }

        // VALIDACIÓN 3: Config parece desactualizada
        if (!snap.config_updated_at) {
            consistencyIssues.push({
                symbol: pos.symbol,
                issue: `Config timestamp missing`,
                severity: 'INFO'
            });
        }
    });

    if (consistencyIssues.length === 0) {
        console.log('✅ Todas las decisiones son consistentes\n');
    } else {
        console.log(`⚠️  ${consistencyIssues.length} inconsistencias encontradas:\n`);
        consistencyIssues.forEach(issue => {
            console.log(`[${issue.severity}] ${issue.symbol}`);
            console.log(`  ${issue.issue}\n`);
        });
    }

    return consistencyIssues;
}

// =================================================================
// QUERY 4: Comparar snapshot vs resultados
// =================================================================

async function compareSnapshotVsResult() {
    console.log('\n[FORENSIC] Comparando decisión vs resultado final\n');

    const closedSnap = await db.collection('real_spot_positions')
        .where('status', '==', 'REAL_CLOSED')
        .where('execution_decision_snapshot', '!=', null)
        .get();

    const comparisons = [];

    closedSnap.forEach(doc => {
        const pos = doc.data();
        const snap = pos.execution_decision_snapshot;

        comparisons.push({
            symbol: pos.symbol,
            decision: {
                score: snap.score_at_execution,
                threshold: snap.min_score_required,
                passed: snap.passed_score_filter
            },
            result: {
                pnl_usdt: pos.final_pnl_usdt || pos.profit_loss?.final_pnl_usdt,
                pnl_pct: pos.final_pnl_pct || pos.profit_loss?.final_pnl_pct,
                duration_hours: (new Date(pos.closed_at) - new Date(pos.opened_at)) / (1000 * 60 * 60),
                close_reason: pos.close_reason
            }
        });
    });

    console.log(`Trades cerrados con snapshot: ${comparisons.length}\n`);

    // Análisis de ganadores vs perdedores
    const winners = comparisons.filter(c => c.result.pnl_usdt > 0);
    const losers = comparisons.filter(c => c.result.pnl_usdt <= 0);

    console.log(`Winners: ${winners.length}`);
    console.log(`Losers: ${losers.length}`);

    if (winners.length > 0) {
        const avgWinnerScore = winners.reduce((sum, w) => sum + w.decision.score, 0) / winners.length;
        console.log(`  Avg score en ganadores: ${avgWinnerScore.toFixed(2)}`);
    }

    if (losers.length > 0) {
        const avgLoserScore = losers.reduce((sum, l) => sum + l.decision.score, 0) / losers.length;
        console.log(`  Avg score en perdedores: ${avgLoserScore.toFixed(2)}`);
    }

    console.log('\nDetalle:\n');
    comparisons.forEach(comp => {
        console.log(`${comp.symbol}:`);
        console.log(`  Decision: Score ${comp.decision.score} (threshold ${comp.decision.threshold})`);
        console.log(`  Result: ${comp.result.pnl_usdt > 0 ? '+' : ''}${(comp.result.pnl_usdt || 0).toFixed(2)} USDT (${(comp.result.pnl_pct || 0).toFixed(2)}%)`);
        console.log(`  Duration: ${(comp.result.duration_hours || 0).toFixed(1)} hours`);
        console.log(`  Closed: ${comp.result.close_reason}`);
        console.log('');
    });

    return comparisons;
}

// =================================================================
// QUERY 5: Extraer patrón de decisiones
// =================================================================

async function extractDecisionPattern() {
    console.log('\n[FORENSIC] Extrayendo patrón de decisiones\n');

    const allSnap = await db.collection('real_spot_positions')
        .where('execution_decision_snapshot', '!=', null)
        .get();

    const patterns = {
        by_score: {},
        by_category: {},
        by_strategy: {},
        by_forced: { true: 0, false: 0 }
    };

    allSnap.forEach(doc => {
        const snap = doc.data().execution_decision_snapshot;

        // Agrupar por score
        const scoreRange = Math.floor(snap.score_at_execution / 10) * 10;
        patterns.by_score[scoreRange] = (patterns.by_score[scoreRange] || 0) + 1;

        // Agrupar por categoría
        patterns.by_category[snap.category_at_execution] = (patterns.by_category[snap.category_at_execution] || 0) + 1;

        // Agrupar por estrategia
        patterns.by_strategy[snap.strategy_mode] = (patterns.by_strategy[snap.strategy_mode] || 0) + 1;

        // Contar forced
        patterns.by_forced[snap.is_forced.toString()]++;
    });

    console.log('Ejecuciones por rango de score:\n');
    Object.entries(patterns.by_score).sort().forEach(([range, count]) => {
        console.log(`  ${range}-${parseInt(range) + 10}: ${count}`);
    });

    console.log('\nEjecuciones por categoría:\n');
    Object.entries(patterns.by_category).forEach(([cat, count]) => {
        console.log(`  ${cat}: ${count}`);
    });

    console.log('\nEjecuciones por estrategia:\n');
    Object.entries(patterns.by_strategy).forEach(([strat, count]) => {
        console.log(`  ${strat}: ${count}`);
    });

    console.log('\nEjecuciones forzadas:\n');
    console.log(`  Automática: ${patterns.by_forced.false}`);
    console.log(`  Forzada: ${patterns.by_forced.true}`);

    console.log('');
    return patterns;
}

// =================================================================
// MAIN: Menú de utilidades
// =================================================================

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    try {
        switch (command) {
            case 'all':
                await getAllExecutionSnapshots();
                break;

            case 'analyze':
                const symbol = args[1];
                if (!symbol) {
                    console.log('Uso: node forensic_utils.js analyze SYMBOL');
                    process.exit(1);
                }
                await analyzeSymbol(symbol);
                break;

            case 'validate':
                await validateConsistency();
                break;

            case 'compare':
                await compareSnapshotVsResult();
                break;

            case 'pattern':
                await extractDecisionPattern();
                break;

            default:
                console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║  UTILIDADES FORENSES - execution_decision_snapshot              ║
║                                                                  ║
║  Uso:                                                            ║
║    node forensic_utils.js [comando] [args]                     ║
║                                                                  ║
║  Comandos:                                                       ║
║    all      - Obtener todos los snapshots disponibles           ║
║    analyze SYMBOL - Análisis detallado de un símbolo            ║
║    validate - Validar consistencia de decisiones                ║
║    compare - Comparar decisión vs resultado                     ║
║    pattern - Extraer patrón de decisiones                       ║
║                                                                  ║
║  Ejemplos:                                                       ║
║    node forensic_utils.js all                                   ║
║    node forensic_utils.js analyze ANKRUSDT                      ║
║    node forensic_utils.js validate                              ║
║    node forensic_utils.js compare                               ║
║    node forensic_utils.js pattern                               ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
        `);
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

main();

// Exportar para uso desde otros scripts
module.exports = {
    getAllExecutionSnapshots,
    analyzeSymbol,
    validateConsistency,
    compareSnapshotVsResult,
    extractDecisionPattern
};
