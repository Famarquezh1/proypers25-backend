#!/usr/bin/env node

/**
 * SHADOW FEE MODEL DEEP INSPECTION
 * Explorar en detalle la inconsistencia del fee model
 */

const db = require('./backend/firebase-admin-config');

// Constantes conocidas
const EXPECTED_FEE_HARDCODED = 0.10;
const EXPECTED_FEE_ENV_DEFAULT = 0.20;

async function inspectShadowFeeModel() {
    console.log('🔬 SHADOW FEE MODEL DEEP INSPECTION');
    console.log('='.repeat(70));

    try {
        // Cargar directamente shadow results
        const snapshot = await db.collection('shadow_trade_results')
            .orderBy('updated_at', 'desc')
            .limit(50)
            .get();

        if (snapshot.empty) {
            console.log('❌ No shadow results found');
            return;
        }

        const results = snapshot.docs.map(doc => ({
            id: doc.id,
            symbol: doc.data().symbol,
            pnl_bruto: Number(doc.data().pnl_bruto) || 0,
            pnl_neto: Number(doc.data().pnl_neto) || 0,
            fees: Number(doc.data().fees) || 0,
            created_at: doc.data().created_at,
            updated_at: doc.data().updated_at
        }));

        console.log(`📍 Total shadow results loaded: ${results.length}`);

        // Análisis detallado de fees
        const uniqueFees = [...new Set(results.map(r => r.fees))];
        const feeHistogram = {};

        results.forEach(r => {
            const fee = r.fees.toString();
            feeHistogram[fee] = (feeHistogram[fee] || 0) + 1;
        });

        console.log('\n📊 FEE HISTOGRAM:');
        console.log('─'.repeat(50));
        Object.entries(feeHistogram)
            .sort((a, b) => b[1] - a[1])
            .forEach(([fee, count]) => {
                console.log(`${fee}%: ${count} trades`);
            });

        // Validación individual
        console.log('\n🔍 FEE VALIDATION PER TRADE:');
        console.log('─'.repeat(50));

        let validatedCount = 0;
        let inconsistentCount = 0;

        results.forEach((r, index) => {
            const calculatedNet = r.pnl_bruto - r.fees;
            const netDiff = Math.abs(r.pnl_neto - calculatedNet);
            const isValid = netDiff < 0.000001;

            if (!isValid) {
                console.log(`❌ Trade ${index + 1}: PnL bruto=${r.pnl_bruto}%, fees=${r.fees}%, neto_stored=${r.pnl_neto}%, neto_calc=${calculatedNet.toFixed(6)}%`);
                inconsistentCount++;
            } else {
                validatedCount++;
            }
        });

        console.log(`✅ Validated trades: ${validatedCount}`);
        console.log(`❌ Inconsistent trades: ${inconsistentCount}`);

        // Análisis de fórmula reverse-engineering
        console.log('\n🧮 REVERSE ENGINEERING FEE FORMULA:');
        console.log('─'.repeat(50));

        const feeAnalysis = results.map(r => {
            const impliedFee = r.pnl_bruto - r.pnl_neto;
            const storedFee = r.fees;
            const diff = Math.abs(impliedFee - storedFee);

            return {
                symbol: r.symbol,
                pnl_bruto: r.pnl_bruto,
                pnl_neto: r.pnl_neto,
                stored_fee: storedFee,
                implied_fee: impliedFee,
                fee_diff: diff,
                consistent: diff < 0.000001
            };
        });

        const consistentTrades = feeAnalysis.filter(f => f.consistent);
        const inconsistentTrades = feeAnalysis.filter(f => !f.consistent);

        console.log(`📍 Consistent formula trades: ${consistentTrades.length}`);
        console.log(`📍 Inconsistent formula trades: ${inconsistentTrades.length}`);

        if (inconsistentTrades.length > 0) {
            console.log('\n❌ INCONSISTENT TRADES SAMPLE:');
            inconsistentTrades.slice(0, 3).forEach((trade, index) => {
                console.log(`Trade ${index + 1}: ${trade.symbol}`);
                console.log(`  PnL bruto: ${trade.pnl_bruto}%`);
                console.log(`  PnL neto: ${trade.pnl_neto}%`);
                console.log(`  Fee stored: ${trade.stored_fee}%`);
                console.log(`  Fee implied: ${trade.implied_fee.toFixed(6)}%`);
                console.log(`  Difference: ${trade.fee_diff.toFixed(6)}%`);
            });
        }

        // Buscar patrones en fees
        console.log('\n🔍 PATRÓN DETECTION:');
        console.log('─'.repeat(50));

        const avgFee = results.reduce((sum, r) => sum + r.fees, 0) / results.length;
        const isMultipleOfHardcoded = Math.abs(avgFee / EXPECTED_FEE_HARDCODED - Math.round(avgFee / EXPECTED_FEE_HARDCODED)) < 0.01;
        const isMultipleOfEnvDefault = Math.abs(avgFee / EXPECTED_FEE_ENV_DEFAULT - Math.round(avgFee / EXPECTED_FEE_ENV_DEFAULT)) < 0.01;

        console.log(`📍 Avg fee: ${avgFee.toFixed(6)}%`);
        console.log(`📍 Is multiple of ${EXPECTED_FEE_HARDCODED}%: ${isMultipleOfHardcoded}`);
        console.log(`📍 Is multiple of ${EXPECTED_FEE_ENV_DEFAULT}%: ${isMultipleOfEnvDefault}`);

        if (isMultipleOfHardcoded) {
            const multiplier = Math.round(avgFee / EXPECTED_FEE_HARDCODED);
            console.log(`💡 Posible doble/triple aplicación: ${EXPECTED_FEE_HARDCODED}% x ${multiplier}`);
        }

        // Timeframe analysis
        console.log('\n📅 TIMEFRAME ANALYSIS:');
        console.log('─'.repeat(50));

        const byDate = {};
        results.forEach(r => {
            const date = new Date(r.updated_at).toISOString().split('T')[0];
            if (!byDate[date]) byDate[date] = [];
            byDate[date].push(r);
        });

        Object.entries(byDate).forEach(([date, trades]) => {
            const avgDailyFee = trades.reduce((sum, t) => sum + t.fees, 0) / trades.length;
            console.log(`${date}: ${trades.length} trades, avg fee: ${avgDailyFee.toFixed(6)}%`);
        });

        // Buscar en código fuente para env vars
        console.log('\n🔧 ENVIRONMENT VARIABLE CHECK:');
        console.log('─'.repeat(50));
        console.log(`📍 SHADOW_TRADE_BREAK_EVEN_FEE_PCT env var: ${process.env.SHADOW_TRADE_BREAK_EVEN_FEE_PCT || 'NOT SET'}`);

        // Conclusión final
        console.log('\n🎯 DIAGNOSTIC CONCLUSION:');
        console.log('─'.repeat(50));

        if (avgFee.toFixed(3) === EXPECTED_FEE_HARDCODED.toFixed(3)) {
            console.log(`✅ Fee model CORRECTO: Usando hardcoded ${EXPECTED_FEE_HARDCODED}%`);
        } else if (avgFee.toFixed(3) === EXPECTED_FEE_ENV_DEFAULT.toFixed(3)) {
            console.log(`⚠️ Fee model ALTERNATIVO: Usando env default ${EXPECTED_FEE_ENV_DEFAULT}%`);
        } else if (Math.abs(avgFee - 0.196) < 0.001) {
            console.log(`❌ Fee model INCONSISTENTE: Promedio ${avgFee.toFixed(6)}% no coincide con esperados`);
            console.log(`💡 Posible causa: Mezcla de values o cálculo incorrecto`);
        } else {
            console.log(`❓ Fee model DESCONOCIDO: Valor ${avgFee.toFixed(6)}% no reconocido`);
        }

        console.log('\n✅ SHADOW FEE MODEL INSPECTION COMPLETADA');

    } catch (error) {
        console.error('❌ ERROR en inspection:', error);
        console.error('Stack:', error.stack);
    }
}

inspectShadowFeeModel()
    .then(() => {
        console.log('\n🏁 Inspección completada');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Inspección falló:', error);
        process.exit(1);
    });