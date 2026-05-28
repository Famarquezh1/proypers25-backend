const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA CRÍTICA: RASTREO DEL SCORING ROTO
 *
 * Objetivo: Encontrar exactamente dónde se rompe el pipeline
 * Scanner → Save → Firestore → Validator → Executor
 */

async function auditScoringPipeline() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 AUDITORÍA CRÍTICA: RASTREO DEL SCORING');
        console.log('='.repeat(80));

        // PASO 1: Verificar qué está EN FIRESTORE realmente
        console.log(`\n📊 PASO 1: INSPECCIONAR FIRESTORE - spot_opportunity_candidates`);

        const candidateSnap = await db.collection('spot_opportunity_candidates').limit(5).get();

        if (candidateSnap.empty) {
            console.log('❌ Colección vacía');
        } else {
            const firstDoc = candidateSnap.docs[0].data();

            console.log(`\n  Documento de ejemplo 1:`);
            console.log(`    Symbol: ${firstDoc.symbol}`);
            console.log(`    opportunityScore: ${firstDoc.opportunityScore} (type: ${typeof firstDoc.opportunityScore})`);
            console.log(`    composite_score: ${firstDoc.composite_score} (type: ${typeof firstDoc.composite_score})`);
            console.log(`    confidence_score: ${firstDoc.confidence_score} (type: ${typeof firstDoc.confidence_score})`);
            console.log(`    volatilityScore: ${firstDoc.volatilityScore}`);
            console.log(`    accumulationScore: ${firstDoc.accumulationScore}`);
            console.log(`    impulseScore: ${firstDoc.impulseScore}`);
            console.log(`    riskScore: ${firstDoc.riskScore}`);

            // Detectar qué campos están presentes
            const fields = Object.keys(firstDoc);
            const scoreFields = fields.filter(f => f.toLowerCase().includes('score'));
            console.log(`\n  Score-related fields found: ${scoreFields.join(', ')}`);
        }

        // PASO 2: Verificar distribución real de scores
        console.log(`\n📊 PASO 2: DISTRIBUCIÓN DE SCORES EN FIRESTORE`);

        const allCandidates = await db.collection('spot_opportunity_candidates')
            .limit(500)
            .get();

        const candidates = [];
        allCandidates.forEach(doc => candidates.push(doc.data()));

        if (candidates.length > 0) {
            // Analizar opportunityScore
            const oppScores = candidates
                .map(c => Number(c.opportunityScore || 0))
                .filter(s => Number.isFinite(s))
                .sort((a, b) => b - a);

            const compositeScores = candidates
                .map(c => Number(c.composite_score || 0))
                .filter(s => Number.isFinite(s))
                .sort((a, b) => b - a);

            console.log(`\n  opportunityScore:`)
            console.log(`    Total con dato: ${oppScores.length}/${candidates.length}`);
            console.log(`    Max: ${oppScores[0] || 'N/A'}`);
            console.log(`    Min: ${oppScores[oppScores.length - 1] || 'N/A'}`);
            console.log(`    Promedio: ${oppScores.length > 0 ? (oppScores.reduce((a,b)=>a+b)/oppScores.length).toFixed(2) : 'N/A'}`);
            console.log(`    > 45: ${oppScores.filter(s => s > 45).length}`);
            console.log(`    > 60: ${oppScores.filter(s => s > 60).length}`);
            console.log(`    > 70: ${oppScores.filter(s => s > 70).length}`);

            console.log(`\n  composite_score (alternativo):`)
            console.log(`    Total con dato: ${compositeScores.length}/${candidates.length}`);
            console.log(`    Max: ${compositeScores[0] || 'N/A'}`);
            console.log(`    Promedio: ${compositeScores.length > 0 ? (compositeScores.reduce((a,b)=>a+b)/compositeScores.length).toFixed(2) : 'N/A'}`);
        }

        // PASO 3: Verificar 5 trades ejecutados
        console.log(`\n📈 PASO 3: RASTREAR LOS 5 TRADES EJECUTADOS`);

        const executedSnap = await db.collection('real_spot_positions').get();
        const executed = [];
        executedSnap.forEach(doc => executed.push({ id: doc.id, ...doc.data() }));

        console.log(`\n  Total trades: ${executed.length}`);

        executed.forEach((trade, idx) => {
            const symbol = trade.symbol;

            // Buscar en candidatos
            const candidateMatch = candidates.find(c => c.symbol === symbol);

            console.log(`\n  Trade ${idx + 1}: ${symbol}`);
            console.log(`    Status: ${trade.status}`);
            console.log(`    Entry: ${trade.entry_price}`);
            console.log(`    Capital: ${trade.capital_usdt}`);
            console.log(`    Strategy: ${trade.strategy}`);

            if (candidateMatch) {
                console.log(`    ✓ ENCONTRADO EN CANDIDATOS`);
                console.log(`      - opportunityScore: ${candidateMatch.opportunityScore}`);
                console.log(`      - Category: ${candidateMatch.category}`);
                console.log(`      - Recommendation: ${candidateMatch.recommendation}`);
            } else {
                console.log(`    ✗ NO encontrado en candidatos`);
                console.log(`      → Ejecutado de otra fuente`);
            }
        });

        // PASO 4: Verificar config de ejecutor
        console.log(`\n⚙️  PASO 4: CONFIGURACIÓN DEL EXECUTOR`);

        const configSnap = await db.collection('real_spot_config')
            .doc('control')
            .get();

        if (configSnap.exists) {
            const config = configSnap.data();
            console.log(`\n  min_opportunity_score: ${config.min_opportunity_score}`);
            console.log(`  allowed_categories: ${JSON.stringify(config.allowed_categories)}`);
            console.log(`  max_position_usdt: ${config.max_position_usdt}`);
            console.log(`  max_total_capital_usdt: ${config.max_total_capital_usdt}`);
            console.log(`  max_open_positions: ${config.max_open_positions}`);
            console.log(`  max_entries_this_session: ${config.max_entries_this_session}`);
            console.log(`  entries_used_this_session: ${config.entries_used_this_session}`);
            console.log(`  new_entries_enabled: ${config.new_entries_enabled}`);
        }

        // PASO 5: Buscar logs de scans
        console.log(`\n📋 PASO 5: HISTORIAL DE SCANS`);

        const scansSnap = await db.collection('spot_opportunity_scans')
            .orderBy('created_at', 'desc')
            .limit(3)
            .get();

        if (!scansSnap.empty) {
            scansSnap.forEach((doc, idx) => {
                const scan = doc.data();
                console.log(`\n  Scan ${idx + 1}: ${doc.id}`);
                console.log(`    Created: ${new Date(scan.created_at?.toDate?.() || scan.created_at).toISOString()}`);
                console.log(`    Candidates: ${scan.candidates_count || '?'}`);
                console.log(`    Version: ${scan.scanner_version}`);
            });
        } else {
            console.log('  ❌ Sin scans encontrados');
        }

        // CONCLUSIÓN
        console.log(`\n${'='.repeat(80)}`);
        console.log('🎯 DIAGNÓSTICO INICIAL\n');

        const hasValidScores = candidates.some(c => Number(c.opportunityScore || 0) > 0);
        const executedButNotInCandidates = executed.filter(t => !candidates.find(c => c.symbol === t.symbol));

        if (!hasValidScores) {
            console.log(`❌ PROBLEMA CRÍTICO: Todos los candidatos tienen score = 0 o missing`);
            console.log(`   Las 2,512 candidatos que vimos tienen opportunityScore = 0`);
            console.log(`   Significa: El cálculo de score nunca se completó o se guarda incorrectamente`);
        } else {
            console.log(`✓ Los candidatos SÍ tienen scores válidos`);
        }

        if (executedButNotInCandidates.length > 0) {
            console.log(`\n⚠️ DESINCRONIZACIÓN DETECTADA:`);
            console.log(`   ${executedButNotInCandidates.length} trades ejecutados NO están en spot_opportunity_candidates`);
            console.log(`   Esto sugiere que el executor tiene lógica separada o usa otro origen de datos`);
        } else if (executed.length > 0) {
            console.log(`\n✓ Los trades ejecutados están sincronizados con candidatos`);
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

auditScoringPipeline();
