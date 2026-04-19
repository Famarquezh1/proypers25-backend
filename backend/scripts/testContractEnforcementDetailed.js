#!/usr/bin/env node

/**
 * TEST CONTRACT ENFORCEMENT DETAILED
 */

const {
  buildExecutionContract,
  isValidContract,
  extractOfficialWinModel
} = require('../utils/executionContract');

console.log('\n=== DETAILED CONTRACT VALIDATION TEST ===\n');

const testCases = [
  {
    name: 'Invalid: execution_audit.win_exchange not mapped to win_model',
    intent: {
      id: 'test_001',
      symbol: 'BTC/USDT',
      intent_created_at: '2026-04-16T10:00:00Z',
      executed_at: '2026-04-16T10:00:05Z',
      execution_audit: { win_exchange: 'WIN' },
      win_model: 'PENDING',
      status: 'executed',
      delay_ms: 5000
    }
  },
  {
    name: 'Invalid: verification_outcome not mapped to win_model',
    intent: {
      id: 'test_002',
      symbol: 'ETH/USDT',
      intent_created_at: '2026-04-16T11:00:00Z',
      executed_at: '2026-04-16T11:00:05Z',
      verification_outcome: 'LOSS',
      win_model: 'PENDING',
      status: 'executed',
      delay_ms: 5000
    }
  },
  {
    name: 'Valid: win_model correctly populated',
    intent: {
      id: 'test_003',
      symbol: 'SOL/USDT',
      intent_created_at: '2026-04-16T12:00:00Z',
      executed_at: '2026-04-16T12:00:05Z',
      win_model: 'WIN',
      status: 'executed',
      delay_ms: 5000
    }
  },
  {
    name: 'Invalid: Missing executed_at but status is executed',
    intent: {
      id: 'test_004',
      symbol: 'XRP/USDT',
      intent_created_at: '2026-04-16T13:00:00Z',
      win_model: 'WIN',
      status: 'executed',
      delay_ms: 0
    }
  },
  {
    name: 'Invalid: PENDING status on closed trade',
    intent: {
      id: 'test_005',
      symbol: 'ADA/USDT',
      intent_created_at: '2026-04-16T14:00:00Z',
      executed_at: '2026-04-16T14:00:05Z',
      closed_at: '2026-04-16T14:05:00Z',
      win_model: 'PENDING',
      status: 'closed'
    }
  }
];

for (const testCase of testCases) {
  console.log(`\n📋 ${testCase.name}`);
  console.log(`   Intent ID: ${testCase.intent.id}`);

  const contract = buildExecutionContract(testCase.intent);
  const valid = isValidContract(testCase.intent);

  console.log(`   Current state:`);
  console.log(`     - win_model: ${testCase.intent.win_model}`);
  console.log(`     - status: ${testCase.intent.status}`);
  console.log(`     - executed_at: ${testCase.intent.executed_at || 'N/A'}`);

  if (testCase.intent.execution_audit?.win_exchange) {
    console.log(`     - execution_audit.win_exchange: ${testCase.intent.execution_audit.win_exchange}`);
  }
  if (testCase.intent.verification_outcome) {
    console.log(`     - verification_outcome: ${testCase.intent.verification_outcome}`);
  }

  console.log(`\n   Contract extraction:`);
  console.log(`     - Extracted win_model: ${contract.win_model}`);
  console.log(`     - Extracted status: ${contract.status}`);
  console.log(`     - Extracted executed_at: ${contract.executed_at || 'N/A'}`);
  console.log(`     - Extracted delay_ms: ${contract.delay_ms}`);

  console.log(`\n   Validation: ${valid ? '✅ VALID' : '❌ INVALID'}`);
}

console.log('\n=== END TEST ===\n');
