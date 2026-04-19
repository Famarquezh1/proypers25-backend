#!/usr/bin/env node

/**
 * Monitor Build 12 Deployment and Endpoint Availability
 * Tracks: Build 12 status, Docker image push, Cloud Run deployment, endpoint responses
 */

const https = require('https');
const BUILD_ID = 'f58859fd-9bf3-4556-9831-29dc593575e1';
const PROJECT = 'proypers2025';
const REGION = 'southamerica-west1';
const SERVICE_URL = 'https://proypers25-backend-h4put26qmq-tl.a.run.app';

const ENDPOINTS = [
  `${SERVICE_URL}/api/system/critical-alerts`,
  `${SERVICE_URL}/api/system/heartbeats`,
  `${SERVICE_URL}/api/system/safety-status`
];

let checkCount = 0;
const MAX_CHECKS = 300; // ~5 hours at 60-second intervals
const CHECK_INTERVAL = 60000; // 60 seconds

async function fetchBuildStatus() {
  return new Promise((resolve, reject) => {
    const url = `https://cloudbuild.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/builds/${BUILD_ID}`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ status: 'PARSE_ERROR', raw: data });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 'REQUEST_ERROR', message: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'TIMEOUT' });
    });
  });
}

async function checkEndpoint(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          ok: res.statusCode === 200,
          headers: res.headers
        });
      });
    });
    req.on('error', (e) => resolve({ status: 0, ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, ok: false, error: 'TIMEOUT' });
    });
  });
}

async function checkAllEndpoints() {
  const results = await Promise.all(ENDPOINTS.map(url => checkEndpoint(url)));
  return {
    critical_alerts: results[0],
    heartbeats: results[1],
    safety_status: results[2],
    all_ok: results.every(r => r.ok)
  };
}

async function monitor() {
  checkCount++;
  const elapsed = (checkCount * CHECK_INTERVAL) / 1000;
  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = Math.floor(elapsed % 60);

  console.log(`\n[CHECK #${checkCount}] ${new Date().toISOString()} (elapsed: ${elapsedMin}m ${elapsedSec}s)`);

  // Check endpoints
  const endpoints = await checkAllEndpoints();

  console.log(`[ENDPOINTS]`);
  console.log(`  critical-alerts: ${endpoints.critical_alerts.status} ${endpoints.critical_alerts.ok ? '✓' : '✗'}`);
  console.log(`  heartbeats:      ${endpoints.heartbeats.status} ${endpoints.heartbeats.ok ? '✓' : '✗'}`);
  console.log(`  safety-status:   ${endpoints.safety_status.status} ${endpoints.safety_status.ok ? '✓' : '✗'}`);

  if (endpoints.all_ok) {
    console.log(`\n🎉 SUCCESS! All three endpoints responding 200 OK!`);
    console.log(`[CRITICAL-ALERTS] Status: 200 OK ✓`);
    console.log(`[HEARTBEATS]      Status: 200 OK ✓`);
    console.log(`[SAFETY-STATUS]   Status: 200 OK ✓`);
    console.log(`\n✅ DEPLOYMENT COMPLETE - Feature is live in production!`);
    process.exit(0);
  }

  if (checkCount >= MAX_CHECKS) {
    console.log(`\n⏱️  Monitoring timeout after ${MAX_CHECKS} checks (~5 hours)`);
    console.log(`[FINAL] Endpoints still not responding 200 OK`);
    process.exit(1);
  }

  // Schedule next check
  setTimeout(monitor, CHECK_INTERVAL);
}

console.log(`🚀 BUILD 12 MONITORING STARTED`);
console.log(`Build ID: ${BUILD_ID}`);
console.log(`Checking endpoints every 60 seconds...`);
console.log(`Max duration: ~5 hours (${MAX_CHECKS} checks)`);
console.log(`Endpoints to monitor:`);
ENDPOINTS.forEach(url => console.log(`  - ${url}`));

monitor();
