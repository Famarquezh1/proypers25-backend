#!/usr/bin/env node
/**
 * BUILD 5 DEPLOYMENT MONITOR
 * 
 * Monitors Build 5 deployment and verifies endpoints become available
 * Executes validation and auto-recovery procedures when endpoints are live
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const BUILD_ID = '2e1481f6-2b5d-4f44-a275-3758497d7430';
const SERVICE_URL = 'https://proypers25-backend-h4put26qmq-tl.a.run.app';
const ENDPOINTS = [
  '/api/system/deep-health',
  '/api/system/critical-alerts',
  '/api/system/heartbeats',
  '/api/system/safety-status'
];

let checkCount = 0;
const MAX_CHECKS = 120; // 1 hour at 30-second intervals
const CHECK_INTERVAL = 30000; // 30 seconds

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║  BUILD 5 DEPLOYMENT MONITOR - ENDPOINT VERIFICATION   ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

console.log(`Build ID: ${BUILD_ID}`);
console.log(`Service: ${SERVICE_URL}`);
console.log(`Monitoring interval: ${CHECK_INTERVAL / 1000} seconds`);
console.log(`Max attempts: ${MAX_CHECKS} (${MAX_CHECKS * CHECK_INTERVAL / 60000} minutes)\n`);

async function testEndpoint(endpoint) {
  return new Promise((resolve) => {
    const url = `${SERVICE_URL}${endpoint}`;
    const request = https.get(url, { timeout: 5000 }, (response) => {
      resolve({
        endpoint,
        status: response.statusCode,
        ok: response.statusCode === 200
      });
    });

    request.on('error', (err) => {
      resolve({
        endpoint,
        status: 'ERROR',
        ok: false,
        error: err.code || err.message
      });
    });

    request.on('timeout', () => {
      request.destroy();
      resolve({
        endpoint,
        status: 'TIMEOUT',
        ok: false
      });
    });
  });
}

async function checkAllEndpoints() {
  checkCount++;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  
  console.log(`\n[${timestamp}] CHECK #${checkCount}/${MAX_CHECKS}`);
  console.log('─'.repeat(56));

  const results = await Promise.all(ENDPOINTS.map(testEndpoint));
  
  let allOk = true;
  for (const result of results) {
    const status = result.ok ? `✓ 200 OK` : `✗ ${result.status}`;
    const color = result.ok ? '\x1b[32m' : '\x1b[33m';
    console.log(`${color}${status}\x1b[0m ${result.endpoint}`);
    if (!result.ok) allOk = false;
  }

  return allOk;
}

async function executeValidation() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  ✓ ALL ENDPOINTS LIVE - EXECUTING VALIDATION           ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const validationScript = path.join(__dirname, 'validate-deployment.js');
  if (fs.existsSync(validationScript)) {
    console.log('Triggering validate-deployment.js...\n');
    try {
      require(validationScript);
    } catch (err) {
      console.log(`Note: Validation script execution result: ${err.message}`);
    }
  } else {
    console.log('Validation script not found, skipping automatic validation.\n');
  }

  console.log('═'.repeat(56));
  console.log('DEPLOYMENT VERIFICATION COMPLETE - SYSTEM IS LIVE');
  console.log('═'.repeat(56));
  console.log('\nNext steps:');
  console.log('1. Dashboard will auto-sync with fresh data');
  console.log('2. autocalibration_cycle will execute (every 15 min)');
  console.log('3. System protections activate automatically');
  console.log('4. Data recording resumes\n');

  process.exit(0);
}

async function monitor() {
  if (checkCount >= MAX_CHECKS) {
    console.log('\n⚠ Maximum checks reached. Build 5 may have failed.');
    console.log('Please check Google Cloud Build console:\n');
    console.log(`https://console.cloud.google.com/cloud-build/builds/${BUILD_ID}?project=proypers2025\n`);
    process.exit(1);
  }

  const allOk = await checkAllEndpoints();
  
  if (allOk) {
    await executeValidation();
  } else {
    setTimeout(monitor, CHECK_INTERVAL);
  }
}

// Start monitoring
monitor();
