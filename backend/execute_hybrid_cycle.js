const axios = require('axios');

async function executeHybridCycle() {
  console.log('🚀 EJECUTANDO CICLO HYBRID 70/30\n');

  try {
    const backendUrl = 'https://proypers25-backend-518292923158.southamerica-west1.run.app';
    const endpoint = '/internal/cron/binance/spot-real-execution';
    
    console.log(`📡 Llamando: ${backendUrl}${endpoint}`);
    console.log('📊 Payload: {}');
    console.log('⏳ Esperando respuesta...\n');

    const response = await axios.post(
      `${backendUrl}${endpoint}`,
      {},
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const result = response.data;

    console.log('✅ RESPUESTA RECIBIDA:\n');
    console.log('═'.repeat(80));

    // Display main status
    if (result.ok) {
      console.log('✅ CICLO EJECUTADO EXITOSAMENTE');
    } else {
      console.log('⚠️  CICLO SIN CAMBIOS');
    }

    // Display execution summary
    if (result.execution_report) {
      const exec = result.execution_report;
      console.log(`\n📋 EJECUCIÓN:`);
      console.log(`   Status: ${exec.status}`);
      console.log(`   Mensaje: ${exec.message || 'N/A'}`);
      if (exec.reason) console.log(`   Razón: ${exec.reason}`);
    }

    // Display candidate info
    if (result.candidate) {
      const cand = result.candidate;
      console.log(`\n🎯 CANDIDATO SELECCIONADO:`);
      console.log(`   Símbolo: ${cand.symbol}`);
      console.log(`   Puntuación: ${cand.opportunityScore}`);
      if (cand.lastPrice) console.log(`   Precio: ${cand.lastPrice} USDT`);
      if (cand.priceChangePercent) console.log(`   Cambio 24h: ${cand.priceChangePercent}%`);
    }

    // Display strategy decision
    if (result.strategy_metadata) {
      const strat = result.strategy_metadata;
      console.log(`\n🎲 ESTRATEGIA SELECCIONADA:`);
      console.log(`   Tipo: ${strat.strategy}`);
      console.log(`   Razón: ${strat.decision_reason}`);
      if (strat.tp_targets) {
        console.log(`   Targets TP: ${strat.tp_targets.join(', ')}`);
      }
      if (strat.sl_target) {
        console.log(`   Stop Loss: ${strat.sl_target}%`);
      }
      if (strat.timeout_hours) {
        console.log(`   Timeout: ${strat.timeout_hours}h`);
      }
    }

    // Display execution config
    if (result.execution_config) {
      const exec_config = result.execution_config;
      console.log(`\n⚙️  CONFIGURACIÓN:`);
      console.log(`   Capital: ${exec_config.max_total_capital_usdt} USDT`);
      console.log(`   Por posición: ${exec_config.max_position_usdt} USDT`);
      console.log(`   Mode: ${exec_config.mode}`);
    }

    // Display position if created
    if (result.position_created) {
      const pos = result.position_created;
      console.log(`\n📊 POSICIÓN ABIERTA:`);
      console.log(`   ID: ${pos.position_id}`);
      console.log(`   Símbolo: ${pos.symbol}`);
      console.log(`   Cantidad: ${pos.quantity}`);
      console.log(`   Entrada: ${pos.entry_price} USDT`);
      console.log(`   Valor: ${(pos.quantity * pos.entry_price).toFixed(2)} USDT`);
      console.log(`   Status: ${pos.status}`);
    }

    // Display capital status
    if (result.capital_exposure) {
      const cap = result.capital_exposure;
      console.log(`\n💰 ESTADO CAPITAL:`);
      console.log(`   Total disponible: ${cap.available_for_trading_usdt} USDT`);
      if (cap.conservative_available) {
        console.log(`   Conservative disponible: ${cap.conservative_available} USDT`);
      }
      if (cap.moonshot_available) {
        console.log(`   Moonshot disponible: ${cap.moonshot_available} USDT`);
      }
      if (cap.total_exposed) {
        console.log(`   Total expuesto: ${cap.total_exposed} USDT`);
      }
      if (cap.open_positions_count) {
        console.log(`   Posiciones abiertas: ${cap.open_positions_count}`);
      }
    }

    // Display any errors
    if (result.error) {
      console.log(`\n❌ ERROR: ${result.error}`);
    }

    // Display raw timestamp
    if (result.timestamp) {
      console.log(`\n⏰ Timestamp: ${new Date(result.timestamp).toLocaleString()}`);
    }

    console.log('\n' + '═'.repeat(80));

  } catch (error) {
    console.error('❌ ERROR EN CICLO:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
  }

  process.exit(0);
}

executeHybridCycle();
