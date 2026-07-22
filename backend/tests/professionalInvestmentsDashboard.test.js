'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'professionalInvestmentsDashboard.route.js'), 'utf8');

[
  'Vista rápida',
  '¿Cuánto dinero tengo?',
  '¿Cuánto ganó Proypers25?',
  '¿Hay posiciones abiertas?',
  '¿El sistema está sano?',
  '¿Qué hizo el bot recientemente?',
  'Resultado Proypers25',
  'Resumen de la cuenta Binance',
  'Estado operativo',
  'Holdings reales',
  'Actividad reciente',
  'Conversiones manuales',
  'Estas operaciones NO forman parte del rendimiento del bot',
  'Patrimonio total',
  'Capital asignado',
  'Win Rate',
  'Profit Factor',
  'Primera compra',
  'Precio promedio',
  'Precio actual',
  'Ganancia / pérdida',
  'Gestionado por Proypers25',
  'average_cost_usdt',
  'current_price_usdt',
  'return_pct',
  '/internal/investments/summary',
  '/internal/spot-live/evidence'
].forEach((marker) => assert(source.includes(marker), `missing dashboard marker: ${marker}`));

assert(!source.includes('getBinanceSpotCredentials'), 'dashboard route must not access Binance directly');
assert(!source.includes('firebase-admin-config'), 'dashboard route must not access Firestore directly');
assert(!source.includes('runRealSpotExecutionCycle'), 'dashboard route must not execute trading logic');
assert(!source.includes('reconcileRealSpotAccount'), 'dashboard route must not execute reconciliation');

console.log('professional investments dashboard tests passed');
