const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FORENSE 1: INTENTS Y EJECUCIÓN MANUAL
 *
 * Busca evidencia de si XECUSDT y CATIUSDT fueron ejecutados:
 * - A través de intent (force/manual)
 * - Por bypass del executor
 * - Por lógica normal pero con config diferente
 */

async function auditIntentsAndForces() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 AUDITORÍA 1: INTENTS Y EJECUCIÓN MANUAL');
        console.log('='.repeat(80) + '\n');

        // =====================================
        // PASO 1: Buscar intents_collection
        // =====================================
        console.log('PASO 1: Explorando real_spot_execution_intents\n');

        let intentsRef = db.collection('real_spot_execution_intents');
        let intentsSnap = await intentsRef.get();

        if (intentsSnap.empty) {
            console.log('❌ No existe collection "real_spot_execution_intents"');
            console.log('   Intentando alternativas...\n');

            // Buscar alternativas
            const collections = [
                'spot_execution_intents',
                'execution_intents',
                'trading_intents',
                'spot_intents',
                'real_intents',
                'intents'
            ];

            let foundIntents = false;
            for (const collName of collections) {
                try {
                    const snap = await db.collection(collName).limit(1).get();
                    if (!snap.empty) {
                        console.log(`✓ Encontrado collection: "${collName}"`);
                        intentsRef = db.collection(collName);
                        intentsSnap = await intentsRef.get();
                        foundIntents = true;
                        break;
                    }
                } catch (e) {
                    // Ignorar, probar siguiente
                }
            }

            if (!foundIntents) {
                console.log('⚠️  No se encontró intents collection');
                console.log('   Continuando con análisis de positions...\n');
            }
        } else {
            console.log(`✓ Encontrada collection "real_spot_execution_intents" con ${intentsSnap.size} documentos\n`);
        }

        // =====================================
        // PASO 2: Extraer intents relevantes
        // =====================================
        const targetSymbols = ['XECUSDT', 'CATIUSDT', 'ANKRUSDT'];
        let relevantIntents = [];

        if (!intentsSnap.empty) {
            console.log('PASO 2: Filtrando intents para XECUSDT, CATIUSDT, ANKRUSDT\n');

            intentsSnap.forEach(doc => {
                const intent = doc.data();
                if (targetSymbols.includes(intent.symbol)) {
                    relevantIntents.push({
                        id: doc.id,
                        ...intent
                    });
                }
            });

            console.log(`Encontrados ${relevantIntents.length} intents para símbolos objetivo\n`);

            relevantIntents.forEach((intent, idx) => {
                console.log(`Intent ${idx + 1}: ${intent.symbol || 'N/A'}`);
                console.log(`  ID: ${intent.id || 'N/A'}`);
                console.log(`  Created: ${intent.createdAt || intent.created_at || 'N/A'}`);
                console.log(`  Status: ${intent.status || 'N/A'}`);
                console.log(`  Source: ${intent.source || intent.source_module || 'N/A'}`);
                console.log(`  Force: ${intent.force || intent.is_forced || 'N/A'}`);
                console.log(`  Manual: ${intent.manual || intent.is_manual || 'N/A'}`);
                console.log(`  Override: ${intent.override || 'N/A'}`);
                console.log(`  Reason: ${intent.reason || 'N/A'}`);
                console.log(`  Score: ${intent.score || 'N/A'}`);
                console.log(`  Category: ${intent.category || 'N/A'}`);
                console.log(`  Strategy: ${intent.strategy || 'N/A'}`);
                console.log(`  Validation Passed: ${intent.validation_passed !== undefined ? intent.validation_passed : 'N/A'}`);
                console.log('');
            });

            if (relevantIntents.filter(i => i.force || i.is_forced || i.manual || i.is_manual || i.override).length > 0) {
                console.log('⚠️  ALERTA: Algunos intents tienen force/manual/override flags!');
                relevantIntents.filter(i => i.force || i.is_forced || i.manual || i.is_manual || i.override).forEach(i => {
                    console.log(`   ${i.symbol}: force=${i.force}, manual=${i.manual}, override=${i.override}`);
                });
            } else {
                console.log('✓ Ningún intent tiene force/manual/override flags');
            }
        } else {
            console.log('PASO 2: No hay intents collection\n');
        }

        // =====================================
        // PASO 3: Análisis de positions
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('PASO 3: Revisando positions directamente\n');

        const positionsSnap = await db.collection('real_spot_positions').get();
        const positions = [];
        positionsSnap.forEach(doc => positions.push({ id: doc.id, ...doc.data() }));

        console.log(`Total posiciones en real_spot_positions: ${positions.length}\n`);

        const relevantPositions = positions.filter(p => targetSymbols.includes(p.symbol));

        relevantPositions.forEach((pos, idx) => {
            console.log(`Posición ${idx + 1}: ${pos.symbol}`);
            console.log(`  Status: ${pos.status}`);
            console.log(`  Opened at: ${pos.opened_at || pos.openedAt || 'N/A'}`);
            console.log(`  Entry Price: ${pos.entry_price}`);
            console.log(`  Capital: ${pos.capital_usdt}`);
            console.log(`  Strategy: ${pos.strategy || 'N/A'}`);
            console.log(`  Intent ID: ${pos.intent_id || 'N/A'}`);
            console.log(`  Order ID: ${pos.order_id || 'N/A'}`);
            console.log(`  Scan ID: ${pos.scan_id || 'N/A'}`);
            console.log(`  Safety Version: ${pos.safety_version || 'N/A'}`);

            // Campos que podrían indicar origen
            console.log(`  Force Executed: ${pos.force_executed !== undefined ? pos.force_executed : 'N/A'}`);
            console.log(`  Manual Entry: ${pos.manual_entry !== undefined ? pos.manual_entry : 'N/A'}`);
            console.log(`  Bypass: ${pos.bypass !== undefined ? pos.bypass : 'N/A'}`);
            console.log(`  Execution Decision: ${JSON.stringify(pos.execution_decision || 'N/A')}`);
            console.log('');
        });

        // =====================================
        // PASO 4: Buscar en audit logs
        // =====================================
        console.log('='.repeat(80));
        console.log('PASO 4: Buscando audit logs\n');

        const auditCollections = [
            'audit_logs',
            'execution_audit',
            'trading_audit',
            'system_logs',
            'execution_logs'
        ];

        for (const collName of auditCollections) {
            try {
                const auditSnap = await db.collection(collName)
                    .where('symbol', 'in', targetSymbols)
                    .limit(10)
                    .get();

                if (!auditSnap.empty) {
                    console.log(`✓ Encontrado en "${collName}":\n`);
                    auditSnap.forEach(doc => {
                        const log = doc.data();
                        console.log(`  ${log.symbol || 'N/A'} at ${log.timestamp || log.createdAt || 'N/A'}`);
                        console.log(`    Action: ${log.action || log.event || 'N/A'}`);
                        console.log(`    Source: ${log.source || 'N/A'}`);
                        console.log(`    Details: ${JSON.stringify(log, null, 2).substring(0, 200)}`);
                        console.log('');
                    });
                }
            } catch (e) {
                // Ignorar colecciones que no existen
            }
        }

        // =====================================
        // CONCLUSIÓN PARCIAL
        // =====================================
        console.log('\n' + '='.repeat(80));
        console.log('CONCLUSIÓN PARCIAL - INTENTS');
        console.log('='.repeat(80) + '\n');

        if (!intentsSnap.empty && relevantIntents.filter(i => i.force || i.is_forced || i.manual || i.is_manual).length > 0) {
            console.log('🔴 HALLAZGO: Intents con FORCE/MANUAL encontrados');
            console.log('   → Esto sugiere ejecución manual, NO por pipeline normal\n');
        } else if (!intentsSnap.empty && relevantIntents.length > 0) {
            console.log('🟡 HALLAZGO: Intents normales encontrados');
            console.log('   → Ejecución procedió por pipeline, pero posiblemente con config diferente\n');
        } else {
            console.log('🟢 HALLAZGO: No hay intents para estos símbolos');
            console.log('   → Ejecución posiblemente por executor normal O intents fue limpiado\n');
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

auditIntentsAndForces();
