#!/usr/bin/env node

/**
 * TEST HIGH NET EDGE GATE IMPLEMENTATION
 * Valida que el filtro conservador funciona correctamente
 */

const { getBinanceBotConfig } = require('./backend/lib/binanceBotConfig');
const { validateExecutionIntent } = require('./backend/lib/binanceFuturesExecutor');
const db = require('./backend/firebase-admin-config');

// Mock intent data for testing
const mockIntents = [{
        symbol: 'BTCUSDT',
        side: 'BUY',
        quantity: 0.01,
        entry_price: 45000,
        stop_loss: 44500,
        take_profit: 46000,
        enable_tp_sl: true,
        confidence: 0.85,
        quantum: 0.75,
        timing: 0.70,
        context_score: 3.5,
        risk_reward_ratio: 2.0,
        expected_move_percent: 0.35, // Below 0.50% threshold - should be blocked
        notional_usdt: 450
    },
    {
        symbol: 'ETHUSDT',
        side: 'SELL',
        quantity: 0.1,
        entry_price: 3000,
        stop_loss: 3050,
        take_profit: 2900,
        enable_tp_sl: true,
        confidence: 0.90,
        quantum: 0.80,
        timing: 0.75,
        context_score: 4.0,
        risk_reward_ratio: 2.5,
        expected_move_percent: 0.55, // Above 0.50% threshold - should pass
        notional_usdt: 300
    },
    {
        symbol: 'SOLUSDT',
        side: 'BUY',
        quantity: 1,
        entry_price: 100,
        stop_loss: 98,
        take_profit: 105,
        enable_tp_sl: true,
        confidence: 0.95,
        quantum: 0.85,
        timing: 0.80,
        context_score: 4.2,
        risk_reward_ratio: 2.8,
        expected_move_percent: 0.75, // Well above threshold - should pass
        notional_usdt: 100
    }
];

