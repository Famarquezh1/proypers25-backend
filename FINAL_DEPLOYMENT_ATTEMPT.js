#!/usr/bin/env node
/**
 * FINAL DEPLOYMENT ATTEMPT
 * Direct Cloud Run Service Update via Node.js
 * Bypassing gcloud CLI and Cloud Build entirely
 */

const https = require('https');
const fs = require('fs');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const PROJECT = 'proypers2025';
const SERVICE = 'proypers25-backend';
const REGION = 'southamerica-west1';
const IMAGE = 'southamerica-west1-docker.pkg.dev/proypers2025/backend-repo/backend-image:latest';

console.log('════════════════════════════════════════════════════');
console.log('FINAL DEPLOYMENT ATTEMPT - Direct API Method');
console.log('════════════════════════════════════════════════════');
console.log(`Project: ${PROJECT}`);
console.log(`Service: ${SERVICE}`);
console.log(`Region: ${REGION}`);
console.log(`Image: ${IMAGE}`);
console.log('');

/**
 * Get GCP access token
 */
async function getAccessToken() {
  try {
    console.log('📍 Step 1: Getting GCP access token...');
    const { stdout } = await exec('gcloud auth print-access-token 2>&1');
    const token = stdout.trim();
    if (!token || token.length < 10) {
      throw new Error(`Invalid token received: ${token.substring(0, 50)}`);
    }
    console.log(`✓ Token obtained (length: ${token.length})`);
    return token;
  } catch (err) {
    console.error('✗ Error getting token:', err.message);
    throw err;
  }
}

/**
 * Update Cloud Run service with new image
 */
async function updateCloudRunService(token) {
  return new Promise((resolve, reject) => {
    console.log('');
    console.log('📍 Step 2: Updating Cloud Run service...');
    console.log(`   URL: https://run.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}`);

    const updatePayload = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'autoscaling.knative.dev/minScale': '1',
              'autoscaling.knative.dev/maxScale': '100'
            }
          },
          spec: {
            containers: [
              {
                image: IMAGE,
                ports: [
                  { name: 'http1', containerPort: 8080 }
                ],
                env: [
                  { name: 'PORT', value: '8080' },
                  { name: 'NODE_ENV', value: 'production' }
                ],
                resources: {
                  limits: {
                    cpu: '2',
                    memory: '2Gi'
                  }
                }
              }
            ],
            serviceAccountName: 'default'
          }
        }
      }
    };

    const payload = JSON.stringify(updatePayload);
    console.log(`   Payload size: ${payload.length} bytes`);

    const options = {
      hostname: 'run.googleapis.com',
      port: 443,
      path: `/v1/projects/${PROJECT}/locations/${REGION}/services/${SERVICE}?updateMask=spec.template.spec.containers[0].image`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'NodeJS-CloudRunClient/1.0'
      },
      timeout: 30000
    };

    console.log(`   Method: ${options.method} ${options.path}`);

    const req = https.request(options, (res) => {
      let data = '';
      console.log(`   Response status: ${res.statusCode}`);

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('✓ UPDATE SUCCESSFUL');
            const response = JSON.parse(data);
            console.log(`   Service updated at: ${response.metadata?.updateTime}`);
            resolve(response);
          } else {
            console.error(`✗ UPDATE FAILED with status ${res.statusCode}`);
            console.error('Response:', data.substring(0, 500));
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`✗ Request error: ${err.message}`);
      reject(err);
    });

    req.on('timeout', () => {
      console.error('✗ Request timeout');
      req.abort();
      reject(new Error('Request timeout'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Main execution
 */
async function main() {
  try {
    const token = await getAccessToken();
    const result = await updateCloudRunService(token);

    console.log('');
    console.log('════════════════════════════════════════════════════');
    console.log('✓ DEPLOYMENT INITIATED SUCCESSFULLY');
    console.log('════════════════════════════════════════════════════');
    console.log('');
    console.log('Service update in progress. Expected time: 3-5 minutes');
    console.log('');
    console.log('To verify completion, run:');
    console.log(`  curl https://proypers25-backend-h4put26qmq-tl.a.run.app/api/system/critical-alerts`);
    console.log('');
    console.log('Expected response: 200 OK (not 404)');

    return true;
  } catch (err) {
    console.log('');
    console.log('════════════════════════════════════════════════════');
    console.log('✗ DEPLOYMENT FAILED');
    console.log('════════════════════════════════════════════════════');
    console.error('Error:', err.message);
    return false;
  }
}

main().then(success => {
  process.exit(success ? 0 : 1);
});
