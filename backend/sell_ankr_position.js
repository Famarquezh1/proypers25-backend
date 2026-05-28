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

async function sellANKRPosition() {
  console.log('💰 VENDIENDO POSICIÓN ANKR\n');

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

    // 2. Calculate sale amount
    const quantity = 2774.92;
    const expectedProceeds = quantity * currentPrice;
    console.log(`\n📈 2. Cálculo de venta:`);
    console.log(`   Cantidad: ${quantity} ANKR`);
    console.log(`   Precio: ${currentPrice} USDT`);
    console.log(`   Ingresos esperados: ${expectedProceeds.toFixed(2)} USDT`);

    // 3. Place market sell order
    console.log(`\n📤 3. Ejecutando orden de venta (MARKET SELL)...`);
    
    const timestamp = Date.now();
    const quantityStr = Math.floor(quantity).toString();  // Sin decimales, cantidad entera
    
    // Build params for signature (must match Binance order)
    const params = {
      quantity: quantityStr,
      side: 'SELL',
      symbol: 'ANKRUSDT',
      timestamp: timestamp,
      type: 'MARKET'
    };

    // Create query string (alphabetical order)
    const queryString = Object.entries(params)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    const signature = crypto
      .createHmac('sha256', API_SECRET)
      .update(queryString)
      .digest('hex');

    const signedData = queryString + `&signature=${signature}`;

    const sellResponse = await axios.post(
      'https://api.binance.com/api/v3/order',
      signedData,
      {
        headers: {
          'X-MBX-APIKEY': API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000,
      }
    );

    const orderResult = sellResponse.data;
    console.log(`   ✅ Orden ejecutada exitosamente`);
    console.log(`   Orden ID: ${orderResult.orderId}`);
    console.log(`   Status: ${orderResult.status}`);

    // 4. Parse fills to get actual proceeds
    let actualProceeds = 0;
    if (orderResult.fills && orderResult.fills.length > 0) {
      console.log(`\n📋 4. Detalles de ejecución:`);
      orderResult.fills.forEach((fill, idx) => {
        const fillAmount = parseFloat(fill.qty) * parseFloat(fill.price);
        actualProceeds += fillAmount;
        console.log(`   Fill ${idx + 1}: ${fill.qty} @ ${fill.price} = ${fillAmount.toFixed(4)} USDT`);
      });
    }

    console.log(`\n   💵 Total recibido: ${actualProceeds.toFixed(4)} USDT`);

    // 5. Update Firestore position with sale details
    console.log(`\n💾 5. Actualizando registro en Firestore...`);
    
    const positionRef = db.collection('real_spot_positions').doc('real_spot_pos_1778625900428_ANKRUSDT');
    await positionRef.update({
      liquidation_executed: true,
      liquidation_method: 'MARKET_SELL',
      liquidation_timestamp: Date.now(),
      liquidation_order_id: orderResult.orderId,
      actual_proceeds_usdt: actualProceeds,
      actual_proceeds_timestamp: Date.now(),
      // Calculate net PnL after sale
      net_pnl_after_liquidation: actualProceeds - (quantity * 0.0054) // entry price was 0.0054
    });

    console.log(`   ✅ Registro actualizado`);

    // 6. Summary
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`✅ VENTA COMPLETADA`);
    console.log(`   Cantidad vendida: ${quantity} ANKR`);
    console.log(`   Precio de venta: ${currentPrice} USDT`);
    console.log(`   Total recibido: ${actualProceeds.toFixed(4)} USDT`);
    console.log(`\nEste USDT se suma nuevamente al capital disponible para el próximo ciclo.`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
  }

  process.exit(0);
}

sellANKRPosition();
