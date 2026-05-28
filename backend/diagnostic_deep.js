const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function diagnosticDeep() {
    try {
        console.log('='.repeat(80));
        console.log('DIAGNÓSTICO PROFUNDO DEL SISTEMA DE TRADING');
        console.log('='.repeat(80));
        console.log();

        // 1. Inspeccionar estructura de real_spot_positions
        console.log('1️⃣  ESTRUCTURA DE POSICIONES (REAL_CLOSED)');
        console.log('-'.repeat(80));

        const sampleClosed = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_CLOSED')
            .limit(1)
            .get();

        if (!sampleClosed.empty) {
            const doc = sampleClosed.docs[0];
            const data = doc.data();
            console.log('Documento muestra:');
            console.log(JSON.stringify(data, null, 2));
            console.log();
        }

        // 2. Inspeccionar control document
        console.log('2️⃣  ESTRUCTURA DEL DOCUMENTO CONTROL');
        console.log('-'.repeat(80));

        const controlDoc = await db.collection('real_spot_config')
            .doc('control')
            .get();

        if (controlDoc.exists) {
            console.log('Documento control encontrado:');
            const control = controlDoc.data();
            console.log(JSON.stringify(control, null, 2));
            console.log();
        } else {
            console.log('❌ Documento control NO encontrado');
        }

        // 3. Contar documentos por estado
        console.log('3️⃣  CANTIDAD DE POSICIONES POR ESTADO');
        console.log('-'.repeat(80));

        const statuses = ['REAL_OPEN', 'REAL_CLOSED', 'SHADOW_OPEN', 'SHADOW_CLOSED', 'PENDING'];
        for (const status of statuses) {
            const count = await db.collection('real_spot_positions')
                .where('status', '==', status)
                .count()
                .get();
            console.log(`  ${status}: ${count.data().count}`);
        }
        console.log();

        // 4. Inspeccionar colecciones que existen
        console.log('4️⃣  COLECCIONES EN FIRESTORE');
        console.log('-'.repeat(80));

        const collections = [
            'real_spot_positions',
            'real_spot_config',
            'real_spot_execution_results',
            'real_spot_intents'
        ];

        for (const coll of collections) {
            try {
                const snapshot = await db.collection(coll).limit(1).get();
                const count = await db.collection(coll).count().get();
                console.log(`  ✓ ${coll}: ${count.data().count} documentos`);
            } catch (err) {
                console.log(`  ✗ ${coll}: Error - ${err.message.substring(0, 50)}`);
            }
        }
        console.log();

        // 5. Buscar posiciones con PnL real
        console.log('5️⃣  BÚSQUEDA DE POSICIONES CON PnL != 0');
        console.log('-'.repeat(80));

        const allClosed = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_CLOSED')
            .get();

        let foundNonZero = false;
        allClosed.forEach(doc => {
            const data = doc.data();
            const pnl = data.pnl_usdt;
            if (pnl && pnl !== 0) {
                foundNonZero = true;
                console.log(`  ${data.symbol}: $${pnl.toFixed(2)} USDT`);
            }
        });

        if (!foundNonZero) {
            console.log('  ❌ Todas las posiciones cerradas tienen PnL = 0');
        }
        console.log();

        // 6. Inspeccionar campos de una posición REAL_OPEN (si existe)
        console.log('6️⃣  POSICIONES REAL_OPEN (si existen)');
        console.log('-'.repeat(80));

        const realOpen = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_OPEN')
            .limit(1)
            .get();

        if (realOpen.empty) {
            console.log('  ❌ No hay posiciones REAL_OPEN');
        } else {
            const doc = realOpen.docs[0];
            console.log(`  Posición: ${doc.data().symbol}`);
            console.log(JSON.stringify(doc.data(), null, 2));
        }
        console.log();

        process.exit(0);
    } catch (err) {
        console.error('❌ ERROR:', err);
        console.error(err.stack);
        process.exit(1);
    }
}

diagnosticDeep();
