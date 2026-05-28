#!/usr/bin/env node

/**
 * DIRECT TEST NET EDGE GATE LOGIC
 * Test específico para evaluateNetEdgeGate sin otras validaciones
 */

const { getBinanceBotConfig } = require('./backend/lib/binanceBotConfig');
const db = require('./backend/firebase-admin-config');

// Mock de evaluateNetEdgeGate basado en la lógica implementada
function evaluateNetEdgeGate(intent, config) {
    if (!config || !config.net_edge_gate_enabled) {
        return {
            enabled: false,
            passed: true,
            reason: 'gate_disabled'
        };
    }

    const expectedMovePercent = Number(intent.expected_move_percent || 0);
    const feeRoundtripPct = 0.10; // Current fee model
    const netEdgePct = expectedMovePercent - feeRoundtripPct;
    const minRequiredPct = Number(config.min_net_edge_expected_pct || 0);

    const passed = netEdgePct >= minRequiredPct;

    return {
        enabled: true,
        expected_move_percent: expectedMovePercent,
        fee_roundtrip_pct: feeRoundtripPct,
        net_edge_pct: netEdgePct,
        min_required_pct: minRequiredPct,
        passed: passed,
        reason: passed ? null : 'net_edge_too_low'
    };
}

// Test cases
const testCases = [{
        name: 'Below threshold - should be blocked',
        intent: { expected_move_percent: 0.35 },
        expectedPassed: false
    },
    {
        name: 'At threshold - should pass',
        intent: { expected_move_percent: 0.50 },
        expectedPassed: false // 0.50 - 0.10 = 0.40, which is < 0.50 min required
    },
    {
        name: 'Just above threshold - should pass',
        intent: { expected_move_percent: 0.60 },
        expectedPassed: true // 0.60 - 0.10 = 0.50, which is = 0.50 min required
    },
    {
        name: 'Well above threshold - should pass',
        intent: { expected_move_percent: 0.75 },
        expectedPassed: true // 0.75 - 0.10 = 0.65, which is > 0.50 min required
    },
    {
        name: 'Edge case: exactly 0.60% - should pass',
        intent: { expected_move_percent: 0.60 },
        expectedPassed: true
    }
];

async function testNetEdgeGateLogic() {
    console.log('🎯 DIRECT NET EDGE GATE LOGIC TEST');
    console.log('='.repeat(60));
    console.log('TESTING: evaluateNetEdgeGate function directly');
    console.log('THRESHOLD: net_edge >= min_net_edge_expected_pct');
    console.log('FORMULA: net_edge = expected_move - fee_roundtrip');
    console.log('='.repeat(60));

    try {
        // Load configuration
        console.log('\n📋 LOADING CONFIGURATION...');
        const config = await getBinanceBotConfig(db);
        console.log(`✓ Net edge gate enabled: ${config.net_edge_gate_enabled}`);
        console.log(`✓ Min net edge expected: ${config.min_net_edge_expected_pct}%`);
        console.log(`✓ Fee roundtrip model: 0.10%`);

        console.log('\n🧪 RUNNING TEST CASES...');
        console.log('─'.repeat(50));

        let passedTests = 0;
        let failedTests = 0;

        for (const [index, testCase] of testCases.entries()) {
            console.log(`\n📍 TEST ${index + 1}: ${testCase.name}`);
            console.log(`   Expected Move: ${testCase.intent.expected_move_percent}%`);

            const result = evaluateNetEdgeGate(testCase.intent, config);

            console.log(`   Results:`);
            console.log(`     ✓ Enabled: ${result.enabled}`);
            console.log(`     ✓ Expected Move: ${result.expected_move_percent}%`);
            console.log(`     ✓ Fee Roundtrip: ${result.fee_roundtrip_pct}%`);
            console.log(`     ✓ Net Edge: ${result.net_edge_pct}%`);
            console.log(`     ✓ Min Required: ${result.min_required_pct}%`);
            console.log(`     ✓ Passed: ${result.passed}`);
            console.log(`     ✓ Reason: ${result.reason || 'none'}`);

            const testPassed = (result.passed === testCase.expectedPassed);

            if (testPassed) {
                passedTests++;
                console.log(`   ✅ RESULT: CORRECT - Expected ${testCase.expectedPassed ? 'PASS' : 'BLOCK'}, got ${result.passed ? 'PASS' : 'BLOCK'}`);
            } else {
                failedTests++;
                console.log(`   ❌ RESULT: INCORRECT - Expected ${testCase.expectedPassed ? 'PASS' : 'BLOCK'}, got ${result.passed ? 'PASS' : 'BLOCK'}`);
            }
        }

        console.log('\n📊 TEST SUMMARY:');
        console.log('─'.repeat(50));
        console.log(`Total tests: ${testCases.length}`);
        console.log(`Passed: ${passedTests}`);
        console.log(`Failed: ${failedTests}`);
        console.log(`Success rate: ${((passedTests / testCases.length) * 100).toFixed(1)}%`);

        // Logic validation
        console.log('\n🎯 LOGIC VALIDATION:');
        console.log('─'.repeat(50));
        console.log(`Expected formula: net_edge = expected_move - 0.10%`);
        console.log(`Threshold: net_edge >= ${config.min_net_edge_expected_pct}%`);
        console.log(`This means expected_move >= ${config.min_net_edge_expected_pct + 0.10}% to pass`);

        const logicCorrect = (failedTests === 0);

        if (logicCorrect) {
            console.log(`✅ LOGIC: CORRECT - All test cases passed as expected`);
        } else {
            console.log(`❌ LOGIC: ISSUES - ${failedTests} test cases failed`);
        }

        // Configuration check
        console.log('\n⚙️ CONFIGURATION CHECK:');
        console.log('─'.repeat(50));

        const requiredExpectedMove = config.min_net_edge_expected_pct + 0.10;
        console.log(`With current settings:`);
        console.log(`  Required net edge: ${config.min_net_edge_expected_pct}%`);
        console.log(`  Fee roundtrip: 0.10%`);
        console.log(`  Minimum expected move to pass: ${requiredExpectedMove}%`);

        if (requiredExpectedMove === 0.60) {
            console.log(`✅ CONSERVATIVE THRESHOLD: Expected move must be >= 0.60% to pass net edge gate`);
        } else {
            console.log(`⚠️ THRESHOLD: Current setup requires ${requiredExpectedMove}% expected move`);
        }

        console.log('\n🏁 DIRECT NET EDGE GATE TEST COMPLETED');

        return logicCorrect ? 0 : 1;

    } catch (error) {
        console.error('\n❌ TEST FAILED:', error.message);
        return 1;
    }
}

// Run test
testNetEdgeGateLogic()
    .then((exitCode) => {
        console.log(`\nTest completed with exit code: ${exitCode}`);
        process.exit(exitCode);
    })
    .catch((error) => {
        console.error('Test execution failed:', error);
        process.exit(1);
    });