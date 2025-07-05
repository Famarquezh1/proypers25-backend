// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const cron = require("node-cron");

const consultaRoute = require("./routes/consulta.route");
const proyeccionRoute = require("./routes/proyeccion.route");
const quantumRoutes = require('./routes/quantum.route');
const inversionRoute = require('./routes/inversion.route');
const validarAutonomas = require('./utils/validar_autonomas');
const ejecutarAutoaprendizaje = require('./scripts/autoaprendizaje'); // 👈 nuevo

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

app.use("/api/consultar", consultaRoute);
app.use("/api/stock/proyeccion", proyeccionRoute);
app.use("/api", quantumRoutes);
app.use("/api/inversion", inversionRoute);

// 🔁 Carga Firestore y ejecuta validación si aún no se ha hecho hoy
const db = require('./firebase-admin-config');

(async () => {
  try {
    const docRef = db.collection('configuracion').doc('ultimaValidacionAutonoma');
    const doc = await docRef.get();

    const hoy = new Date().toISOString().split('T')[0];
    const ultimaFecha = doc.exists ? doc.data().fecha : null;

    if (ultimaFecha !== hoy) {
      console.log("🧠 Ejecutando validación de autonómas (no se ha ejecutado hoy)");
      await validarAutonomas();
      await docRef.set({ fecha: hoy });
    } else {
      console.log("✅ Validación ya fue ejecutada hoy. No se repite.");
    }
  } catch (err) {
    console.error("❌ Error al intentar validar autonómas automáticamente:", err);
  }
})();

// 🧠 Autoaprendizaje diario a las 5:00 AM UTC
cron.schedule('0 5 * * *', async () => {
  console.log('🔁 Ejecutando autoaprendizaje diario (5 AM UTC)...');
  try {
    await ejecutarAutoaprendizaje();
  } catch (error) {
    console.error('❌ Error durante autoaprendizaje diario:', error);
  }
});

app.listen(PORT, () => {
  console.log(`✅ API iniciada en http://localhost:${PORT}`);
});


