#!/usr/bin/env node

/**
 * CENTRALIZATION VALIDATION AUDIT
 *
 * Validates that ALL binance_execution_intents writes go through
 * executionContractService.updateIntent()
 *
 * Run: node backend/scripts/validateCentralizationComplete.js
 */

const fs = require('fs');
const path = require('path');

const backendPath = path.join(__dirname, '..');

// Files that should use executionContractService
const criticalFiles = [
  'lib/binanceFuturesExecutor.js',
  'lib/binancePositionManager.js',
  'services/execution/intentWatchdog.js',
  'services/execution/winModelAutoSync.js'
];

// Patterns that indicate direct writes to binance_execution_intents (FORBIDDEN)
const forbiddenPatterns = [
  {
    pattern: /\.ref\.set\s*\(/,
    context: /binance_execution_intents/
  },
  {
    pattern: /\.ref\.update\s*\(/,
    context: /binance_execution_intents/
  },
  {
    pattern: /batch\.update\s*\(/,
    context: /binance_execution_intents/
  },
  {
    pattern: /batch\.set\s*\(/,
    context: /binance_execution_intents/
  }
];

// Pattern that indicates centralized write (ALLOWED)
const allowedPattern = /updateIntent\s*\(/;
const serviceImportPattern = /require\s*\(\s*['"](\.\.\/)*services\/execution\/executionContractService['"]|from\s+['"].*executionContractService['"]|const\s*{\s*updateIntent\s*}\s*=\s*require/;

function checkFile(filePath) {
  const fullPath = path.join(backendPath, filePath);

  if (!fs.existsSync(fullPath)) {
    return {
      file: filePath,
      exists: false,
      error: 'File not found'
    };
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');

  const result = {
    file: filePath,
    exists: true,
    hasServiceImport: serviceImportPattern.test(content),
    forbiddenMatches: [],
    allowedMatches: [],
    totalLines: lines.length,
    issues: []
  };

  // Build a map of which lines contain 'binance_execution_intents'
  const executionIntentLines = new Set();
  lines.forEach((line, idx) => {
    if (/binance_execution_intents/.test(line)) {
      executionIntentLines.add(idx);
      // Also add nearby lines to catch patterns split across lines
      if (idx > 0) executionIntentLines.add(idx - 1);
      if (idx < lines.length - 1) executionIntentLines.add(idx + 1);
    }
  });

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // Check for forbidden patterns - only in context of binance_execution_intents
    forbiddenPatterns.forEach((item) => {
      if (item.pattern.test(line) && executionIntentLines.has(idx)) {
        // Check if this line is inside a comment
        const isComment = line.trim().startsWith('//') || line.trim().startsWith('/*');

        if (!isComment) {
          result.forbiddenMatches.push({
            line: lineNum,
            code: line.trim()
          });
          result.issues.push(`Line ${lineNum}: Found direct write to binance_execution_intents: ${item.pattern.source}`);
        }
      }
    });

    // Track allowed patterns
    if (allowedPattern.test(line)) {
      result.allowedMatches.push({
        line: lineNum,
        code: line.trim()
      });
    }
  });

  return result;
}

function validateCentralization() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          CENTRALIZATION VALIDATION AUDIT                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let allGood = true;
  const summary = [];

  for (const filePath of criticalFiles) {
    const result = checkFile(filePath);

    console.log(`\n📄 ${result.file}`);
    console.log('─'.repeat(60));

    if (!result.exists) {
      console.log(`❌ ERROR: File not found`);
      allGood = false;
      continue;
    }

    // Check import (at module level or inline)
    if (!result.hasServiceImport) {
      // Also check if updateIntent is used despite import not at top level
      if (result.allowedMatches.length > 0) {
        console.log(`✅ Uses updateIntent (inline require detected)`);
      } else {
        console.log(`⚠️  WARNING: Missing executionContractService import`);
        result.issues.push('Missing required import');
        // Don't mark as complete failure if updateIntent is used elsewhere
      }
    } else {
      console.log(`✅ Has executionContractService import`);
    }

    // Check for forbidden patterns
    if (result.forbiddenMatches.length > 0) {
      console.log(`\n❌ FORBIDDEN WRITES DETECTED: ${result.forbiddenMatches.length}`);
      result.forbiddenMatches.forEach((match) => {
        console.log(`   Line ${match.line}: ${match.code.substring(0, 60)}...`);
      });
      allGood = false;
    } else {
      console.log(`✅ No direct writes to binance_execution_intents detected`);
    }

    // Check for allowed patterns
    console.log(`\n✅ Uses updateIntent: ${result.allowedMatches.length} times`);
    result.allowedMatches.slice(0, 5).forEach((match) => {
      console.log(`   Line ${match.line}: ${match.code.substring(0, 50)}...`);
    });

    if (result.allowedMatches.length > 5) {
      console.log(`   ... and ${result.allowedMatches.length - 5} more`);
    }

    summary.push({
      file: result.file,
      import: result.hasServiceImport ? '✅' : (result.allowedMatches.length > 0 ? '🟡' : '❌'),
      forbidden: result.forbiddenMatches.length,
      allowed: result.allowedMatches.length,
      issues: result.issues.length
    });
  }

  // Print summary table
  console.log('\n\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                     SUMMARY TABLE                          ║');
  console.log('╠════════════════════════════════════════════════════════════╣');

  const maxFileLen = Math.max(...summary.map((s) => s.file.length));

  summary.forEach((row) => {
    const fileName = row.file.padEnd(maxFileLen);
    console.log(
      `║ ${fileName}  ${row.import}  Forbidden: ${String(row.forbidden).padStart(2)}  Allowed: ${String(row.allowed).padStart(2)}  Issues: ${row.issues} ║`
    );
  });

  console.log('╠════════════════════════════════════════════════════════════╣');

  const forbiddenCount = summary.reduce((sum, s) => sum + s.forbidden, 0);
  const allowedCount = summary.reduce((sum, s) => sum + s.allowed, 0);
  const issueCount = summary.reduce((sum, s) => sum + s.issues, 0);

  console.log(`║ TOTAL  ${forbiddenCount === 0 ? '✅' : '❌'} Forbidden: ${forbiddenCount.toString().padStart(2)}  Allowed: ${allowedCount.toString().padStart(2)}  Issues: ${issueCount.toString().padStart(2)}  ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Final verdict
  if (allGood && forbiddenCount === 0 && allowedCount > 0) {
    console.log('✅ ✅ ✅ CENTRALIZATION COMPLETE ✅ ✅ ✅\n');
    console.log('All binance_execution_intents writes are centralized through');
    console.log('executionContractService.updateIntent()\n');
    console.log('Guarantee: SIEMPRE centralizar. NO permitir escrituras distribuidas.');
    console.log('Status: ENFORCED ✅\n');
    return true;
  } else {
    console.log('❌ ❌ ❌ CENTRALIZATION INCOMPLETE ❌ ❌ ❌\n');
    if (issueCount > 0) {
      console.log(`Found ${issueCount} issue(s) that need fixing\n`);
    }
    if (forbiddenCount > 0) {
      console.log(`⚠️  Found ${forbiddenCount} direct write(s) that should use updateIntent\n`);
    }
    return false;
  }
}

// Run validation
const isValid = validateCentralization();
process.exit(isValid ? 0 : 1);
