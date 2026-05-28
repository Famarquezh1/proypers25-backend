const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FASE 4: DETECCIÓN DE TIMING DE ENTRADA
 * Analiza si las entradas ocurren:
 * - ANTES del impulso (entrada temprana válida)
 * - DURANTE el impulso (entrada correcta)
 * - DESPUÉS del impulso agotado (entrada tardía / falso positivo)
 */

async function detectEntryTiming() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('⏰ AUDITORÍA FASE 4: DETECCIÓN DE TIMING DE ENTRADA');
        console.log('='.repeat(80));

        // Obtener todos los trades cerrados
        const closedSnapshot = await db.collection('real_spot_positions')
            .where('status', '==', 'CLOSED')
            .get();

        const closedTrades = [];
        closedSnapshot.forEach(doc => {
            closedTrades.push({ id: doc.id, ...doc.data() });
        });

        if (closedTrades.length === 0) {
            console.log('\n⚠️ No hay trades cerrados para analizar');
            return;
        }

        console.log(`\n📊 ANÁLISIS DE TIMING DE ENTRADA (${closedTrades.length} trades):\n`);

        // Clasificar entrada por relación entre entry y max adverse/favorable
        let classification = {
            early_valid: 0, // Entró bajo, después el precio subió
            correct_timing: 0, // Entró en impulso activo
            late_entry: 0, // Entró después del pico, bajó después
            false_positive: 0, // Entró en falso breakout
            breakout_entry: 0 // Entró en breakout pero con variabilidad
        };

        let detailedAnalysis = [];

        closedTrades.forEach(trade => {
            const {
                symbol,
                entry_price,
                closed_price,
                capital_usdt,
                pnl,
                opened_at,
                closed_at,
                tp_targets,
                sl_target
            } = trade;

            const roi = ((pnl || 0) / capital_usdt) * 100;
            const entryToExit = ((closed_price - entry_price) / entry_price) * 100;

            // Lógica de clasificación
            let timingClass = 'unknown';
            let reasoning = '';

            if (pnl > 0) {
                // Trade ganador
                if (roi > 20) {
                    timingClass = 'early_valid';
                    reasoning = 'Ganancia fuerte → entrada temprana en impulso';
                } else if (roi > 3) {
                    timingClass = 'correct_timing';
                    reasoning = 'Ganancia moderada → timing correcto';
                } else {
                    timingClass = 'breakout_entry';
                    reasoning = 'Ganancia pequeña → quizás breakout débil';
                }
            } else {
                // Trade perdedor
                if (roi < -15) {
                    timingClass = 'false_positive';
                    reasoning = 'Pérdida fuerte → falso positivo, entered at peak';
                } else if (roi < -3) {
                    timingClass = 'late_entry';
                    reasoning = 'Pérdida moderada → entrada tardía';
                } else {
                    timingClass = 'correct_timing';
                    reasoning = 'Loss pequeña → detrás de SL justo, timing OK';
                }
            }

            classification[timingClass]++;

            detailedAnalysis.push({
                symbol,
                entryPrice: entry_price,
                exitPrice: closed_price,
                pnlPct: roi,
                timingClass,
                reasoning
            });
        });

        // Print detailed trades by timing class
        console.log('📍 ENTRADAS TEMPRANAS VÁLIDAS (early_valid):');
        const earlyValid = detailedAnalysis.filter(t => t.timingClass === 'early_valid');
        if (earlyValid.length > 0) {
            earlyValid.forEach(t => {
                console.log(`  ${t.symbol}: +${t.pnlPct.toFixed(2)}% | Entry: ${t.entryPrice.toFixed(8)}`);
            });
        } else {
            console.log(`  (ninguna)`);
        }

        console.log('\n📍 TIMING CORRECTO:');
        const correctTiming = detailedAnalysis.filter(t => t.timingClass === 'correct_timing');
        if (correctTiming.length > 0) {
            correctTiming.forEach(t => {
                console.log(`  ${t.symbol}: ${t.pnlPct > 0 ? '+' : ''}${t.pnlPct.toFixed(2)}% | Entry: ${t.entryPrice.toFixed(8)}`);
            });
        } else {
            console.log(`  (ninguna)`);
        }

        console.log('\n📍 ENTRADAS TARDÍAS (late_entry):');
        const lateEntry = detailedAnalysis.filter(t => t.timingClass === 'late_entry');
        if (lateEntry.length > 0) {
            lateEntry.forEach(t => {
                console.log(`  ${t.symbol}: ${t.pnlPct.toFixed(2)}% | Entry: ${t.entryPrice.toFixed(8)}`);
            });
        } else {
            console.log(`  (ninguna)`);
        }

        console.log('\n📍 FALSOS POSITIVOS (false_positive):');
        const falsePositive = detailedAnalysis.filter(t => t.timingClass === 'false_positive');
        if (falsePositive.length > 0) {
            falsePositive.forEach(t => {
                console.log(`  ${t.symbol}: ${t.pnlPct.toFixed(2)}% | Entry: ${t.entryPrice.toFixed(8)}`);
            });
        } else {
            console.log(`  (ninguna)`);
        }

        // Resumen de clasificación
        console.log(`\n📊 RESUMEN DE TIMING:`);
        console.log(`  Entradas tempranas válidas: ${classification.early_valid} (${(classification.early_valid / closedTrades.length * 100).toFixed(1)}%)`);
        console.log(`  Timing correcto: ${classification.correct_timing} (${(classification.correct_timing / closedTrades.length * 100).toFixed(1)}%)`);
        console.log(`  Entradas tardías: ${classification.late_entry} (${(classification.late_entry / closedTrades.length * 100).toFixed(1)}%)`);
        console.log(`  Falsos positivos: ${classification.false_positive} (${(classification.false_positive / closedTrades.length * 100).toFixed(1)}%)`);
        console.log(`  Breakout entries: ${classification.breakout_entry} (${(classification.breakout_entry / closedTrades.length * 100).toFixed(1)}%)`);

        // Estadística de rendimiento por clase
        console.log(`\n💰 RENDIMIENTO POR CLASE DE TIMING:`);

        const byClass = {};
        detailedAnalysis.forEach(t => {
            if (!byClass[t.timingClass]) {
                byClass[t.timingClass] = { pnls: [], count: 0 };
            }
            byClass[t.timingClass].pnls.push(t.pnlPct);
            byClass[t.timingClass].count++;
        });

        Object.keys(byClass).forEach(className => {
            const data = byClass[className];
            const avgROI = data.pnls.reduce((a, b) => a + b) / data.pnls.length;
            const wins = data.pnls.filter(p => p > 0).length;
            console.log(`  ${className}: Avg ROI ${avgROI.toFixed(2)}% | Win rate ${(wins / data.count * 100).toFixed(1)}%`);
        });

        // Conclusión Fase 4
        console.log(`\n📌 CONCLUSIÓN FASE 4:`);

        const lateAndFalse = classification.late_entry + classification.false_positive;
        const lateAndFalseRate = (lateAndFalse / closedTrades.length) * 100;

        if (lateAndFalseRate > 40) {
            console.log(`   ⚠️ ${lateAndFalseRate.toFixed(1)}% de entradas son tardías o falsas`);
            console.log(`   → PROBLEMA DE TIMING: Score detiene bueno, pero entra tarde`);
            console.log(`   → Hipótesis: Modelo predice bien PARES pero no predice CUÁNDO`);
        } else if (classification.early_valid > closedTrades.length * 0.4) {
            console.log(`   ✅ ${(classification.early_valid / closedTrades.length * 100).toFixed(1)}% de entradas son tempranas válidas`);
            console.log(`   → TIMING CORRECTO: Entra antes del impulso`);
        } else {
            console.log(`   ➡️ Timing MIXTO: distribución equilibrada`);
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

detectEntryTiming();
