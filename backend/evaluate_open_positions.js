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

async function evaluateOpenPositions() {
  console.log('🔍 EVALUANDO POSICIONES ABIERTAS\n');

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

    // Get all open positions
    console.log('📋 Buscando posiciones abiertas...\n');
    const openPositions = await db.collection('real_spot_positions')
      .where('status', '==', 'open')
      .get();

    console.log(`Encontradas: ${openPositions.size} posiciones abiertas\n`);

    if (openPositions.empty) {
      console.log('❌ No hay posiciones abiertas para evaluar\n');
      process.exit(0);
    }

    let evaluated = 0;
    let closed = 0;

    for (const posDoc of openPositions.docs) {
      const pos = posDoc.data();
      console.log(`\n📍 Evaluando: ${pos.symbol} (${pos.quantity} @ ${pos.entry_price})`);

      try {
        // Get current price
        const priceResp = await axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${pos.symbol}`);
        const currentPrice = parseFloat(priceResp.data.price);

        console.log(`   Precio actual: ${currentPrice}`);

        // Calculate PnL
        const pnl = (currentPrice - pos.entry_price) * pos.quantity;
        const pnlPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

        console.log(`   PnL: ${pnl.toFixed(2)} USDT (${pnlPct.toFixed(2)}%)`);

        // Check exit conditions
        const tp1Target = pos.targets?.tp1 || (pos.entry_price * 1.03);
        const tp2Target = pos.targets?.tp2 || (pos.entry_price * 1.06);
        const slTarget = pos.targets?.sl || (pos.entry_price * 0.97);

        console.log(`   Targets: TP1=${tp1Target.toFixed(6)}, TP2=${tp2Target.toFixed(6)}, SL=${slTarget.toFixed(6)}`);

        let shouldClose = false;
        let closeReason = '';
        let exitPrice = currentPrice;

        // Check TP1
        if (currentPrice >= tp1Target && !pos.exit_conditions_met?.tp_hit) {
          shouldClose = true;
          closeReason = 'TP1_HIT';
          console.log(`   ⚡ TP1 ALCANZADO! (${tp1Target.toFixed(6)})`);
        }
        // Check TP2
        else if (currentPrice >= tp2Target && !pos.exit_conditions_met?.tp_hit) {
          shouldClose = true;
          closeReason = 'TP2_HIT';
          console.log(`   ⚡ TP2 ALCANZADO! (${tp2Target.toFixed(6)})`);
        }
        // Check SL
        else if (currentPrice <= slTarget && !pos.exit_conditions_met?.sl_hit) {
          shouldClose = true;
          closeReason = 'SL_HIT';
          console.log(`   ❌ STOP LOSS ALCANZADO! (${slTarget.toFixed(6)})`);
        }
        // Check timeout
        else {
          const entryTime = pos.entry_timestamp || 0;
          const ageHours = (Date.now() - entryTime) / (1000 * 60 * 60);
          const timeoutHours = pos.strategy_info?.timeout_hours || 24;
          
          console.log(`   ⏱️  Age: ${ageHours.toFixed(1)}h / Timeout: ${timeoutHours}h`);
          
          if (ageHours >= timeoutHours) {
            shouldClose = true;
            closeReason = 'TIMEOUT';
            console.log(`   ⏰ TIMEOUT ALCANZADO!`);
          } else {
            console.log(`   ✅ Activa - Monitoreo continuo`);
          }
        }

        // Close position if needed
        if (shouldClose) {
          console.log(`   📤 CERRANDO por: ${closeReason}`);
          
          await posDoc.ref.update({
            status: 'closed',
            close_reason: closeReason,
            exit_price: exitPrice,
            exit_timestamp: Date.now(),
            final_pnl_usdt: pnl,
            final_pnl_pct: pnlPct,
            profit_loss: {
              final_pnl_usdt: pnl,
              final_pnl_pct: pnlPct,
              last_calculated: Date.now()
            },
            exit_conditions_met: {
              tp_hit: closeReason === 'TP1_HIT' || closeReason === 'TP2_HIT',
              sl_hit: closeReason === 'SL_HIT',
              timeout: closeReason === 'TIMEOUT'
            }
          });
          
          console.log(`   ✅ Cerrada exitosamente`);
          closed++;
        } else {
          // Update current price and PnL
          await posDoc.ref.update({
            current_price: currentPrice,
            last_update_timestamp: Date.now(),
            profit_loss: {
              current_pnl_usdt: pnl,
              current_pnl_pct: pnlPct,
              last_calculated: Date.now()
            }
          });
          
          console.log(`   💾 PnL actualizado en Firestore`);
        }

        evaluated++;

      } catch (error) {
        console.error(`   ❌ Error evaluando: ${error.message}`);
      }
    }

    console.log(`\n${'═'.repeat(80)}`);
    console.log(`✅ EVALUACIÓN COMPLETADA`);
    console.log(`   Evaluadas: ${evaluated}`);
    console.log(`   Cerradas: ${closed}`);
    console.log(`   Activas: ${evaluated - closed}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }

  process.exit(0);
}

evaluateOpenPositions();
