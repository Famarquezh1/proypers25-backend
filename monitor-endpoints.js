// Monitor endpoints until they respond with 200
const https = require('https');

const endpoints = [
  'https://proypers25-backend-h4put26qmq-tl.a.run.app/api/system/critical-alerts?limit=1',
  'https://proypers25-backend-h4put26qmq-tl.a.run.app/api/system/heartbeats?limit=1',
  'https://proypers25-backend-h4put26qmq-tl.a.run.app/api/system/deep-health'
];

async function checkEndpoints() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Checking endpoints...\n`);
  
  let allWorking = true;
  
  for (const url of endpoints) {
    const name = url.split('/api/system/')[1].split('?')[0] || 'deep-health';
    
    return new Promise((resolve) => {
      https.get(url, { timeout: 5000 }, (res) => {
        const status = res.statusCode === 200 ? '✓ 200 OK' : `✗ ${res.statusCode}`;
        console.log(`  ${name.padEnd(20)} ${status}`);
        if (res.statusCode !== 200) allWorking = false;
        resolve();
      }).on('error', (err) => {
        console.log(`  ${name.padEnd(20)} ✗ ${err.message}`);
        allWorking = false;
        resolve();
      });
    });
  }
  
  if (allWorking) {
    console.log('\n✓ ALL ENDPOINTS WORKING! Deployment successful.\n');
    process.exit(0);
  }
}

let attempts = 0;
const maxAttempts = 120; // 1 hour with 30s intervals

async function monitor() {
  attempts++;
  console.log(`Attempt ${attempts}/${maxAttempts}`);
  
  for (const url of endpoints) {
    const name = url.split('/api/system/')[1].split('?')[0] || 'deep-health';
    
    await new Promise((resolve) => {
      https.get(url, { timeout: 5000 }, (res) => {
        const status = res.statusCode === 200 ? '✓ 200 OK' : `✗ ${res.statusCode}`;
        console.log(`  ${name.padEnd(20)} ${status}`);
        if (res.statusCode === 200 && name !== 'deep-health') {
          // We found a working new endpoint!
          console.log('\n✓ NEW ENDPOINTS LIVE!');
          process.exit(0);
        }
        resolve();
      }).on('error', (err) => {
        console.log(`  ${name.padEnd(20)} ✗ ${err.message}`);
        resolve();
      });
    });
  }
  
  if (attempts < maxAttempts) {
    console.log('Waiting 30s...\n');
    setTimeout(monitor, 30000);
  } else {
    console.log('\nMax attempts reached');
    process.exit(1);
  }
}

monitor();