async function testHighNetEdgeGate() {
    console.log('🎯 TESTING HIGH NET EDGE GATE IMPLEMENTATION');
    console.log('='.repeat(70));
    console.log('OBJETIVO: Validar filtro conservador para edge alto');
    console.log('THRESHOLD: expected_move >= 0.50%');
    console.log('='.repeat(70));

    try {
        // 1. Load bot configuration
        console.log('\n📋 LOADING BOT CONFIGURATION...');
        const config = await getBinanceBotConfig(db);

        // Override execution_enabled for testing purposes
        config.execution_enabled = true;
        config.mode = 'test'; // Use test mode to avoid actual trading

        console.log(`✓ Config loaded: mode=${config.mode}, execution_enabled=${config.execution_enabled}`);
        console.log(`✓ Net edge gate enabled: ${config.net_edge_gate_enabled}`);
        console.log(`✓ Min net edge expected: ${config.min_net_edge_expected_pct}%`);
        console.log(`✓ Min expected move: ${config.min_expected_move_pct}%`);

        // 2. Test each mock intent
        console.log('\n🧪 TESTING INTENT VALIDATION...');
        console.log('─'.repeat(50));

        let blockedByNetEdge = 0;
        let passedNetEdge = 0;
        let totalTests = 0;

        for (const [index, intent] of mockIntents.entries()) {
            totalTests++;
            console.log(`\n📍 TEST ${index + 1}: ${intent.symbol} - Expected Move: ${intent.expected_move_percent}%`);

            try {
                const validation = await validateExecutionIntent(db, intent, config, {
                    source_profile: 'high_conviction',
                    rules: null
                });

                console.log(`   Validation OK: ${validation.ok}`);
                console.log(`   Reason: ${validation.reason || 'none'}`);

                if (validation.net_edge_gate) {
                    const gate = validation.net_edge_gate;
                    console.log(`   Net Edge Gate:`);
                    console.log(`     ✓ Enabled: ${gate.enabled}`);
                    console.log(`     ✓ Expected Move: ${gate.expected_move_percent}%`);
                    console.log(`     ✓ Fee Roundtrip: ${gate.fee_roundtrip_pct}%`);
                    console.log(`     ✓ Net Edge: ${gate.net_edge_pct}%`);
                    console.log(`     ✓ Min Required: ${gate.min_required_pct}%`);
                    console.log(`     ✓ Passed: ${gate.passed}`);
                    console.log(`     ✓ Reason: ${gate.reason || 'none'}`);

                    if (gate.enabled) {
                        if (gate.passed) {
                            passedNetEdge++;
                            console.log(`   🟢 RESULT: NET EDGE GATE PASSED`);
                        } else {
                            blockedByNetEdge++;
                            console.log(`   🔴 RESULT: NET EDGE GATE BLOCKED`);
                        }
                    }
                }

                if (validation.ok) {
                    console.log(`   ✅ INTENT: ALLOWED TO PROCEED`);
                } else {
                    console.log(`   ❌ INTENT: BLOCKED - ${validation.reason}`);
                }

            } catch (error) {
                console.log(`   ❌ ERROR: ${error.message}`);
            }
        }

        // 3. Summary
        console.log('\n📊 TEST SUMMARY:');
        console.log('─'.repeat(50));
        console.log(`Total tests run: ${totalTests}`);
        console.log(`Blocked by Net Edge Gate: ${blockedByNetEdge}`);
        console.log(`Passed Net Edge Gate: ${passedNetEdge}`);
        console.log(`Block rate: ${((blockedByNetEdge / totalTests) * 100).toFixed(1)}%`);

        // 4. Validate expected behavior
        console.log('\n🎯 EXPECTED BEHAVIOR VALIDATION:');
        console.log('─'.repeat(50));

        const expectedBlocked = mockIntents.filter(i => i.expected_move_percent < 0.50).length;
        const expectedPassed = mockIntents.filter(i => i.expected_move_percent >= 0.50).length;

        console.log(`Expected to be blocked: ${expectedBlocked} (< 0.50%)`);
        console.log(`Expected to pass: ${expectedPassed} (>= 0.50%)`);

        const behaviorCorrect = (blockedByNetEdge === expectedBlocked && passedNetEdge === expectedPassed);

        if (behaviorCorrect) {
            console.log(`✅ BEHAVIOR: CORRECT - Net edge gate working as expected`);
        } else {
            console.log(`❌ BEHAVIOR: INCORRECT - Expected ${expectedBlocked} blocked, ${expectedPassed} passed`);
        }

        // 5. Configuration validation
        console.log('\n⚙️ CONFIGURATION VALIDATION:');
        console.log('─'.repeat(50));
        console.log(`✓ Default min_net_edge_expected_pct: ${config.min_net_edge_expected_pct}%`);
        console.log(`✓ Default net_edge_gate_enabled: ${config.net_edge_gate_enabled}`);

        // Check if configuration is per requirements
        const configCorrect = (
            config.min_net_edge_expected_pct === 0.50 &&
            config.net_edge_gate_enabled === true
        );

        if (configCorrect) {
            console.log(`✅ CONFIG: HIGH NET EDGE GATE configured correctly`);
        } else {
            console.log(`⚠️ CONFIG: Review configuration - should be 0.50% threshold, enabled=true`);
        }

        console.log('\n🏁 HIGH NET EDGE GATE TEST COMPLETED');

        return behaviorCorrect && configCorrect ? 0 : 1;

    } catch (error) {
        console.error('\n❌ TEST FAILED:', error.message);
        console.error('Stack:', error.stack);
        return 1;
    }
}

// Run test
testHighNetEdgeGate()
    .then((exitCode) => {
        console.log(`\nTest completed with exit code: ${exitCode}`);
        process.exit(exitCode);
    })
    .catch((error) => {
        console.error('Test execution failed:', error);
        process.exit(1);
    });