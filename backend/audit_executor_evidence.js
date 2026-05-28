const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FORENSE 3: EVIDENCIA GUARDADA POR EXECUTOR
 *
 * Verifica si las posiciones tienen "execution_decision_snapshot" o campo similar
 * que pruebe qué thresholds fueron evaluados al momento de ejecución
 */

async function auditExecutorEvidence() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 AUDITORÍA 3: EVIDENCIA GUARDADA POR EXECUTOR');
        console.log('='.repeat(80) + '\n');

        // =====================================
        // PASO 1: Obtener todas las positions
        // =====================================
        console.log('PASO 1: Analizando campos guardados en cada position\n');

        const positionsSnap = await db.collection('real_spot_positions').get();
        const positions = [];
        positionsSnap.forEach(doc => {
            positions.push({
                id: doc.id,
                ...doc.data()
            });
        });

        console.log(`Total positions: ${positions.length}\n`);

        // =====================================
        // PASO 2: Analizar estructura de cada position
        // =====================================
        console.log('PASO 2: Estructura de datos de cada position\n');

        const allKeys = new Set();
        positions.forEach(pos => {
            Object.keys(pos).forEach(k => allKeys.add(k));
        });

        console.log('Campos encontrados en positions:\n');
        const sortedKeys = Array.from(allKeys).sort();
        sortedKeys.forEach(key => {
            const values = positions
                .map(p => p[key])
                .filter(v => v !== undefined)
                .map(v => {
                    if (typeof v === 'object') return JSON.stringify(v).substring(0, 50);
                    return String(v).substring(0, 50);
                });

            const uniqueCount = new Set(values).size;
            const filledCount = positions.filter(p => p[key] !== undefined).length;

            console.log(`  ${key}`);
            console.log(`    Presente en: ${filledCount}/${positions.length} positions`);
            if (uniqueCount <= 3) {
                console.log(`    Valores: ${Array.from(new Set(values)).join(', ')}`);
            }
        });

        // =====================================
        // PASO 3: Campos que DEBERÍAN existir
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('PASO 3: Verificación de evidencia necesaria\n');

        const requiredEvidenceFields = [
            'execution_decision_snapshot',
            'decision_snapshot',
            'score_at_execution',
            'threshold_at_execution',
            'config_snapshot',
            'validation_reason',
            'source',
            'is_forced',
            'by_intent'
        ];

        console.log('Campos que probarían decisión de ejecución:\n');

        requiredEvidenceFields.forEach(field => {
            const positionsWithField = positions.filter(p => p[field] !== undefined).length;
            const status = positionsWithField > 0 ? '✓' : '❌';
            console.log(`  ${status} ${field}: ${positionsWithField}/${positions.length} positions`);

            if (positionsWithField > 0) {
                const example = positions.find(p => p[field] !== undefined);
                console.log(`     Ejemplo: ${JSON.stringify(example[field]).substring(0, 100)}`);
            }
        });

        // =====================================
        // PASO 4: Análisis detallado de cada anomalía
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('PASO 4: Análisis de trades anómalos\n');

        const anomalies = [
            { symbol: 'XECUSDT', expectedScore: 27.98, expectedCategory: 'WATCHLIST' },
            { symbol: 'CATIUSDT', expectedScore: 62.48, expectedCategory: 'NEW_OR_LOW_PRICE' }
        ];

        anomalies.forEach(anomaly => {
            console.log(`\n${anomaly.symbol} (Score: ${anomaly.expectedScore}, Category: ${anomaly.expectedCategory})`);
            console.log('-'.repeat(60));

            const position = positions.find(p => p.symbol === anomaly.symbol);
            if (!position) {
                console.log('  ❌ Position no encontrada');
                return;
            }

            console.log(`  Status: ${position.status}`);
            console.log(`  Opened at: ${position.opened_at}`);
            console.log(`  Intent ID: ${position.intent_id || 'N/A'}`);

            // Campos de evidencia
            console.log('\n  Evidencia de decisión:');
            if (position.execution_decision_snapshot) {
                console.log(`    ✓ execution_decision_snapshot:\n      ${JSON.stringify(position.execution_decision_snapshot, null, 2).substring(0, 200)}`);
            } else {
                console.log('    ❌ execution_decision_snapshot: NO EXISTE');
            }

            if (position.score_at_execution) {
                console.log(`    ✓ score_at_execution: ${position.score_at_execution}`);
            } else {
                console.log('    ❌ score_at_execution: NO EXISTE');
            }

            if (position.threshold_at_execution) {
                console.log(`    ✓ threshold_at_execution: ${position.threshold_at_execution}`);
            } else {
                console.log('    ❌ threshold_at_execution: NO EXISTE');
            }

            if (position.validation_reason) {
                console.log(`    ✓ validation_reason: ${position.validation_reason}`);
            } else {
                console.log('    ❌ validation_reason: NO EXISTE');
            }

            if (position.source) {
                console.log(`    ✓ source: ${position.source}`);
            } else {
                console.log('    ❌ source: NO EXISTE');
            }

            console.log('\n  Conclusión: Insuficiente evidencia para probar cómo fue la decisión');
        });

        // =====================================
        // PASO 5: Propuesta de schema
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('PASO 5: Propuesta de Ejecución Decision Snapshot\n');

        console.log(`Estructura sugerida para guardar en cada position:

execution_decision_snapshot: {
  score_at_execution: 27.98,              // Score leído del candidato
  threshold_at_execution: 70,             // min_opportunity_score al ejecutar
  category_at_execution: "WATCHLIST",     // Category del candidato
  allowed_categories_at_execution: ["BREAKOUT", "MOMENTUM", "ACCUMULATION"],

  score_passed: false,                    // false si score < threshold
  category_passed: true,                  // false si category no en allowed
  capital_passed: true,                   // false si capital insuficiente
  validation_passed: false,               // AND(score, category, capital)

  reason: "Score 27.98 < threshold 70",   // Por qué se ejecutó/rechazó
  source: "binanceSpotRealExecutor",      // Módulo que decidió
  is_forced: false,                       // Manual override?
  is_by_intent: true,                     // Vino de intent o directo?
  intent_id: "real_spot_intent_xxx",      // Si aplica

  decision_timestamp: "2026-05-11T15:50:17Z",
  decided_by: "system",                   // system, manual, intent, etc.
  config_id: "real_spot_config/control"   // Qué config se usó
}`);

        // =====================================
        // CONCLUSIÓN PARCIAL
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('CONCLUSIÓN PARCIAL - EVIDENCIA');
        console.log('='.repeat(80) + '\n');

        const hasSufficientEvidence = requiredEvidenceFields.some(field =>
            positions.some(p => p[field] !== undefined)
        );

        if (hasSufficientEvidence) {
            console.log('✓ El executor SÍ guarda evidencia de decisión');
        } else {
            console.log('🔴 El executor NO guarda execution_decision_snapshot');
            console.log('   → CONSECUENCIA: No se puede rastrear por qué cada trade fue ejecutado');
            console.log('   → RECOMENDACIÓN: Agregar execution_decision_snapshot obligatorio');
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

auditExecutorEvidence();
