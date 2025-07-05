// utils/validar_autonomas.js

const db = require('../firebase-admin-config');
const axios = require('axios');
const { evaluarConfianza } = require('./evaluarConfianza');

async function obtenerPrecioActual(symbol) {
  try {
    const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`);
    const datos = res.data?.chart?.result?.[0];
    const precio = datos?.meta?.regularMarketPrice;
    return precio || null;
  } catch (error) {
    console.error(`Error al obtener precio de ${symbol}:`, error.message);
    return null;
  }
}

async function validarRecomendaciones() {
  const snapshot = await db.collection('consultas')
    .where('tipo', '==', 'autonoma')
    .get();

  if (snapshot.empty) {
    console.log('📭 No hay recomendaciones autónomas para validar.');
    return;
  }

  const ahora = new Date();
  const batch = db.batch();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!data.resultado || !data.resultado.simbolo || data.validado) continue;

    const { simbolo, precio_estimado, precio_actual } = data.resultado;
    const actual = await obtenerPrecioActual(simbolo);

    if (!actual || !precio_actual) continue;

    const acertado = (actual >= precio_estimado);
    const margenError = (((actual - precio_estimado) / precio_estimado) * 100).toFixed(2);

    const validacion = {
      validado: true,
      acierto: acertado,
      precio_final: actual,
      margen_error: parseFloat(margenError),
      fecha_validacion: ahora,
      mensaje: acertado
        ? '✅ La predicción fue acertada o superada.'
        : '❌ La predicción no se cumplió.',
      mensaje_confianza: evaluarConfianza(100 - Math.abs(margenError))
    };

    console.log(`✅ Validando ${simbolo}:`, validacion);

    batch.update(doc.ref, {
  'resultado.validacion': validacion
    });

  }

  await batch.commit();
  console.log('🧾 Validación completada.');
}

module.exports = validarRecomendaciones;



