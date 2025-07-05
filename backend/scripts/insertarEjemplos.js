const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

// Inicializar Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function insertarEjemplos() {
  const ejemplos = [
    {
      simbolo: 'AAPL',
      resultado: { precio_estimado: 192.25, precio_actual: 195.50 },
      fecha_consulta: new Date().toISOString()
    },
    {
      simbolo: 'GOOGL',
      resultado: { precio_estimado: 2710.00, precio_actual: 2708.00 },
      fecha_consulta: new Date().toISOString()
    },
    {
      simbolo: 'MSFT',
      resultado: { precio_estimado: 315.80, precio_actual: 315.20 },
      fecha_consulta: new Date().toISOString()
    },
    {
      simbolo: 'TSLA',
      resultado: { precio_estimado: 850.00, precio_actual: 870.00 },
      fecha_consulta: new Date().toISOString()
    },
    {
      simbolo: 'AMZN',
      resultado: { precio_estimado: 128.00, precio_actual: 125.00 },
      fecha_consulta: new Date().toISOString()
    }
  ];

  for (const ejemplo of ejemplos) {
    const docRef = await db.collection('consultas').add(ejemplo);
    console.log(`📌 Documento creado: ${docRef.id}`);
  }

  console.log('✅ Inserción completada.');
  process.exit(0);
}

insertarEjemplos().catch(err => {
  console.error('❌ Error al insertar:', err);
  process.exit(1);
});
