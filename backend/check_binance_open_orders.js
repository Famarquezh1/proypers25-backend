const admin = require('firebase-admin');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

// Initialize Firebase
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!admin.apps.length) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('❌ Error loading service account:', error.message);
    process.exit(1);
  }
}

const db = admin.firestore();

async function getOpenOrdersFromBinance() {
  console.log('🔍 Verificando posiciones abiertas en BINANCE...\n');

  try {
    // Get Binance credentials from Firestore
    const secretManager = require('@google-cloud/secret-manager');
    const client = new secretManager.SecretManagerServiceClient();

    // Get API Key and Secret from Google Secret Manager
    const projectId = 'proypers2025';
    const apiKeyName = client.secretVersionPath(projectId, 'binance-api-key', 'latest');
    const apiSecretName = client.secretVersionPath(projectId, 'binance-api-secret', 'latest');

    const [apiKeyResponse] = await client.accessSecretVersion({name: apiKeyName});
    const [apiSecretResponse] = await client.accessSecretVersion({name: apiSecretName});

    const API_KEY = apiKeyResponse.payload.data.toString().trim();
    const API_SECRET = apiSecretResponse.payload.data.toString().trim();

    const baseUrl = 'https://api.binance.com';
    const timestamp = Date.now();
    const recvWindow = 5000;

    // Create query string for GET /api/v3/openOrders
    const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    
    // Create HMAC signature
    const signature = crypto
      .createHmac('sha256', API_SECRET)
      .update(queryString)
      .digest('hex');

    const fullUrl = `${baseUrl}/api/v3/openOrders?${queryString}&signature=${signature}`;

    console.log('📡 Llamando a GET /api/v3/openOrders...\n');

    const response = await axios.get(fullUrl, {
      headers: {
        'X-MBX-APIKEY': API_KEY,
      },
      timeout: 10000,
    });

    const orders = response.data;

    if (!orders || orders.length === 0) {
      console.log('❌ NO HAY ÓRDENES ABIERTAS EN BINANCE SPOT');
      console.log('\n📊 Resumen:');
      console.log('   Total órdenes abiertas: 0');
      console.log('\n⚠️  PERO TÚ DIJISTE QUE ERES UNA POSICIÓN ABIERTA!');
      console.log('   Posibles causas:');
      console.log('   1. La orden ya se ejecutó y se cerró');
      console.log('   2. Se canceló automáticamente');
      console.log('   3. Confusión entre órdenes y posiciones');
    } else {
      console.log(`✅ ÓRDENES ABIERTAS ENCONTRADAS: ${orders.length}\n`);
      
      orders.forEach((order, idx) => {
        console.log(`📍 Orden ${idx + 1}:`);
        console.log(`   Símbolo: ${order.symbol}`);
        console.log(`   Lado: ${order.side}`);
        console.log(`   Tipo: ${order.type}`);
        console.log(`   Cantidad: ${order.origQty}`);
        console.log(`   Precio: ${order.price} USDT`);
        console.log(`   Estado: ${order.status}`);
        console.log(`   Ejecutada: ${order.executedQty}`);
        console.log(`   Pendiente: ${parseFloat(order.origQty) - parseFloat(order.executedQty)}`);
        console.log(`   Timestamp: ${new Date(order.time).toLocaleString()}\n`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
  }

  process.exit(0);
}

getOpenOrdersFromBinance();
