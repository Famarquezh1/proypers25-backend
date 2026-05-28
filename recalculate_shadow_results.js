#!/usr/bin/env node

/**
 * RECALCULATE SHADOW RESULTS - NORMALIZE FEE MODEL
 * Recalcular shadow results existentes con fee model unificado 0.10% roundtrip
 */

const db = require('./backend/firebase-admin-config');
const {
    SHADOW_FEE_MODEL_VERSION,
    getShadowFeeModelMetadata,
    isLegacyFeeModel,
    recalculateShadowResult
} = require('./backend/lib/shadowFeeModelConstants');

function round(value, precision) {
    return Math.round((value + Number.EPSILON) * Math.pow(10, precision)) / Math.pow(10, precision);
}

async function recalculateShadowResults() {
    console.log('🔄 RECALCULATE SHADOW RESULTS - FEE MODEL NORMALIZATION');
    console.log('='.repeat(70));
    console.log('OBJETIVO: Unificar fee model shadow a 0.10% roundtrip');
    console.log('VERSIÓN: ' + SHADOW_FEE_MODEL_VERSION);
    console.log('='.repeat(70));

    try {
        // Cargar todos los shadow results
        console.log('\n📊 LOADING SHADOW RESULTS...');
        const snapshot = await db.collection('shadow_trade_results')
            .orderBy('updated_at', 'desc')
            .limit(100)
            .get();

        if (snapshot.empty) {
            console.log('❌ No shadow results found');
            return;
        }

        const allResults = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        console.log(`📍 Total shadow results loaded: ${allResults.length}`);

        // Clasificar entre legacy y current model
        const legacyResults = allResults.filter(isLegacyFeeModel);
        const currentModelResults = allResults.filter(r => !isLegacyFeeModel(r));

        console.log(`📍 Legacy results (inconsistent fees): ${legacyResults.length}`);
        console.log(`📍 Current model results: ${currentModelResults.length}`);

        // Analizar legacy results
        if (legacyResults.length > 0) {
            console.log('\n🔍 LEGACY RESULTS ANALYSIS:');
            console.log('─'.repeat(50));

            const feeHistogram = {};
            legacyResults.forEach(r => {
                const fee = (Number(r.fees) || 0).toFixed(3);
                feeHistogram[fee] = (feeHistogram[fee] || 0) + 1;
            });

            Object.entries(feeHistogram).forEach(([fee, count]) => {
                console.log(`  ${fee}%: ${count} results`);
            });

            const legacyPnlBruto = legacyResults.reduce((sum, r) => sum + (Number(r.pnl_bruto) || 0), 0);
            const legacyPnlNeto = legacyResults.reduce((sum, r) => sum + (Number(r.pnl_neto) || 0), 0);
            const legacyFees = legacyResults.reduce((sum, r) => sum + (Number(r.fees) || 0), 0);

            console.log(`  PnL Bruto Legacy: ${round(legacyPnlBruto, 6)}%`);
            console.log(`  PnL Neto Legacy: ${round(legacyPnlNeto, 6)}%`);
            console.log(`  Fees Legacy: ${round(legacyFees, 6)}%`);
            console.log(`  Avg Fee Legacy: ${round(legacyFees / legacyResults.length, 6)}%`);
        }

        // Recalcular legacy results
        console.log('\n🔄 RECALCULATING LEGACY RESULTS...');
        console.log('─'.repeat(50));

        const recalculatedResults = [];
        let recalculatedCount = 0;
        let skippedCount = 0;

        for (const legacyResult of legacyResults) {
            try {
                // No sobrescribir si ya tiene la versión correcta
                if (legacyResult.fee_model_version === SHADOW_FEE_MODEL_VERSION) {
                    skippedCount++;
                    continue;
                }

                const recalculated = recalculateShadowResult(legacyResult);
                recalculatedResults.push(recalculated);

                // Persistir resultado recalculado con nuevo ID para evitar conflictos
                const newId = `${legacyResult.id}_${SHADOW_FEE_MODEL_VERSION}`;
                await db.collection('shadow_trade_results').doc(newId).set(recalculated);

                recalculatedCount++;

                if (recalculatedCount % 5 === 0) {
                    console.log(`  Recalculados: ${recalculatedCount}/${legacyResults.length}`);
                }

            } catch (error) {
                console.error(`❌ Error recalculando ${legacyResult.id}:`, error.message);
            }
        }

        console.log(`✅ Recalculados: ${recalculatedCount}`);
        console.log(`⏭️ Skipped (already current): ${skippedCount}`);

        // Análisis de resultados recalculados
        if (recalculatedResults.length > 0) {
            console.log('\n📈 RECALCULATED RESULTS ANALYSIS:');
            console.log('─'.repeat(50));

            const recalcPnlBruto = recalculatedResults.reduce((sum, r) => sum + (Number(r.pnl_bruto) || 0), 0);
            const recalcPnlNeto = recalculatedResults.reduce((sum, r) => sum + (Number(r.pnl_neto) || 0), 0);
            const recalcFees = recalculatedResults.reduce((sum, r) => sum + (Number(r.fees) || 0), 0);

            console.log(`  PnL Bruto Recalculated: ${round(recalcPnlBruto, 6)}%`);
            console.log(`  PnL Neto Recalculated: ${round(recalcPnlNeto, 6)}%`);
            console.log(`  Fees Recalculated: ${round(recalcFees, 6)}%`);
            console.log(`  Avg Fee Recalculated: ${round(recalcFees / recalculatedResults.length, 6)}%`);

            // Comparación legacy vs recalculated
            if (legacyResults.length > 0) {
                const legacyAvgPnlNeto = legacyResults.reduce((sum, r) => sum + (Number(r.pnl_neto) || 0), 0) / legacyResults.length;
                const recalcAvgPnlNeto = recalcPnlNeto / recalculatedResults.length;
                const improvement = recalcAvgPnlNeto - legacyAvgPnlNeto;

                console.log('\n📊 COMPARISON LEGACY VS RECALCULATED:');
                console.log('─'.repeat(50));
                console.log(`  Legacy Avg PnL Neto: ${round(legacyAvgPnlNeto, 6)}%`);
                console.log(`  Recalc Avg PnL Neto: ${round(recalcAvgPnlNeto, 6)}%`);
                console.log(`  Improvement: ${round(improvement, 6)}%`);

                if (improvement > 0) {
                    console.log(`✅ Fee normalization IMPROVED performance`);
                } else {
                    console.log(`❌ Fee normalization did NOT improve performance`);
                }
            }
        }

        // Análisis por símbolo
        console.log('\n📋 SYMBOL ANALYSIS (Recalculated):');
        console.log('─'.repeat(50));

        const symbolMap = {};
        recalculatedResults.forEach(r => {
            const symbol = r.symbol || 'UNKNOWN';
            if (!symbolMap[symbol]) {
                symbolMap[symbol] = {
                    count: 0,
                    pnl_bruto_total: 0,
                    pnl_neto_total: 0,
                    fees_total: 0
                };
            }
            symbolMap[symbol].count++;
            symbolMap[symbol].pnl_bruto_total += Number(r.pnl_bruto) || 0;
            symbolMap[symbol].pnl_neto_total += Number(r.pnl_neto) || 0;
            symbolMap[symbol].fees_total += Number(r.fees) || 0;
        });

        Object.entries(symbolMap).forEach(([symbol, data]) => {
            console.log(`  ${symbol}: ${data.count} trades`);
            console.log(`    PnL Bruto: ${round(data.pnl_bruto_total, 6)}%`);
            console.log(`    PnL Neto: ${round(data.pnl_neto_total, 6)}%`);
            console.log(`    Fees: ${round(data.fees_total, 6)}%`);
        });

        // Resumen final
        console.log('\n📑 RESUMEN EJECUTIVO:');
        console.log('─'.repeat(50));
        console.log(`📍 Fee model consistent: ${legacyResults.length === 0 ? 'YES' : 'NO (normalized)'}`);
        console.log(`📍 Legacy results count: ${legacyResults.length}`);
        console.log(`📍 Current model results count: ${currentModelResults.length + recalculatedResults.length}`);
        console.log(`📍 Recalculated count: ${recalculatedCount}`);
        console.log(`📍 New fee model version: ${SHADOW_FEE_MODEL_VERSION}`);

        console.log('\n✅ SHADOW RESULTS RECALCULATION COMPLETED');

    } catch (error) {
        console.error('❌ ERROR en recalculation:', error);
        console.error('Stack:', error.stack);
    }
}

recalculateShadowResults()
    .then(() => {
        console.log('\n🏁 Recalculation completed');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Recalculation failed:', error);
        process.exit(1);
    });