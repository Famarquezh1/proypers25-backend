#!/usr/bin/env node

/**
 * DEPLOYMENT FINAL MONITORING
 *
 * Monitors all 3 critical endpoints until they all respond 200 OK
 * This confirms Build 9 has deployed successfully
 */

const https = require('https');

const BASE_URL = 'https://proypers25-backend-h4put26qmq-tl.a.run.app/api';

const ENDPOINTS = [
  { path: '/system/critical-alerts', name: 'Critical Alerts' },
  { path: '/system/heartbeats', name: 'System Heartbeats' },
  { path: '/system/safety-status', name: 'Safety Status' }
];

let checkNumber = 0;
const START_TIME = Date.now();
const MAX_CHECKS = 300; // 5 hours worth of 60-second intervals

async function testEndpoint(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          ok: res.statusCode === 200,
          contentLength: data.length
        });
      });
    }).on('error', (err) => {
      resolve({
        status: 0,
        ok: false,
        error: err.message
      });
    });
  });
}

async function runCheck() {
  checkNumber++;
  const elapsed = Math.floor((Date.now() - START_TIME) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timestamp = new Date().toLocaleTimeString();

  console.log(`\n[${timestamp}] CHECK #${checkNumber}/${MAX_CHECKS} (${minutes}m ${seconds}s elapsed)`);
  console.log('────────────────────────────────────────────────────────');

  let allPass = true;
  const results = [];

  for (const endpoint of ENDPOINTS) {
    const result = await testEndpoint(BASE_URL + endpoint.path);
    results.push(result);
    const statusMsg = result.ok ? '✓ 200 OK' : `✗ ${result.status || 'ERROR'}`;
    console.log(`${statusMsg.padEnd(15)} ${endpoint.name}`);
    if (!result.ok) allPass = false;
  }

  if (allPass) {
    console.log('\n✅ ✅ ✅ ALL ENDPOINTS RESPONDING 200 OK! ✅ ✅ ✅');
    console.log(`\n🎉 DEPLOYMENT SUCCESSFUL - Build 9 is live!`);
    console.log(`Total time: ${minutes}m ${seconds}s`);
    process.exit(0);
  }

  if (checkNumber >= MAX_CHECKS) {
    console.log('\n❌ Maximum checks reached (5 hours)');
    console.log('Build 9 has not deployed successfully.');
    process.exit(1);
  }

  // Wait 60 seconds before next check
  setTimeout(runCheck, 60000);
}

console.log('🚀 DEPLOYMENT FINAL MONITORING - Build 9');
console.log('================================================');
console.log('Monitoring for 3 critical endpoints');
console.log('Will check every 60 seconds up to 5 hours');
console.log('Expected: All endpoints return 200 OK');
console.log('================================================\n');

runCheck();
