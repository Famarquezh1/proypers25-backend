/**
 * HYBRID MODE TEST SCRIPT
 * Verifica que el hybrid execution wrapper funciona correctamente
 */

const db = require('./backend/firebase-admin-config');
const { 
    determineStrategy, 
    getHybridCapitalExposure, 
    runHybridExecutionCycle 
} = require('./backend/services/hybridExecutionWrapper');

async function testHybridMode() {
    try {
        console.log('\n🔍 TESTING HYBRID MODE INTEGRATION\n');
        console.log('═'.repeat(60));
        
        // Test 1: Verify configurations exist
        console.log('\n1️⃣  Checking configurations in Firestore...\n');
        
        const mainCfg = await db.collection('real_spot_config').doc('control').get();
        const moonshotCfg = await db.collection('real_spot_config').doc('moonshot_strategy').get();
        
        if (!mainCfg.exists) {
            console.log('❌ Main config not found');
            process.exit(1);
        }
        
        if (!moonshotCfg.exists) {
            console.log('❌ Moonshot config not found');
            process.exit(1);
        }
        
        const mainData = mainCfg.data();
        const moonshotData = moonshotCfg.data();
        
        console.log('✅ Configurations found:\n');
        console.log('MAIN CONFIG:');
        console.log(`  Strategy Mode: ${mainData.strategy_mode}`);
        console.log(`  Conservative: ${mainData.conservative_capital_usdt} USDT (${mainData.conservative_strategy_pct}%)`);
        console.log(`  Moonshot: ${mainData.moonshot_capital_usdt} USDT (${mainData.moonshot_strategy_pct}%)`);
        console.log(`  Conservative Targets: SL ${mainData.stop_loss_pct}% / TP1 ${mainData.take_profit_1_pct}% / TP2 ${mainData.take_profit_2_pct}%`);
        
        console.log('\nMOONSHOT CONFIG:');
        console.log(`  Enabled: ${moonshotData.enabled}`);
        console.log(`  Capital: ${moonshotData.moonshot_capital_usdt} USDT`);
        console.log(`  Max Position: ${moonshotData.max_position_usdt} USDT`);
        console.log(`  Targets: TP1 ${moonshotData.take_profit_1_pct}% / TP2 ${moonshotData.take_profit_2_pct}% / TP3 ${moonshotData.take_profit_3_pct}%`);
        console.log(`  SL: ${moonshotData.stop_loss_pct}%`);
        console.log(`  Token Age: ${moonshotData.min_token_age_days} - ${moonshotData.max_token_age_days} days`);
        console.log(`  Price Range: $${moonshotData.min_price_usdt} - $${moonshotData.max_price_usdt}`);
        
        // Test 2: Get current capital exposure
        console.log('\n\n2️⃣  Checking capital exposure...\n');
        
        const exposure = await getHybridCapitalExposure();
        console.log('Current Exposure:');
        console.log(`  Conservative Used: ${exposure.conservative_used.toFixed(2)} USDT`);
        console.log(`  Moonshot Used: ${exposure.moonshot_used.toFixed(2)} USDT`);
        console.log(`  Total Used: ${exposure.total.toFixed(2)} USDT / 90 USDT`);
        console.log(`  Available: ${(90 - exposure.total).toFixed(2)} USDT`);
        
        // Test 3: Get a sample candidate
        console.log('\n\n3️⃣  Fetching sample candidate...\n');
        
        const candidateSnap = await db.collection('spot_opportunity_candidates')
            .orderBy('opportunityScore', 'desc')
            .limit(1)
            .get();
        
        if (candidateSnap.empty) {
            console.log('⚠️  No candidates found - this is normal if scans haven\'t run yet');
        } else {
            const candidate = candidateSnap.docs[0].data();
            console.log(`Found: ${candidate.symbol}`);
            console.log(`  Score: ${candidate.opportunityScore.toFixed(4)}`);
            console.log(`  Price: ${candidate.current_price}`);
            
            // Test 4: Determine strategy
            console.log('\n\n4️⃣  Determining strategy for this candidate...\n');
            
            const strategyDecision = await determineStrategy(candidate, moonshotData);
            console.log(`Strategy Decision: ${strategyDecision.strategy}`);
            console.log(`Reason: ${strategyDecision.reason}`);
            
            // Test 5: Run hybrid execution cycle
            console.log('\n\n5️⃣  Running hybrid execution cycle...\n');
            
            const hybridResult = await runHybridExecutionCycle(db, candidate, mainData, {});
            console.log(`Result Strategy: ${hybridResult.strategy}`);
            console.log(`Config Capital: ${hybridResult.config.max_position_usdt} USDT`);
            console.log(`Targets: SL ${hybridResult.config.stop_loss_pct}% / TP1 ${hybridResult.config.take_profit_1_pct}% / TP2 ${hybridResult.config.take_profit_2_pct}%`);
            if (hybridResult.config.take_profit_3_pct) {
                console.log(`          / TP3 ${hybridResult.config.take_profit_3_pct}%`);
            }
            console.log(`Metadata:`, hybridResult.metadata);
        }
        
        console.log('\n\n' + '═'.repeat(60));
        console.log('✅ HYBRID MODE TEST COMPLETE\n');
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

testHybridMode();
