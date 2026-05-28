const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FINAL: REPORTE INTEGRADO Y CONCLUSIONES
 * Sintetiza todos los análisis y define la naturaleza real del sistema
 */

async function generateAuditReport() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('📋 AUDITORÍA FINAL: REPORTE INTEGRADO');
        console.log('='.repeat(80));

        // Obtener datos base
        const allPositions = await db.collection('real_spot_positions').get();
        const closedSnapshot = await db.collection('real_spot_positions')
            .where('status', '==', 'CLOSED')
            .get();

        const allTrades = [];
        const closedTrades = [];

        allPositions.forEach(doc => allTrades.push(doc.data()));
        closedSnapshot.forEach(doc => closedTrades.push(doc.data()));

        const openTrades = allTrades.filter(t => t.status === 'REAL_OPEN');

        console.log(`\n📊 ESTADÍSTICAS GLOBALES:`);
        console.log(`  Total trades: ${allTrades.length}`);
        console.log(`  Abiertos: ${openTrades.length}`);
        console.log(`  Cerrados: ${closedTrades.length}`);

        if (closedTrades.length < 3) {
            console.log(`\n⚠️ MUESTRA INSUFICIENTE: ${closedTrades.length} trades cerrados`);
            console.log(`   Se necesitan mínimo 5-10 trades cerrados para conclusiones estadísticas`);
            console.log(`   Recolectando datos: espera a que se cierren más posiciones`);
            return;
        }

        // Calcular métricas
        let totalProfit = 0;
        let winCount = 0;
        let lossCount = 0;

        const trades_by_pnl = [];
        const trades_by_duration = [];

        closedTrades.forEach(trade => {
            const pnl = trade.pnl || 0;
            totalProfit += pnl;

            if (pnl > 0.01) winCount++;
            else if (pnl < -0.01) lossCount++;

            const duration = new Date(trade.closed_at) - new Date(trade.opened_at);
            const durationHours = duration / 1000 / 60 / 60;

            trades_by_pnl.push(pnl);
            trades_by_duration.push(durationHours);
        });

        const winRate = (winCount / closedTrades.length) * 100;
        const totalCapital = closedTrades.reduce((s, t) => s + (t.capital_usdt || 0), 0);
        const totalROI = (totalProfit / totalCapital) * 100;
        const avgDuration = trades_by_duration.reduce((a, b) => a + b) / trades_by_duration.length;

        // Profitability distribution
        const explosiveWins = trades_by_pnl.filter(p => p > totalCapital * 0.3).length;
        const smallWins = trades_by_pnl.filter(p => p > 0.01 && p <= totalCapital * 0.05).length;
        const smallLosses = trades_by_pnl.filter(p => p < -0.01 && p >= -totalCapital * 0.05).length;

        console.log(`\n💰 RESULTADOS REALES:`);
        console.log(`  Profit neto: ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} USDT`);
        console.log(`  Win rate: ${winRate.toFixed(1)}%`);
        console.log(`  Total ROI: ${totalROI.toFixed(2)}%`);
        console.log(`  Duración promedio: ${avgDuration.toFixed(1)} horas`);

        console.log(`\n📈 CARACTERÍSTICAS DE PROFITABILIDAD:`);
        console.log(`  Ganancias explosivas (+30%+ capítulo): ${explosiveWins}`);
        console.log(`  Ganancias pequeñas (+1-5%): ${smallWins}`);
        console.log(`  Pérdidas pequeñas (-1-5%): ${smallLosses}`);

        // MATRIZ DE DIAGNÓSTICO
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔍 MATRIZ DE DIAGNÓSTICO`);
        console.log(`${'='.repeat(80)}\n`);

        const diagnostics = [];

        // Diagnóstico 1: Win Rate
        console.log(`1️⃣  WIN RATE: ${winRate.toFixed(1)}%`);
        if (winRate > 55) {
            console.log(`    ✅ ALTO (> 55%): Sistema acierta mayoría de trades`);
            diagnostics.push('high_win_rate');
        } else if (winRate > 40) {
            console.log(`    ⚠️ MEDIO (40-55%): Sistema acierta menos de mitad pero sigue rentable`);
            diagnostics.push('medium_win_rate');
        } else {
            console.log(`    ❌ BAJO (< 40%): Sistema acierta minoría de trades`);
            diagnostics.push('low_win_rate');
        }

        // Diagnóstico 2: Asymmetry
        console.log(`\n2️⃣  ASIMETRÍA (ganancia vs pérdida):`);
        const avgWin = trades_by_pnl.filter(p => p > 0).reduce((a, b) => a + b, 0) / (winCount || 1);
        const avgLoss = Math.abs(trades_by_pnl.filter(p => p < 0).reduce((a, b) => a + b, 0) / (lossCount || 1));
        const winLossRatio = avgWin / (avgLoss || 1);

        console.log(`    Ganancia promedio: ${avgWin.toFixed(2)} USDT`);
        console.log(`    Pérdida promedio: ${avgLoss.toFixed(2)} USDT`);
        console.log(`    Ratio ganancia/pérdida: ${winLossRatio.toFixed(2)}x`);

        if (winLossRatio > 2) {
            console.log(`    ✅ ASIMETRÍA FUERTE: Pocos grandes ganan muchos pequeños`);
            diagnostics.push('strong_asymmetry');
        } else if (winLossRatio > 1) {
            console.log(`    ⚠️ ASIMETRÍA DÉBIL: Ganancias > pérdidas pero no explosivas`);
            diagnostics.push('weak_asymmetry');
        } else {
            console.log(`    ❌ SIN ASIMETRÍA: Ganancias ≈ pérdidas`);
            diagnostics.push('no_asymmetry');
        }

        // Diagnóstico 3: Duración
        console.log(`\n3️⃣  TIMEFRAME OPERATIVO: ${avgDuration.toFixed(1)} horas`);
        if (avgDuration < 1) {
            console.log(`    ⚡ ULTRA-CORTO (scalping)`);
            diagnostics.push('ultrashort_tf');
        } else if (avgDuration < 24) {
            console.log(`    📊 INTRADAY (day trading)`);
            diagnostics.push('intraday_tf');
        } else if (avgDuration < 168) {
            console.log(`    📈 SWING (1-7 días)`);
            diagnostics.push('swing_tf');
        } else {
            console.log(`    📅 LARGO PLAZO (> 1 semana)`);
            diagnostics.push('longterm_tf');
        }

        // Diagnóstico 4: Profitability pattern
        console.log(`\n4️⃣  PATRÓN DE GANANCIAS:`);
        if (explosiveWins > closedTrades.length * 0.1 && smallWins < explosiveWins) {
            console.log(`    💥 EXPLOSIVOS DOMINAN: Pocos trades grandes ganan sesión`);
            diagnostics.push('explosive_pattern');
        } else if (smallWins > smallLosses && explosiveWins === 0) {
            console.log(`    📚 CONSISTENCIA PEQUEÑA: Muchos pequeños trades + positivos`);
            diagnostics.push('consistent_pattern');
        } else if (explosiveWins > 0 && smallWins > 0) {
            console.log(`    🎲 PATRÓN MIXTO: Combinación de ambos`);
            diagnostics.push('mixed_pattern');
        } else {
            console.log(`    ❌ SIN PATRÓN CLARO`);
            diagnostics.push('no_clear_pattern');
        }

        // DEFINICIÓN FINAL
        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ CONCLUSIÓN FINAL: ¿QUÉ TIPO DE SISTEMA ES PROYPERS25?`);
        console.log(`${'='.repeat(80)}\n`);

        // Lógica de clasificación
        const isHighWinRate = diagnostics.includes('high_win_rate') || diagnostics.includes('medium_win_rate');
        const hasAsymmetry = diagnostics.includes('strong_asymmetry') || diagnostics.includes('weak_asymmetry');
        const isLongTerm = diagnostics.includes('swing_tf') || diagnostics.includes('longterm_tf');
        const isExplosivePattern = diagnostics.includes('explosive_pattern');

        if (isHighWinRate && !isExplosivePattern) {
            console.log(`📊 CLASIFICACIÓN: SISTEMA MOMENTUM CORTO PLAZO`);
            console.log(`\nCaracterísticas:`);
            console.log(`  • Win rate alto (${winRate.toFixed(1)}%)`);
            console.log(`  • Detecta momentum de corto plazo correctamente`);
            console.log(`  • Timing de entrada es bueno (entra antes del impulso)`);
            console.log(`  • Ganancias consistentes y predecibles`);
            console.log(`\nImplicación:`);
            console.log(`  ✅ El modelo SÍ tiene edge estadístico`);
            console.log(`  ✅ El score es predictivo`);
            console.log(`  ✅ El timing es correcto`);
        } else if (!isHighWinRate && hasAsymmetry && isExplosivePattern) {
            console.log(`💥 CLASIFICACIÓN: DETECTOR DE ASIMETRÍAS SPOT`);
            console.log(`\nCaracterísticas:`);
            console.log(`  • Win rate bajo (${winRate.toFixed(1)}%)`);
            console.log(`  • Pero pocos trades grandes compensan muchas pérdidas`);
            console.log(`  • Edge está en capturar movimientos asimétricos/explosivos`);
            console.log(`  • Requiere paciencia (algunos trades negativos antes del grande)`);
            console.log(`\nImplicación:`);
            console.log(`  ✅ El modelo SÍ tiene edge (asimetría, no win rate)`);
            console.log(`  ✅ Las pérdidas pequeñas son NORMALES Y NECESARIAS`);
            console.log(`  ✅ Necesita timeframe LARGO para materializarse`);
        } else if (isLongTerm && hasAsymmetry && isHighWinRate) {
            console.log(`📈 CLASIFICACIÓN: SISTEMA HÍBRIDO (swing + asimetría)`);
            console.log(`\nCaracterísticas:`);
            console.log(`  • Duración promedio ${avgDuration.toFixed(1)} horas`);
            console.log(`  • Win rate aceptable + asimetría moderada`);
            console.log(`  • Captura movimientos de 1-7 días`);
            console.log(`\nImplicación:`);
            console.log(`  ✅ Edge robusto pero requiere esperar`);
            console.log(`  ✅ Necesita 7+ días para validar realmente`);
        } else if (!isHighWinRate && !hasAsymmetry) {
            console.log(`❌ CLASIFICACIÓN: SIN EDGE ESTADÍSTICO CLARO`);
            console.log(`\nProblemas:`);
            console.log(`  • Win rate bajo SIN compensación asimétrica`);
            console.log(`  • Las pérdidas no son compensadas por ganancias`);
            console.log(`  • Puede ser por: a) Muestra insuficiente, b) Timing malo, c) Score mal calibrado`);
            console.log(`\nAcciones:`);
            console.log(`  ⚠️ Recolectar más datos (mínimo 20 trades cerrados)`);
            console.log(`  ⚠️ Analizar si el timing mejora en timeframe más largo`);
            console.log(`  ⚠️ Validar calibración del score`);
        } else {
            console.log(`❓ CLASIFICACIÓN: PATRÓN NO CONCLUYENTE`);
            console.log(`\nMuestra insuficiente o patrón inusual.`);
            console.log(`Diagnósticos activos: ${diagnostics.join(', ')}`);
        }

        // RECOMENDACIONES
        console.log(`\n${'='.repeat(80)}`);
        console.log(`💡 RECOMENDACIONES`);
        console.log(`${'='.repeat(80)}\n`);

        if (closedTrades.length < 10) {
            console.log(`1. ⏳ RECOLECTAR MÁS DATOS`);
            console.log(`   Tienes ${closedTrades.length} trades, necesitas mínimo 20`);
            console.log(`   Sin suficientes datos, no hay conclusión estadística`);
        }

        if (avgDuration > 48 && isExplosivePattern) {
            console.log(`\n2. ✅ TIMEFRAME LARGO CONFIRMADO`);
            console.log(`   El sistema espera ${avgDuration.toFixed(0)}+ horas por trade`);
            console.log(`   Los 2 trades actuales (ANKRUSDT, CATIUSDT) están apenas con 1 día`);
            console.log(`   Paciencia: pueden explotar en 5-10 días`);
        }

        if (!isHighWinRate && isExplosivePattern) {
            console.log(`\n3. 💥 ESPERA MOVIMIENTOS EXPLOSIVOS`);
            console.log(`   No es anormal que ganen solo ${winRate.toFixed(1)}% si es sistema asimétrico`);
            console.log(`   Pero cuando ganan, ganan mucho (${explosiveWins} ganancias grandes)`);
            console.log(`   El problema no es el modelo, es la paciencia`);
        }

        console.log(`\n4. 📊 PRÓXIMAS ACCIONES`);
        console.log(`   • NO modificar el sistema aún`);
        console.log(`   • Dejar que se cierren 10-20 trades más`);
        console.log(`   • Re-correr esta auditoría mensualmente`);
        console.log(`   • Validar si edge se mantiene a largo plazo`);

    } catch (error) {
        console.error('Error:', error.message);
    }
}

generateAuditReport();