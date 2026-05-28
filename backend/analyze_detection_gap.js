const db = require('./firebase-admin-config.js');

/**
 * ANÁLISIS SIMPLIFICADO: QUÉ VIO VS QUÉ EJECUTÓ
 * Basado SOLO en datos internos de Firestore
 */

async function analyzeExecutionVsDetection() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 ANÁLISIS DE EJECUCIÓN vs DETECCIÓN');
        console.log('='.repeat(80));

        // HECHO 1: Candidatos detectados
        console.log(`\n📊 HALLAZGO 1: CANDIDATOS DETECTADOS`);

        const allCandidates = await db.collection('spot_opportunity_candidates').get();
        const candidates = [];
        allCandidates.forEach(doc => candidates.push(doc.data()));

        console.log(`Total candidatos en el sistema: ${candidates.length}`);

        if (candidates.length > 0) {
            // Agrupar por campos
            let withScore = 0;
            let withoutScore = 0;
            let withVolume = 0;
            let topSymbols = new Set();

            candidates.forEach(c => {
                if (c.composite_score && c.composite_score > 0) withScore++;
                else withoutScore++;

                if (c.volume_24h && c.volume_24h > 0) withVolume++;

                if (c.symbol) topSymbols.add(c.symbol);
            });

            console.log(`  • Con score válido: ${withScore}`);
            console.log(`  • Sin score o score = 0: ${withoutScore}`);
            console.log(`  • Con volumen > 0: ${withVolume}`);
            console.log(`  • Símbolos únicos: ${topSymbols.size}`);

            // Mostrar algunos
            const withValidScore = candidates.filter(c => c.composite_score && c.composite_score > 0);
            if (withValidScore.length > 0) {
                console.log(`\n  Top candidatos con score válido:`);
                withValidScore
                    .sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0))
                    .slice(0, 5)
                    .forEach((c, idx) => {
                        console.log(`    ${idx + 1}. ${c.symbol} | Score: ${(c.composite_score || 0).toFixed(0)} | Vol: $${(c.volume_24h || 0).toFixed(0)}`);
                    });
            }
        }

        // HECHO 2: Trades ejecutados (TODOS, no solo últimas 24h)
        console.log(`\n📈 HALLAZGO 2: TRADES EJECUTADOS (HISTORIAL COMPLETO)`);

        const allExecuted = await db.collection('real_spot_positions').get();
        const executed = [];
        const openTrades = [];
        const closedTrades = [];

        allExecuted.forEach(doc => {
            const trade = doc.data();
            executed.push(trade);
            if (trade.status === 'REAL_OPEN') openTrades.push(trade);
            else if (trade.status === 'CLOSED') closedTrades.push(trade);
        });

        console.log(`Total trades ejecutados: ${executed.length}`);
        console.log(`  • Abiertos: ${openTrades.length}`);
        console.log(`  • Cerrados: ${closedTrades.length}`);

        if (executed.length > 0) {
            console.log(`\n  Trades ejecutados:`);
            executed.forEach((t, idx) => {
                let timeStr = '';
                try {
                    timeStr = new Date(t.opened_at).toISOString().substring(0, 16);
                } catch (e) {
                    timeStr = 'invalid date';
                }
                console.log(`    ${idx + 1}. ${t.symbol} @ ${(t.entry_price || 0).toFixed(8)} (${timeStr}) | Status: ${t.status}`);
            });
        }

        // HECHO 3: Comparación - candidatos vs ejecutados
        console.log(`\n🔬 HALLAZGO 3: CANDIDATOS QUE FUERON EJECUTADOS`);

        const executedSymbols = executed.map(t => t.symbol);
        const candidateSymbols = candidates.map(c => c.symbol);

        const bothDetectedAndExecuted = executedSymbols.filter(s => candidateSymbols.includes(s));
        const detectedButNotExecuted = candidateSymbols.filter(s => !executedSymbols.includes(s));
        const executedButNotInCandidates = executedSymbols.filter(s => !candidateSymbols.includes(s));

        console.log(`  Detectados Y ejecutados: ${bothDetectedAndExecuted.length}`);
        bothDetectedAndExecuted.forEach(s => {
            console.log(`    ✓ ${s}`);
        });

        console.log(`\n  Detectados PERO NO ejecutados: ${detectedButNotExecuted.length}`);
        // Mostrar algunos
        if (detectedButNotExecuted.length <= 10) {
            detectedButNotExecuted.forEach(s => console.log(`    ✗ ${s}`));
        } else {
            detectedButNotExecuted.slice(0, 5).forEach(s => console.log(`    ✗ ${s}`));
            console.log(`    ... y ${detectedButNotExecuted.length - 5} más`);
        }

        console.log(`\n  Ejecutados PERO NO en candidatos: ${executedButNotInCandidates.length}`);
        executedButNotInCandidates.forEach(s => console.log(`    ⚠️ ${s}`));

        // HECHO 4: Ratio de conversión
        console.log(`\n${'='.repeat(80)}`);
        console.log('📊 HALLAZGO 4: RATIO DE CONVERSIÓN CANDIDATO → EJECUCIÓN\n');

        if (candidateSymbols.length > 0) {
            const conversionRate = (executed.length / candidateSymbols.length) * 100;
            console.log(`Candidatos únicos detectados: ${candidateSymbols.length}`);
            console.log(`Conversión a ejecución: ${conversionRate.toFixed(2)}%`);
            console.log(`Suppression/No ejecutado: ${(100 - conversionRate).toFixed(2)}%`);
        }

        // HECHO 5: Tipos de supresión
        console.log(`\n${'='.repeat(80)}`);
        console.log('🚫 HALLAZGO 5: ¿POR QUÉ NO SE EJECUTARON?\n');

        // Analizar candidatos sin score
        const noScoreCandidates = candidates.filter(c => !c.composite_score || c.composite_score === 0);
        console.log(`Candidatos sin score calculado: ${noScoreCandidates.length}`);
        if (noScoreCandidates.length > 0) {
            console.log(`  → Razón probable: Score insuficiente (probablemente < 45)`);
            console.log(`  → O: Evaluación nunca se completó`);
        }

        // Posibles suppressions
        const withScoreButNotExecuted = candidates
            .filter(c => c.composite_score && c.composite_score > 0)
            .filter(c => !executed.map(t => t.symbol).includes(c.symbol));

        console.log(`\nCandidatos CON score válido pero NO ejecutados: ${withScoreButNotExecuted.length}`);
        if (withScoreButNotExecuted.length > 0 && withScoreButNotExecuted.length <= 5) {
            withScoreButNotExecuted.forEach(c => {
                console.log(`  • ${c.symbol} | Score: ${c.composite_score.toFixed(0)} | Suppression: ¿Capital? ¿Cooldown? ¿Confidence?`);
            });
        }

        // CONCLUSIÓN
        console.log(`\n${'='.repeat(80)}`);
        console.log('✅ ANÁLISIS FINAL\n');

        if (executed.length === 0) {
            console.log(`Estado: SISTEMA EN STANDBY o RECIÉN INICIADO`);
            console.log(`Evidencia:`);
            console.log(`  • Detectó ${candidates.length} candidatos`);
            console.log(`  • Pero ejecutó 0 trades`);
            console.log(`  • Significa: Sistema está observando, no comprando todavía`);
            console.log(`\nPosibles razones:`);
            console.log(`  a) Ningún candidato alcanzó el score mínimo requerido`);
            console.log(`  b) Sistema en cooldown o esperando confirmación adicional`);
            console.log(`  c) Restricciones de capital (max per trade, max per session)`);
            console.log(`  d) Recién se activó, aún sin cierre de ciclos`);
        } else if (bothDetectedAndExecuted.length > 0) {
            console.log(`Estado: SISTEMA OPERATIVO Y SELECTIVO`);
            console.log(`Evidencia:`);
            console.log(`  • Detectó ${candidateSymbols.length} candidatos`);
            console.log(`  • Ejecutó ${executed.length} (${(executed.length / candidateSymbols.length * 100).toFixed(1)}% de los detectados)`);
            console.log(`  • De esos, ${bothDetectedAndExecuted.length} estaban en candidatos`);
            console.log(`\nInterpretación:`);
            console.log(`  ✓ Sistema SÍ detecta oportunidades`);
            console.log(`  ✓ Sistema SÍ ejecuta lo que detecta`);
            console.log(`  ✓ Suppression logic funciona (no ejecuta todo, solo lo mejor)`);
        } else if (executed.length > 0 && bothDetectedAndExecuted.length === 0) {
            console.log(`Estado: SISTEMA EJECUTA FUERA DE CANDIDATOS`);
            console.log(`Evidencia:`);
            console.log(`  • Detectó ${candidateSymbols.length} candidatos`);
            console.log(`  • Ejecutó ${executed.length} trades`);
            console.log(`  • Pero NINGUNO está en los candidatos`);
            console.log(`\nInterpretación:`);
            console.log(`  ⚠️ Posible DESINCRONIZACIÓN entre scanner y executor`);
            console.log(`  O bien: Ejecutor tiene lógica independiente de scanner`);
        }

        console.log(`\n${'='.repeat(80)}\n`);

    } catch (error) {
        console.error('Error:', error.message);
    }
}

analyzeExecutionVsDetection();
