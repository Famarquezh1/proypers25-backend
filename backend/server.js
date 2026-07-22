console.log('🚀 Iniciando server.js - DEEP HEALTH ENDPOINTS REGISTERED...');

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const cron = require("node-cron");
const crypto = require("crypto");

const consultaRoute = require("./routes/consulta.route");
const proyeccionRoute = require("./routes/proyeccion.route");
const quantumRoutes = require('./routes/quantum.route');
const inversionRoute = require('./routes/inversion.route');
const cronRoute = require('./routes/cron.route');
const controlledRealSpotRoute = require('./routes/controlledRealSpot.route');
const professionalInvestmentsDashboardRoute = require('./routes/professionalInvestmentsDashboard.route');
const investmentsSummaryRoute = require('./routes/investmentsSummary.route');
const spotPortfolioCoverageRoute = require('./routes/spotPortfolioCoverage.route');
const spotPaperRankingRoute = require('./routes/spotPaperRanking.route');
const spotDiscoveryRoute = require('./routes/spotDiscovery.route');
const spotShadowDecisionRoute = require('./routes/spotShadowDecision.route');
const spotQuantResearchRoute = require('./routes/spotQuantResearch.route');
const newSpotAssetDiscoveryRoute = require('./routes/newSpotAssetDiscovery.route');
const spotMarketOpportunityRoute = require('./routes/spotMarketOpportunity.route');
const adaptiveSpotStrategyRoute = require('./routes/adaptiveSpotStrategy.route');
const spotStrategyPromotionRoute = require('./routes/spotStrategyPromotion.route');
const spotCostGovernanceRoute = require('./routes/spotCostGovernance.route');
const systemHealthRoute = require('./routes/systemHealth.route');
const spotLiveDashboardRoute = require('./routes/spotLiveDashboard.route');
const velasCronRoutes = require('./routes/velasCron');
const impulseSchedulerRoute = require('./routes/impulseSchedulerRoute');
const { warmExchangeInfoCache } = require('./lib/binanceFuturesExecutor');

const validarAutonomas = require('./utils/validar_autonomas');
const ejecutarAutoaprendizaje = require('./scripts/autoaprendizaje');
const entrenarLSTM = require('./scripts/entrenamientoLSTM');
const entrenamientoMultiple = require('./scripts/entrenamientoMultiple');
const reevaluarValidacion = require('./scripts/reevaluar_validacion');

const modelosRoute = require('./routes/modelos.route');
const analizarRoute = require('./routes/analizar.route');
const validacionRoute = require('./routes/validacion.route');
const velasRoutes = require('./routes/velas');
const { createDeepHealthRouter } = require('./routes/deep_health_router');
const adminRoute = require('./routes/admin.route');

const app = express();
const PORT = process.env.PORT || 8080;
const CRON_SECRET = process.env.CRON_SECRET || null;
const LEARNING_MODE = process.env.LEARNING_MODE || 'observe';
const LEARNING_LOG = process.env.LEARNING_LOG === 'true';
const EXCHANGE_INFO_WARMUP_ENABLED = String(process.env.EXCHANGE_INFO_WARMUP_ENABLED || 'true').toLowerCase() === 'true';
const EXCHANGE_INFO_WARMUP_INTERVAL_MS = Math.max(60000, Number(process.env.EXCHANGE_INFO_WARMUP_INTERVAL_MS || 15 * 60 * 1000));

const db = require('./firebase-admin-config');

app.use(cors());
app.use(bodyParser.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Cron-Secret, X-Investments-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function safeSecretEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  const sensitivePaths = new Set([
    '/internal/cron/binance/spot-real-execution',
    '/internal/cron/binance/spot-real-exit-preview',
    '/internal/cron/binance/spot-real-execution-dryrun',
    '/internal/cron/binance/spot-real-execution-approve',
    '/cron/binance/spot-real-preflight'
  ]);
  if (req.path === '/internal/cron/binance/spot-real-execution-diagnostic') {
    return res.status(410).json({ ok: false, error: 'Diagnostic endpoint disabled for security' });
  }
  if (!sensitivePaths.has(req.path)) return next();
  if (!CRON_SECRET) return res.status(503).json({ ok: false, error: 'CRON_SECRET not configured' });
  if (!safeSecretEquals(req.header('x-cron-secret'), CRON_SECRET)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  return next();
});

