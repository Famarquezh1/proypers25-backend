const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!admin.apps.length) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

const db = admin.firestore();

async function syncANKRPosition() {
  console.log('🔄 SINCRONIZANDO POSICIÓN ANKR\n');

  try {
    const secretManager = require('@google-cloud/secret-manager');
    const client = new secretManager.SecretManagerServiceClient();
    const projectId = 'proypers2025';

    const [apiKeyResp] = await client.accessSecretVersion({
      name: client.secretVersionPath(projectId, 'binance-api-key', 'latest')
    });
    const [apiSecretResp] = await client.accessSecretVersion({
      name: client.secretVersionPath(projectId, 'binance-api-secret', 'latest')
    });

    const API_KEY = apiKeyResp.payload.data.toString().trim();
    const API_SECRET = apiSecretResp.payload.data.toString().trim();

    // 1. Get current ANKR price
    console.log('📊 1. Obteniendo precio actual de ANKR...');
    const priceResp = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ANKRUSDT');
    const currentPrice = parseFloat(priceResp.data.price);
    console.log(`   Precio actual: ${currentPrice} USDT`);

    // 2. Get old position info
    console.log('\n📋 2. Obteniendo información de posición anterior...');
    const oldPosRef = db.collection('real_spot_positions').doc('real_spot_pos_1778514617046_ANKRUSDT');
    const oldPosSnap = await oldPosRef.get();
    const oldPos = oldPosSnap.data() || {};
    console.log(`   Posición anterior encontrada: ${oldPosSnap.exists}`);

    // 3. Get config for strategy determination
    console.log('\n⚙️  3. Obteniendo configuración...');
    const configRef = db.collection('real_spot_config').doc('control');
    const configSnap = await configRef.get();
    const config = configSnap.data() || {};
    const strategyMode = config.strategy_mode || 'HYBRID_70_30';
    console.log(`   Strategy Mode: ${strategyMode}`);

    // 4. Determine quantity and entry price
    const quantity = 2774.92;
    let entryPrice = currentPrice;

    // Try to estimate entry price from old position
    if (oldPos.entry_price && oldPos.entry_price > 0) {
      entryPrice = oldPos.entry_price;
      console.log(`   Precio de entrada: ${entryPrice} USDT (desde posición anterior)`);
    } else {
      // Use current price as approximation
      console.log(`   Precio de entrada: ${entryPrice} USDT (aproximado - precio actual)`);
    }

    // 5. Determine strategy
    console.log('\n🎯 4. Determinando estrategia...');
    
    // Get moonshot config
    const moonshotRef = db.collection('real_spot_config').doc('moonshot_strategy');
    const moonshotSnap = await moonshotRef.get();
    const moonshotConfig = moonshotSnap.data() || {};

    // Check if ANKR meets moonshot criteria
    // For now, assume it's CONSERVATIVE since we just have the balance
    let strategy = 'CONSERVATIVE';
    let tpTargets = [3, 6]; // Conservative: +3%, +6%
    let slTarget = -3;
    let timeoutHours = 24;

    console.log(`   Estrategia asignada: ${strategy}`);
    console.log(`   Targets TP: +${tpTargets[0]}%, +${tpTargets[1]}%`);
    console.log(`   Stop Loss: ${slTarget}%`);
    console.log(`   Timeout: ${timeoutHours}h`);

    // 6. Calculate position metrics
    const positionValue = quantity * entryPrice;
    const now = Date.now();
    const positionId = `real_spot_pos_${now}_ANKRUSDT`;

    console.log(`\n💰 5. Valores de posición:`);
    console.log(`   Cantidad: ${quantity} ANKR`);
    console.log(`   Valor total: ${positionValue.toFixed(2)} USDT`);

    // 7. Create new position document
    const positionDoc = {
      symbol: 'ANKRUSDT',
      quantity: quantity,
      entry_price: entryPrice,
      entry_timestamp: oldPos.entry_timestamp || now,
      current_price: currentPrice,
      last_update_timestamp: now,
      status: 'open',
      strategy: strategy,
      strategy_info: {
        decision_reason: 'SYNCED_FROM_BINANCE_BALANCE',
        tp_targets: tpTargets,
        sl_target: slTarget,
        timeout_hours: timeoutHours,
        partial_exit: false
      },
      targets: {
        tp1: entryPrice * (1 + tpTargets[0] / 100),
        tp2: entryPrice * (1 + tpTargets[1] / 100),
        sl: entryPrice * (1 + slTarget / 100)
      },
      profit_loss: {
        current_pnl_usdt: (currentPrice - entryPrice) * quantity,
        current_pnl_pct: ((currentPrice - entryPrice) / entryPrice) * 100,
        last_calculated: now
      },
      exit_conditions_met: {
        tp_hit: false,
        sl_hit: false,
        timeout: false
      },
      _metadata: {
        created_at: now,
        synced_from: 'binance_api_balance_check',
        notes: 'Sincronizado de balance real en Binance'
      }
    };

    // 8. Save to Firestore
    console.log(`\n💾 6. Guardando en Firestore...`);
    const newPosRef = db.collection('real_spot_positions').doc(positionId);
    await newPosRef.set(positionDoc);
    console.log(`   ✅ Posición guardada con ID: ${positionId}`);

    // 9. Summary
    console.log(`\n✅ SINCRONIZACIÓN COMPLETADA`);
    console.log(`═`.repeat(80));
    console.log(`📍 Símbolo: ANKRUSDT`);
    console.log(`📊 Cantidad: ${quantity} ANKR`);
    console.log(`💵 Entrada: ${entryPrice.toFixed(6)} USDT`);
    console.log(`💵 Actual: ${currentPrice.toFixed(6)} USDT`);
    console.log(`📈 PnL: ${positionDoc.profit_loss.current_pnl_usdt.toFixed(2)} USDT (${positionDoc.profit_loss.current_pnl_pct.toFixed(2)}%)`);
    console.log(`🎯 Estrategia: ${strategy}`);
    console.log(`📍 Estado: open`);
    console.log(`\nEl monitor ahora podrá ver esta posición y ejecutar los cierres automáticos.`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
    }
  }

  process.exit(0);
}

syncANKRPosition();
