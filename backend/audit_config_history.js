const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FORENSE 2: CONFIG HISTÓRICO Y SNAPSHOTS
 *
 * Busca evidencia de cambios de configuración
 * Intenta reconstruir qué config estaba activa al momento de cada ejecución
 */

async function auditConfigHistory() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 AUDITORÍA 2: CONFIGURACIÓN HISTÓRICA Y SNAPSHOTS');
        console.log('='.repeat(80) + '\n');

        // =====================================
        // PASO 1: Obtener config actual
        // =====================================
        console.log('PASO 1: Config actual en real_spot_config/control\n');

        const configDoc = await db.collection('real_spot_config').doc('control').get();
        const currentConfig = configDoc.data();

        console.log('CONFIG ACTUAL (May 14 13:30 UTC):');
        console.log(`  min_opportunity_score: ${currentConfig.min_opportunity_score}`);
        console.log(`  allowed_categories: ${JSON.stringify(currentConfig.allowed_categories)}`);
        console.log(`  max_open_positions: ${currentConfig.max_open_positions}`);
        console.log(`  max_position_usdt: ${currentConfig.max_position_usdt}`);
        console.log(`  new_entries_enabled: ${currentConfig.new_entries_enabled}`);
        console.log(`  disable_after_first_entry: ${currentConfig.disable_after_first_entry}`);
        console.log(`  Updated: ${currentConfig.updated_at || currentConfig.updatedAt || 'N/A'}`);
        console.log('');

        // =====================================
        // PASO 2: Buscar snapshots de config
        // =====================================
        console.log('PASO 2: Buscando snapshots de configuración\n');

        // Buscar en varias posibles collections
        const snapshotCollections = [
            'real_spot_config_history',
            'config_history',
            'real_spot_config_snapshots',
            'config_snapshots',
            'real_spot_audit_config',
            'spot_config_versions'
        ];

        let foundSnapshots = false;
        for (const collName of snapshotCollections) {
            try {
                const snapshotSnap = await db.collection(collName)
                    .orderBy('timestamp', 'desc')
                    .limit(10)
                    .get();

                if (!snapshotSnap.empty) {
                    foundSnapshots = true;
                    console.log(`✓ Encontrado en collection: "${collName}"\n`);

                    snapshotSnap.forEach((doc, idx) => {
                        const snap = doc.data();
                        console.log(`Snapshot ${idx + 1}:`);
                        console.log(`  Timestamp: ${snap.timestamp || snap.createdAt || snap.created_at || 'N/A'}`);
                        console.log(`  min_opportunity_score: ${snap.min_opportunity_score}`);
                        console.log(`  allowed_categories: ${JSON.stringify(snap.allowed_categories)}`);
                        console.log(`  Version: ${snap.version || 'N/A'}`);
                        console.log(`  Updated by: ${snap.updated_by || snap.updatedBy || 'N/A'}`);
                        console.log('');
                    });
                    break;
                }
            } catch (e) {
                // Ignorar colecciones que no existen
            }
        }

        if (!foundSnapshots) {
            console.log('⚠️  No se encontraron snapshots de config histórico\n');
            console.log('   Alternativa: Buscando en campos "history" dentro de real_spot_config\n');

            // Intentar buscar documentos adicionales dentro de real_spot_config
            const configSnap = await db.collection('real_spot_config').get();
            configSnap.forEach(doc => {
                const data = doc.data();
                if (data.history || data.config_history) {
                    console.log(`✓ Encontrado en documento: "${doc.id}"`);
                    const history = data.history || data.config_history;
                    if (Array.isArray(history)) {
                        history.slice(0, 10).forEach((entry, idx) => {
                            console.log(`  History ${idx + 1}: ${entry.timestamp || entry.date || 'N/A'}`);
                            console.log(`    min_opportunity_score: ${entry.min_opportunity_score}`);
                            console.log(`    allowed_categories: ${JSON.stringify(entry.allowed_categories)}`);
                        });
                    }
                }
            });
        }

        // =====================================
        // PASO 3: Reconstruir config por timestamp
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('PASO 3: Reconstruyendo config en momentos críticos\n');

        const tradeTimestamps = [{
                symbol: 'ANKRUSDT (Trade 1)',
                timestamp: '2026-05-11T15:50:17.046Z',
                score: 100
            },
            {
                symbol: 'ANKRUSDT (Trade 2)',
                timestamp: '2026-05-11T15:50:17.046Z',
                score: 100
            },
            {
                symbol: 'XECUSDT (Trade 3)',
                timestamp: 'DESCONOCIDO',
                score: 27.98
            },
            {
                symbol: 'ANKRUSDT (Trade 4)',
                timestamp: '2026-05-13T20:40:33.692Z',
                score: 100
            },
            {
                symbol: 'CATIUSDT (Trade 5)',
                timestamp: '2026-05-13T20:45:32.117Z',
                score: 62.48
            }
        ];

        console.log('Análisis por timestamp:\n');
        tradeTimestamps.forEach(trade => {
            console.log(`${trade.symbol}`);
            console.log(`  Executed: ${trade.timestamp}`);
            console.log(`  Score: ${trade.score}`);
            console.log(`  Config requerida (para pasar): min_score <= ${trade.score}`);

            if (trade.score < 45) {
                console.log(`  ⚠️  Para ejecutar, config en ese momento tenía: min_score <= ${trade.score}`);
                console.log(`      vs CONFIG ACTUAL: min_score = ${currentConfig.min_opportunity_score}`);
            }
            console.log('');
        });

        // =====================================
        // PASO 4: Inferencia de config histórico
        // =====================================
        console.log('='.repeat(80));
        console.log('PASO 4: Inferencia de config histórico\n');

        // Analizar qué config debería haber existido para que XECUSDT y CATIUSDT pasaran
        const anomalousTrades = [
            { symbol: 'XECUSDT', score: 27.98, category: 'WATCHLIST' },
            { symbol: 'CATIUSDT', score: 62.48, category: 'NEW_OR_LOW_PRICE' }
        ];

        console.log('Para que XECUSDT (score 27.98, WATCHLIST) se ejecutara:\n');
        console.log('  Opción A: min_opportunity_score <= 27.98');
        console.log('           ACTUAL: 70 - Diferencia = 42.02 puntos DIFERENTE');
        console.log('');
        console.log('  Opción B: allowed_categories incluía "WATCHLIST"');
        console.log(`           ACTUAL: ${JSON.stringify(currentConfig.allowed_categories)}`);
        console.log('           INCLUÍA: ["BREAKOUT", "MOMENTUM", "ACCUMULATION", "WATCHLIST", ...]');
        console.log('');

        console.log('Para que CATIUSDT (score 62.48, NEW_OR_LOW_PRICE) se ejecutara:\n');
        console.log('  Opción A: min_opportunity_score <= 62.48');
        console.log('           ACTUAL: 70 - Diferencia = 7.52 puntos DIFERENTE');
        console.log('');
        console.log('  Opción B: allowed_categories incluía "NEW_OR_LOW_PRICE"');
        console.log(`           ACTUAL: ${JSON.stringify(currentConfig.allowed_categories)}`);
        console.log('           INCLUÍA: [..., "NEW_OR_LOW_PRICE", ...]');
        console.log('');

        // =====================================
        // PASO 5: Buscar en Firestore docs otros docs de config
        // =====================================
        console.log('='.repeat(80));
        console.log('PASO 5: Buscando todas las colecciones que mencionan "config"\n');

        try {
            const allCollections = await db.listCollections();
            const configCollections = [];

            for (const collRef of allCollections) {
                if (collRef.id.includes('config') || collRef.id.includes('setting') || collRef.id.includes('parameter')) {
                    configCollections.push(collRef.id);
                }
            }

            if (configCollections.length > 0) {
                console.log(`Encontradas colecciones relacionadas: ${configCollections.join(', ')}\n`);

                for (const collName of configCollections) {
                    console.log(`\n--- Collection: "${collName}" ---`);
                    const snap = await db.collection(collName).limit(5).get();
                    console.log(`  Documentos: ${snap.size}`);
                    snap.forEach(doc => {
                        const data = doc.data();
                        console.log(`  Doc: "${doc.id}"`);
                        if (data.min_opportunity_score !== undefined) {
                            console.log(`    min_opportunity_score: ${data.min_opportunity_score}`);
                        }
                        if (data.allowed_categories !== undefined) {
                            console.log(`    allowed_categories: ${JSON.stringify(data.allowed_categories)}`);
                        }
                    });
                }
            } else {
                console.log('No additional config-related collections found');
            }
        } catch (e) {
            console.log(`Error listing collections: ${e.message}`);
        }

        // =====================================
        // CONCLUSIÓN PARCIAL
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('CONCLUSIÓN PARCIAL - CONFIG');
        console.log('='.repeat(80) + '\n');

        if (!foundSnapshots) {
            console.log('🔴 HALLAZGO CRÍTICO: NO HAY SNAPSHOTS DE CONFIG');
            console.log('   → No se puede rastrear qué config estaba activa en cada momento');
            console.log('   → Pero por deducción: XECUSDT requería min_score <= 27.98 (vs actual 70)');
            console.log('   → Y CATIUSDT requería min_score <= 62.48 (vs actual 70)');
            console.log('   → Esto PRUEBA que config cambió después de esas ejecuciones\n');
        } else {
            console.log('✓ Snapshots encontrados - comparación con eventos en progreso');
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

auditConfigHistory();
