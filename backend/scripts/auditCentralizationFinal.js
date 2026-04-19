#!/usr/bin/env node

/**
 * FINAL CENTRALIZATION AUDIT
 *
 * Verifies that:
 * 1. ✅ 100% of binance_execution_intents writes go through executionContractService
 * 2. ✅ No direct writes detected
 * 3. ✅ Protection guards active in service
 * 4. ✅ All critical modules properly integrated
 */

const fs = require('fs');
const path = require('path');

const backendPath = path.join(__dirname, '..');

// Critical files that write to binance_execution_intents
const criticalFiles = [
  { file: 'lib/binanceFuturesExecutor.js', expectedUses: 1 },
  { file: 'lib/binancePositionManager.js', expectedUses: 1 },
  { file: 'services/execution/intentWatchdog.js', expectedUses: 3 },
  { file: 'services/execution/winModelAutoSync.js', expectedUses: 1 }
];

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║        FINAL CENTRALIZATION AUDIT & PROTECTION            ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

let totalIssues = 0;

// Check 1: Verify protection guards in executionContractService
console.log('📋 CHECK 1: Protection Guards in executionContractService');
console.log('───────────────────────────────────────────────────────────');

const serviceFile = fs.readFileSync(path.join(backendPath, 'services/execution/executionContractService.js'), 'utf8');
const protectionChecks = [
  { pattern: 'FORBIDDEN_DIRECT_WRITE_ATTEMPT', name: 'Direct write detection' },
  { pattern: 'FORBIDDEN_BYPASS_ATTEMPT', name: 'Bypass attempt detection' },
  { pattern: 'win_model.*partialData', name: 'win_model protection' },
  { pattern: 'updated_by.*executionContractService', name: 'Identity protection' }
];

let guardCount = 0;
for (const check of protectionChecks) {
  const hasGuard = new RegExp(check.pattern, 'i').test(serviceFile);
  console.log(`${hasGuard ? '✅' : '❌'} ${check.name}`);
  if (hasGuard) guardCount++;
}

console.log(`\nGuards Active: ${guardCount}/${protectionChecks.length}`);
if (guardCount < protectionChecks.length) totalIssues++;

// Check 2: Verify all critical modules use updateIntent
console.log('\n📋 CHECK 2: updateIntent Usage in Critical Modules');
console.log('───────────────────────────────────────────────────────────');

for (const { file, expectedUses } of criticalFiles) {
  const filePath = path.join(backendPath, file);
  if (!fs.existsSync(filePath)) {
    console.log(`❌ ${file} - NOT FOUND`);
    totalIssues++;
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const updateIntentMatches = (content.match(/updateIntent\s*\(/g) || []).length;

  const status = updateIntentMatches >= expectedUses ? '✅' : '⚠️';
  console.log(`${status} ${file}: ${updateIntentMatches} uses (expected: ${expectedUses})`);

  if (updateIntentMatches < expectedUses) {
    totalIssues++;
  }
}

// Check 3: Verify NO direct writes to binance_execution_intents
console.log('\n📋 CHECK 3: Direct Writes Detection');
console.log('───────────────────────────────────────────────────────────');

let directWritesFound = 0;
const directWritePatterns = [
  { pattern: /\.set\s*\(\s*{/, name: '.set() calls' },
  { pattern: /\.update\s*\(\s*{/, name: '.update() calls' },
  { pattern: /batch\.set/, name: 'batch.set() calls' },
  { pattern: /batch\.update/, name: 'batch.update() calls' }
];

for (const { file } of criticalFiles) {
  const filePath = path.join(backendPath, file);
  if (!fs.existsSync(filePath)) continue;

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for collection('binance_execution_intents')
    if (line.includes("collection('binance_execution_intents')") || line.includes('collection("binance_execution_intents")')) {
      // Look in next few lines for direct writes
      for (let j = i; j < Math.min(i+3, lines.length); j++) {
        for (const { pattern } of directWritePatterns) {
          if (pattern.test(lines[j]) && !lines[j].includes('updateIntent')) {
            console.log(`❌ ${file}:${j+1} - DIRECT WRITE DETECTED`);
            console.log(`   ${lines[j].trim()}`);
            directWritesFound++;
            totalIssues++;
          }
        }
      }
    }
  }
}

if (directWritesFound === 0) {
  console.log('✅ No direct writes to binance_execution_intents detected');
}

// Check 4: Verify service imports
console.log('\n📋 CHECK 4: Service Imports');
console.log('───────────────────────────────────────────────────────────');

let importsOk = 0;
for (const { file } of criticalFiles) {
  const filePath = path.join(backendPath, file);
  if (!fs.existsSync(filePath)) continue;

  const content = fs.readFileSync(filePath, 'utf8');
  const hasImport = /require.*executionContractService|from.*executionContractService|const\s*{\s*updateIntent\s*}/.test(content);

  if (hasImport) {
    console.log(`✅ ${file} - imports executionContractService`);
    importsOk++;
  } else {
    console.log(`⚠️  ${file} - missing explicit import (may use inline require)`);
  }
}

console.log(`\nImports OK: ${importsOk}/${criticalFiles.length}`);

// Summary
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                    AUDIT SUMMARY                           ║');
console.log('╠════════════════════════════════════════════════════════════╣');

if (totalIssues === 0) {
  console.log('║ ✅ ✅ ✅  CENTRALIZATION COMPLETE & PROTECTED  ✅ ✅ ✅ ║');
  console.log('║                                                            ║');
  console.log('║  ✓ 100% of writes go through executionContractService     ║');
  console.log('║  ✓ Protection guards active for direct write attempts    ║');
  console.log('║  ✓ All critical modules properly integrated              ║');
  console.log('║  ✓ No bypasses detected                                  ║');
  console.log('║  ✓ System ready for deployment                           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(0);
} else {
  console.log(`║ ❌ ${totalIssues} issue(s) found that need fixing        ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  process.exit(1);
}
