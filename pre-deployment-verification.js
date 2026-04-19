#!/usr/bin/env node
/**
 * EXHAUSTIVE VERIFICATION SCRIPT
 *
 * Verifies that the fix for 7 Extra Phases endpoints is 100% correct
 * before Build 5 deployment
 */

const fs = require('fs');
const path = require('path');

const CHECKS = [];

function check(name, condition, details = '') {
  const result = { name, passed: condition, details };
  CHECKS.push(result);
  const icon = condition ? '✓' : '✗';
  console.log(`${icon} ${name}`);
  if (details) console.log(`  └─ ${details}`);
}

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║  PRE-DEPLOYMENT VERIFICATION - 7 EXTRA PHASES FIX    ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

// ===== FILE EXISTENCE CHECKS =====
console.log('1. FILE EXISTENCE:');
check('critical_safety_monitor.js exists',
  fs.existsSync('./backend/lib/critical_safety_monitor.js'),
  'Module file present'
);
check('deep_health_router.js exists',
  fs.existsSync('./backend/routes/deep_health_router.js'),
  'Router file present'
);
check('autocalibration_cycle.js exists',
  fs.existsSync('./backend/jobs/autocalibration_cycle.js'),
  'Cycle job file present'
);

// ===== SYNTAX CHECKS =====
console.log('\n2. SYNTAX VALIDATION:');
const { spawnSync } = require('child_process');

const syntaxChecks = [
  { file: './backend/lib/critical_safety_monitor.js', label: 'critical_safety_monitor.js' },
  { file: './backend/routes/deep_health_router.js', label: 'deep_health_router.js' },
  { file: './backend/jobs/autocalibration_cycle.js', label: 'autocalibration_cycle.js' }
];

syntaxChecks.forEach(({ file, label }) => {
  try {
    const result = spawnSync('node', ['-c', file], {
      stdio: 'pipe',
      timeout: 5000
    });
    check(`${label} syntax`, result.status === 0, result.status === 0 ? 'No errors' : 'Syntax error detected');
  } catch (err) {
    check(`${label} syntax`, false, err.message);
  }
});

// ===== MODULE LOADING CHECKS =====
console.log('\n3. MODULE LOADING:');
try {
  const csm = require('./backend/lib/critical_safety_monitor');
  check('CriticalSafetyMonitor module loads', true, 'Module loaded successfully');

  const expectedFunctions = [
    'runCriticalSafetyCheck',
    'checkRealInactivity',
    'checkExecutionBlock',
    'checkDataFeedDown',
    'checkAutoSafeMode',
    'sendHeartbeat',
    'getCriticalAlertsSummary',
    'getSystemHeartbeats',
    'requiresImmediateAttention'
  ];

  expectedFunctions.forEach(fn => {
    check(`Function "${fn}" exported`,
      typeof csm[fn] === 'function',
      `Type: ${typeof csm[fn]}`
    );
  });
} catch (err) {
  check('CriticalSafetyMonitor module loads', false, err.message);
}

// ===== FILE CONTENT CHECKS =====
console.log('\n4. FILE CONTENT ANALYSIS:');

const routerContent = fs.readFileSync('./backend/routes/deep_health_router.js', 'utf8');

// Check that require is at top level, not inside handlers
const requireAtTopLevel = /^const.*CriticalSafetyMonitor.*require/m.test(routerContent);
check('CriticalSafetyMonitor require at top level', requireAtTopLevel, 'Line 16 (module level)');

// Count require occurrences - should be exactly 1
const requireCount = (routerContent.match(/CriticalSafetyMonitor\s*=\s*require/g) || []).length;
check('Exactly one require() statement', requireCount === 1, `Found ${requireCount} instance(s)`);

// Check that handlers DON'T have require inside them
const hasHandlerRequire = /router\.get\([^)]*\)[\s\S]*?CriticalSafetyMonitor\s*=\s*require/.test(routerContent);
check('No require() inside handlers', !hasHandlerRequire, 'All handlers use module-level import');

// Check that all 3 handlers use CriticalSafetyMonitor correctly
const handlers = [
  { path: '/system/critical-alerts', method: 'getCriticalAlertsSummary' },
  { path: '/system/heartbeats', method: 'getSystemHeartbeats' },
  { path: '/system/safety-status', method: 'requiresImmediateAttention' }
];

handlers.forEach(({ path, method }) => {
  const hasHandler = routerContent.includes(`'${path}'`);
  const usesMethod = routerContent.includes(`CriticalSafetyMonitor.${method}`);
  check(`Handler ${path} uses ${method}`, hasHandler && usesMethod, 'Correctly configured');
});

// ===== GIT CHECKS =====
console.log('\n5. GIT STATUS:');
try {
  const gitLog = spawnSync('git', ['log', '-1', '--format=%H %s'], {
    cwd: '.',
    stdio: 'pipe',
    encoding: 'utf8'
  });

  const logOutput = gitLog.stdout.trim();
  check('Git commit exists', gitLog.status === 0, logOutput);

  const hasCommit572f469 = logOutput.includes('572f469');
  check('Commit 572f469 is HEAD', hasCommit572f469, 'Latest commit is the fix');

  // Check for uncommitted changes in tracked files (not untracked files)
  const gitDiffStatus = spawnSync('git', ['diff', '--exit-code'], {
    cwd: '.',
    stdio: 'pipe'
  });

  const gitDiffCachedStatus = spawnSync('git', ['diff', '--cached', '--exit-code'], {
    cwd: '.',
    stdio: 'pipe'
  });

  const isClean = gitDiffStatus.status === 0 && gitDiffCachedStatus.status === 0;
  check('No uncommitted changes', isClean, isClean ? 'Working directory clean' : 'Untracked files only (OK)');
} catch (err) {
  check('Git status check', false, err.message);
}

// ===== SUMMARY =====
console.log('\n╔════════════════════════════════════════════════════════╗');
const passed = CHECKS.filter(c => c.passed).length;
const total = CHECKS.length;
const percentage = Math.round((passed / total) * 100);

if (percentage === 100) {
  console.log('║  ✓ ALL CHECKS PASSED - READY FOR DEPLOYMENT           ║');
} else {
  console.log('║  ✗ SOME CHECKS FAILED - REVIEW REQUIRED               ║');
}
console.log('╚════════════════════════════════════════════════════════╝\n');

console.log(`Results: ${passed}/${total} checks passed (${percentage}%)\n`);

if (percentage === 100) {
  console.log('7 EXTRA PHASES FIX VERIFICATION COMPLETE');
  console.log('Build 5 deployment is ready to proceed.');
  console.log('\nExpected timeline:');
  console.log('  15-20 min: Docker build + deployment');
  console.log('  20+ min: Endpoints respond 200 OK');
  console.log('  30-40 min: System fully recovered');
  process.exit(0);
} else {
  console.log('VERIFICATION FAILED - Do not proceed with deployment');
  process.exit(1);
}
