// scripts/autoaprendizaje.js
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

if (!admin.apps.length) {
  const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  const credential = fs.existsSync(serviceAccountPath)
    ? admin.credential.cert(require(serviceAccountPath))
    : admin.credential.applicationDefault();
  admin.initializeApp({
    credential
  });
}

const db = admin.firestore();

async function procesarAutoAprendizaje() {
  const prediccionesRef = db.collection('consultas');
  const snapshot = await prediccionesRef.get();

  if (snapshot.empty) {
    console.log('No hay predicciones registradas.');
    return;
  }

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const resultado = data.resultado;
    const validacion = data.validacion || {};

    if (!resultado || resultado.precio_actual === undefined || resultado.precio_estimado === undefined) {
      console.log(`Documento sin datos completos: ${doc.id}`);
      continue;
    }

    const valorReal = parseFloat(resultado.precio_actual);
    const valorPredicho = parseFloat(resultado.precio_estimado);
    const error = valorReal - valorPredicho;
    const acierto = Math.abs(error) < 5;

    let confianza = validacion.confianza || 0.5;
    confianza = acierto ? Math.min(confianza + 0.1, 1.0) : Math.max(confianza - 0.1, 0.0);

    await prediccionesRef.doc(doc.id).update({
      'validacion.error_calculado': error,
      'validacion.acierto': acierto,
      'validacion.confianza': confianza
    });

    console.log(`✅ ${doc.id}: Error=${error.toFixed(2)}, Confianza=${confianza.toFixed(2)}`);
  }
}

// 👇 Exporta la función para poder usarla desde server.js
module.exports = procesarAutoAprendizaje;

