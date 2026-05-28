const admin = require('firebase-admin');
const Binance = require('binance-api-node').default;
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const serviceAccount = require('./serviceAccountKey.json');
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); }
const PROJECT_ID = 'proypers2025';
async function getBinanceBalance() {
  try {
    console.log('\n🔐 Fetching Binance credentials from Secret Manager...\n');
    const client = new SecretManagerServiceClient({ projectId: PROJECT_ID, keyFilename: './serviceAccountKey.json' });
    const keyPath = client.secretVersionPath(PROJECT_ID, 'binance-spot-api-key', 'latest');
    const [keyVersion] = await client.accessSecretVersion({ name: keyPath });
    const apiKey = keyVersion.payload.data.toString('utf8').trim();
    const secretPath = client.secretVersionPath(PROJECT_ID, 'binance-spot-api-secret', 'latest');
    const [secretVersion] = await client.accessSecretVersion({ name: secretPath });
    const apiSecret = secretVersion.payload.data.toString('utf8').trim();
    console.log('✅ Credentials loaded from Secret Manager\n');
    const binance = Binance({ apiKey: apiKey, apiSecret: apiSecret, baseUrl: 'https://api.binance.com' });
    console.log('💰 BINANCE SPOT ACCOUNT BALANCE\n');
    const account = await binance.accountInfo();
    const balances = account.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
    if (balances.length === 0) { console.log('No balances found.\n'); process.exit(0); }
    console.log('Symbol'.padEnd(12) + 'Free'.padEnd(18) + 'Locked'.padEnd(18) + 'Total');
    console.log('='.repeat(66));
    for (const b of balances) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      const total = free + locked;
      if (total > 0) { console.log(b.asset.padEnd(12) + free.toFixed(8).padEnd(18) + locked.toFixed(8).padEnd(18) + total.toFixed(8)); }
    }
    console.log('\n✅ Balance check complete\n');
    process.exit(0);
  } catch (err) { console.error('❌ Error:', err.message); process.exit(1); }
}
getBinanceBalance();
