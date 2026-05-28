const admin = require('firebase-admin');
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

async function executeHybridLocally() {
  console.log('🚀 EJECUTANDO CICLO HYBRID LOCALMENTE\n');

  try {
    // 1. Get config
    console.log('⚙️  1. Cargando configuración...');
    const configRef = db.collection('real_spot_config').doc('control');
    const configSnap = await configRef.get();
    const config = configSnap.data() || {};
    
    console.log(`   Estrategia: ${config.strategy_mode}`);
    console.log(`   Enabled: ${config.enabled}`);
    console.log(`   Kill Switch: ${config.kill_switch}`);

    // 2. Get best candidate
    console.log('\n🎯 2. Obteniendo mejor candidato...');
    const candidateSnap = await db.collection('spot_opportunity_candidates')
      .orderBy('opportunityScore', 'desc')
      .limit(1)
      .get();

    if (candidateSnap.empty) {
      console.log('   ❌ No hay candidatos disponibles');
      process.exit(0);
    }

    const candidate = candidateSnap.docs[0].data();
    const candidateId = candidateSnap.docs[0].id;
    
    console.log(`   Símbolo: ${candidate.symbol}`);
    console.log(`   Score: ${candidate.opportunityScore}`);
    console.log(`   Precio: ${candidate.price}`);
    console.log(`   Volumen 24h: ${candidate.quoteVolume24h}`);

    // 3. Determine strategy (CONSERVATIVE por defecto)
    console.log('\n🎲 3. Determinando estrategia...');
    
    let strategy = 'CONSERVATIVE';
    let tpTargets = [3, 6];
    let slTarget = 3;
    let timeoutHours = 24;
    
    // Para este ciclo: usar CONSERVATIVE (más simple)
    console.log(`   Estrategia: ${strategy}`);
    console.log(`   Razón: CICLO_MANUAL`);
    console.log(`   Targets TP: ${tpTargets[0]}%, ${tpTargets[1]}%`);
    console.log(`   Stop Loss: -${slTarget}%`);

    // 4. Get available capital
    console.log('\n💰 4. Verificando capital disponible...');
    const allPositions = await db.collection('real_spot_positions')
      .where('status', '==', 'open')
      .get();

    let conservativeUsed = 0;
    let moonshotUsed = 0;

    allPositions.forEach(doc => {
      const pos = doc.data();
      const posValue = (pos.quantity || 0) * (pos.entry_price || 0);
      if (pos.strategy === 'MOONSHOT') {
        moonshotUsed += posValue;
      } else {
        conservativeUsed += posValue;
      }
    });

    const conservativeAvail = config.conservative_capital_usdt - conservativeUsed;
    const moonshotAvail = config.moonshot_capital_usdt - moonshotUsed;

    console.log(`   Conservative: ${conservativeAvail.toFixed(2)} USDT disponible`);
    console.log(`   Moonshot: ${moonshotAvail.toFixed(2)} USDT disponible`);
    console.log(`   Posiciones abiertas: ${allPositions.size}`);

    // 5. Determine position size
    let positionSize = config.max_position_usdt || 15;
    const availableForStrategy = strategy === 'MOONSHOT' ? moonshotAvail : conservativeAvail;
    
    if (positionSize > availableForStrategy) {
      positionSize = Math.min(availableForStrategy, 15);
    }

    console.log(`\n📊 5. Tamaño de posición: ${positionSize} USDT`);

    // 6. Create position
    console.log(`\n💾 6. Creando posición en Firestore...`);
    
    const now = Date.now();
    const positionId = `real_spot_pos_${now}_${candidate.symbol}`;
    const entryPrice = candidate.price;
    const quantity = positionSize / entryPrice;

    const positionDoc = {
      symbol: candidate.symbol,
      quantity: quantity,
      entry_price: entryPrice,
      entry_timestamp: now,
      current_price: entryPrice,
      status: 'open',
      strategy: strategy,
      strategy_info: {
        decision_reason: 'MANUAL_EXECUTION',
        tp_targets: tpTargets,
        sl_target: -slTarget,
        timeout_hours: timeoutHours,
        partial_exit: false
      },
      targets: {
        tp1: entryPrice * (1 + tpTargets[0] / 100),
        tp2: entryPrice * (1 + tpTargets[1] / 100),
        sl: entryPrice * (1 - slTarget / 100)
      },
      profit_loss: {
        current_pnl_usdt: 0,
        current_pnl_pct: 0,
        last_calculated: now
      },
      exit_conditions_met: {
        tp_hit: false,
        sl_hit: false,
        timeout: false
      }
    };

    await db.collection('real_spot_positions').doc(positionId).set(positionDoc);
    console.log(`   ✅ Posición creada: ${positionId}`);

    // 7. Summary
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`✅ CICLO EJECUTADO EXITOSAMENTE`);
    console.log(`\n📍 POSICIÓN ABIERTA:`);
    console.log(`   Símbolo: ${candidate.symbol}`);
    console.log(`   Cantidad: ${quantity.toFixed(8)}`);
    console.log(`   Entrada: ${entryPrice} USDT`);
    console.log(`   Valor: ${positionSize.toFixed(2)} USDT`);
    console.log(`   Estrategia: ${strategy}`);
    console.log(`   Targets TP: +${tpTargets[0]}%, +${tpTargets[1]}%`);
    console.log(`   Stop Loss: -${slTarget}%`);
    console.log(`   Timeout: ${timeoutHours}h`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

executeHybridLocally();