app.use("/api/consultar", consultaRoute);
app.use("/api/stock/proyeccion", proyeccionRoute);
app.use("/api", quantumRoutes);
app.use('/api/inversion', inversionRoute);
app.use('/api/cron', cronRoute);
app.use('/api/modelos', modelosRoute);
app.use("/api", analizarRoute);
app.use('/api/velas', velasRoutes);
app.use('/api/validacion', validacionRoute);
console.log('[Server] Registering deep health router...');
app.use('/api', createDeepHealthRouter(db));
console.log('[Server] Deep health router registered');
app.use('/', professionalInvestmentsDashboardRoute);
app.use('/', investmentsSummaryRoute);
app.use('/', spotPortfolioCoverageRoute);
app.use('/', spotPaperRankingRoute);
app.use('/', spotDiscoveryRoute);
app.use('/', spotShadowDecisionRoute);
app.use('/', spotQuantResearchRoute);
app.use('/', newSpotAssetDiscoveryRoute);
app.use('/', spotMarketOpportunityRoute);
app.use('/', adaptiveSpotStrategyRoute);
app.use('/', spotStrategyPromotionRoute);
app.use('/', spotCostGovernanceRoute);
app.use('/', systemHealthRoute);
app.use('/', spotLiveDashboardRoute);
app.use('/', controlledRealSpotRoute);
app.use('/', velasCronRoutes);
app.use('/', impulseSchedulerRoute);
app.use('/', adminRoute);

app.use((req, res) => {
  console.error('[404] Unhandled route:', req.method, req.path);
  res.status(404).json({ error: 'Route not found', method: req.method, path: req.path, timestamp: new Date() });
});

if (EXCHANGE_INFO_WARMUP_ENABLED) {
  const warmup = async (source) => {
    try {
      const summary = await warmExchangeInfoCache();
      console.log('[EXCHANGE_INFO_WARMUP]', { source, ...summary });
    } catch (err) {
      console.warn('[EXCHANGE_INFO_WARMUP] failed', { source, error: err?.message || err });
    }
  };
  setTimeout(() => warmup('startup'), 1500);
  setInterval(() => warmup('interval'), EXCHANGE_INFO_WARMUP_INTERVAL_MS);
}

function esHorarioHabil() {
  const ahoraUTC = new Date();
  const ahoraNY = new Date(ahoraUTC.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dia = ahoraNY.getDay();
  const hora = ahoraNY.getHours();
  const minutos = ahoraNY.getMinutes();
  const dentroDeHorario = (hora > 9 || (hora === 9 && minutos >= 30)) && (hora < 16);
  return dia >= 1 && dia <= 5 && dentroDeHorario;
}

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

cron.schedule('0 * * * *', async () => {
  if (!esHorarioHabil()) {
    console.log('⏳ Entrenamiento LSTM saltado: fuera de horario hábil.');
    return;
  }
  console.log('🔁 Ejecutando entrenamiento y autoaprendizaje...');
  try {
    await entrenarLSTM('MSFT', 50);
    await ejecutarAutoaprendizaje();
  } catch (error) {
    console.error('❌ Error durante entrenamiento/autoaprendizaje:', error);
  }
});

cron.schedule('15 * * * *', async () => {
  if (!esHorarioHabil()) {
    console.log('⏳ Entrenamiento múltiple saltado: fuera de horario hábil.');
    return;
  }
  console.log('🧠 Entrenamiento múltiple iniciado...');
  try {
    await entrenamientoMultiple();
  } catch (err) {
    console.error('❌ Error durante entrenamiento múltiple:', err);
  }
});

cron.schedule('0 5 * * *', async () => {
  try {
    console.log('🧮 Recalculando métricas de validación histórica...');
    const summary = await reevaluarValidacion();
    console.log('✅ Métricas revaluadas:', summary);
  } catch (error) {
    console.error('🚨 Error recalculando métricas:', error);
  }
});

console.log('📡 Escuchando en el puerto', PORT);
app.listen(PORT, () => console.log(`✅ API iniciada en http://localhost:${PORT}`));