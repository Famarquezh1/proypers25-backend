const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!admin.apps.length) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('❌ Error loading service account:', error.message);
    process.exit(1);
  }
}

const db = admin.firestore();

async function checkOpenPositions() {
  console.log('🔍 Verificando posiciones en Firestore...\n');

  try {
    // Get ALL positions (regardless of status)
    const allPositions = await db.collection('real_spot_positions').get();
    
    console.log(`📊 TOTAL POSICIONES EN FIRESTORE: ${allPositions.size}`);
    console.log('═'.repeat(80));

    if (allPositions.empty) {
      console.log('⚠️  No hay posiciones registradas\n');
    } else {
      allPositions.forEach((doc) => {
        const data = doc.data();
        console.log(`\n📍 ID: ${doc.id}`);
        console.log(`   Símbolo: ${data.symbol}`);
        console.log(`   Estrategia: ${data.strategy || 'NO ESPECIFICADA'}`);
        console.log(`   Status: ${data.status || 'DESCONOCIDO'}`);
        console.log(`   Cantidad: ${data.quantity} @ ${data.entry_price} USDT`);
        console.log(`   Entrada: ${new Date(data.entry_timestamp).toLocaleString()}`);
        if (data.exit_timestamp) {
          console.log(`   Salida: ${new Date(data.exit_timestamp).toLocaleString()}`);
        }
        console.log(`   PnL: ${data.pnl_usdt} USDT (${data.pnl_pct}%)`);
        if (data.close_reason) {
          console.log(`   Razón cierre: ${data.close_reason}`);
        }
      });
    }

    // Separate by status
    console.log('\n' + '═'.repeat(80));
    console.log('📈 POSICIONES ABIERTAS (status: open):');
    const openPos = allPositions.docs.filter(doc => doc.data().status === 'open');
    console.log(`   Total: ${openPos.length}`);
    openPos.forEach(doc => {
      const d = doc.data();
      console.log(`   - ${d.symbol}: ${d.quantity} @ ${d.entry_price} USDT`);
    });

    console.log('\n❌ POSICIONES CERRADAS (status: closed):');
    const closedPos = allPositions.docs.filter(doc => doc.data().status === 'closed');
    console.log(`   Total: ${closedPos.length}`);

    console.log('\n⚠️  SIN STATUS O DESCONOCIDO:');
    const unknownPos = allPositions.docs.filter(doc => !doc.data().status || doc.data().status === 'DESCONOCIDO');
    console.log(`   Total: ${unknownPos.length}`);
    unknownPos.forEach(doc => {
      const d = doc.data();
      console.log(`   - ${d.symbol}: ${d.quantity} (status: ${d.status || 'null'})`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
  }

  process.exit(0);
}

checkOpenPositions();
