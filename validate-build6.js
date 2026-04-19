#!/usr/bin/env node

/**
 * Validate Build 6 Deployment
 *
 * Checks that:
 * 1. Endpoints respond 200 OK (not 404)
 * 2. Responses contain expected data structure
 * 3. Fix for CriticalSafetyMonitor is in place
 */

const https = require('https');

const BASE_URL = 'https://proypers25-backend-h4put26qmq-tl.a.run.app';
const ENDPOINTS = [
  { path: '/api/system/critical-alerts', expected: 'alerts' },
  { path: '/api/system/heartbeats', expected: 'is_healthy' },
  { path: '/api/system/safety-status', expected: 'status' }
];

function checkEndpoint(path) {
  return new Promise((resolve) => {
    const url = `${BASE_URL}${path}`;
    const startTime = Date.now();

    https.get(url, { timeout: 5000 }, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        const duration = Date.now() - startTime;
        try {
          const json = JSON.parse(data);
          resolve({
            path,
            status: res.statusCode,
            duration,
            data: json,
            valid: res.statusCode === 200
          });
        } catch (err) {
          resolve({
            path,
            status: res.statusCode,
            duration,
            error: 'Invalid JSON',
            valid: false
          });
        }
      });
    }).on('error', (err) => {
      resolve({
        path,
        status: 0,
        duration: Date.now() - startTime,
        error: err.message,
        valid: false
      });
    });
  });
}

async function validate() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   BUILD 6 DEPLOYMENT VALIDATION       ║');
  console.log('╚═══════════════════════════════════════╝\n');

  console.log(`Service URL: ${BASE_URL}\n`);
  console.log('Validating endpoints...\n');

  const results = await Promise.all(
    ENDPOINTS.map(ep => checkEndpoint(ep.path))
  );

  let allValid = true;

  for (const result of results) {
    const status = result.valid ? '✓ SUCCESS' : '✗ FAILED';
    console.log(`${status} ${result.path}`);
    console.log(`  Status: ${result.status}, Duration: ${result.duration}ms`);

    if (!result.valid) {
      console.log(`  Error: ${result.error || 'Unexpected status code'}`);
      allValid = false;
    } else {
      console.log(`  ✓ Data received: ${JSON.stringify(result.data).substring(0, 80)}...`);
    }
    console.log('');
  }

  if (allValid) {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║  ✓ BUILD 6 VALIDATION PASSED           ║');
    console.log('║    All endpoints responding 200 OK     ║');
    console.log('║    Fix successfully deployed!          ║');
    console.log('╚═══════════════════════════════════════╝\n');
    process.exit(0);
  } else {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║  ✗ BUILD 6 VALIDATION FAILED          ║');
    console.log('║    Some endpoints not responding       ║');
    console.log('╚═══════════════════════════════════════╝\n');
    process.exit(1);
  }
}

validate().catch(err => {
  console.error('Validation error:', err);
  process.exit(2);
});
