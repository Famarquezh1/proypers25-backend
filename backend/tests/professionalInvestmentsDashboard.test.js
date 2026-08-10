'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'professionalInvestmentsDashboard.route.js'), 'utf8');

[
  'Vista rápida',
  '¿Cuánto dinero tengo?',
  '¿Cuánto ganó Proypers25?',
  '¿Cuántas adquisiciones administra?',
  '¿El sistema está sano?',
  '¿Qué hizo el bot recientemente?',
  'Resultado Proypers25',
  'Adquisiciones Spot administradas',
  'Fecha compra',
  'Precio compra',
  'Precio actual',
  'Variación',
  'PnL US$',
  'Take Profit',
  'Stop Loss',
  'Resumen de la cuenta Binance',
  'Estado operativo',
  'Holdings reales',
  'Residuo de operación / Dust',
  'Actividad reciente',
  'Conversiones manuales',
  'Estas operaciones NO forman parte del rendimiento del bot',
  'Patrimonio total',
  'Capital máximo administrable',
  'Capacidad libre',
  'Win Rate',
  'Profit Factor',
  'Primera compra',
  'Precio promedio',
  'Ganancia / pérdida',
  'Clasificación',
  'average_price',
  'unrealized_pnl_pct',
  'protection_mode',
  '/internal/investments/summary',
  '/internal/spot-live/evidence'
].forEach((marker) => assert(source.includes(marker), `missing dashboard marker: ${marker}`));

assert(!source.includes('¿Hay posiciones abiertas?'), 'Spot dashboard must not use Futures-style open-position wording');
assert(!source.includes('<h2>Posiciones abiertas</h2>'), 'Spot dashboard must use managed acquisition terminology');
assert(source.includes('liveManaged(l)'), 'dashboard must aggregate all managed Spot acquisitions');
assert(source.includes('dust_residual'), 'dashboard must classify dust residuals');
assert(!source.includes('getBinanceSpotCredentials'), 'dashboard route must not access Binance directly');
assert(!source.includes('firebase-admin-config'), 'dashboard route must not access Firestore directly');
assert(!source.includes('runRealSpotExecutionCycle'), 'dashboard route must not execute trading logic');
assert(!source.includes('reconcileRealSpotAccount'), 'dashboard route must not execute reconciliation');

console.log('professional investments dashboard tests passed');
