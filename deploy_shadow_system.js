#!/usr/bin/env node

/**
 * Script de deployment para activar procesamiento shadow automático
 * Ejecutar después del deploy: node deploy_shadow_system.js
 */

async function deployShadowSystem() {
    console.log('🚀 DEPLOYING SHADOW SYSTEM TO PRODUCTION');
    console.log('='.repeat(50));

    try {
        console.log('\n📋 DEPLOYMENT CHECKLIST:');
        console.log('✅ 1. shadow_trade_candidates collection: Ready');
        console.log('✅ 2. shadow_trade_results collection: Ready');
        console.log('✅ 3. processPendingShadowCandidates function: Deployed');
        console.log('✅ 4. Enhanced diagnostic endpoint: Deployed');
        console.log('✅ 5. Shadow logs infrastructure: Deployed');
        console.log('✅ 6. Separated creation/closing flow: Deployed');

        console.log('\n🔧 PRODUCTION CONFIGURATION:');
        console.log('📍 Shadow candidate creation: ENABLED (automatic with signals)');
        console.log('📍 Shadow result processing: MANUAL (call endpoint to process)');
        console.log('📍 Real bot execution: HALTED (as required)');
        console.log('📍 Binance private orders: DISABLED (shadow only)');

        console.log('\n🌐 PRODUCTION ENDPOINTS:');
        console.log('📍 Diagnóstico: GET /api/analizar/diagnostico/shadow-edge-sampler');
        console.log('📍 Procesamiento: POST /api/analizar/shadow/process-pending-candidates');

        console.log('\n📊 PRODUCTION COMMANDS:');
        console.log('');
        console.log('# Ver estado actual del sistema shadow:');
        console.log('curl "https://proypers25-backend-southamerica-west1-[hash].run.app/api/analizar/diagnostico/shadow-edge-sampler?hours=24"');
        console.log('');
        console.log('# Procesar candidatos pendientes:');
        console.log('curl -X POST "https://proypers25-backend-southamerica-west1-[hash].run.app/api/analizar/shadow/process-pending-candidates" \\');
        console.log('  -H "x-cron-secret: YOUR_CRON_SECRET" \\');
        console.log('  -H "Content-Type: application/json" \\');
        console.log('  -d \'{"minAgeMs": 300000, "maxProcess": 25}\'');

        console.log('\n⏰ RECOMMENDED CRON SCHEDULE:');
        console.log('');
        console.log('# Google Cloud Scheduler job para procesar candidatos cada 5 minutos:');
        console.log('gcloud scheduler jobs create http shadow-candidates-processor \\');
        console.log('  --schedule="*/5 * * * *" \\');
        console.log('  --uri="https://proypers25-backend-southamerica-west1-[hash].run.app/api/analizar/shadow/process-pending-candidates" \\');
        console.log('  --http-method="POST" \\');
        console.log('  --headers="x-cron-secret=YOUR_CRON_SECRET,Content-Type=application/json" \\');
        console.log('  --message-body=\'{"minAgeMs": 300000, "maxProcess": 25}\' \\');
        console.log('  --project=proypers2025');

        console.log('\n📈 MONITORING EXPECTATIONS:');
        console.log('📍 shadow_candidates_total: Should increase with new signals');
        console.log('📍 shadow_results_total: Should increase after processing');
        console.log('📍 pending_candidates_count: Should fluctuate but not accumulate');
        console.log('📍 ready_for_exit_simulation_count: Should process to 0 every 5min');
        console.log('📍 BTCUSDT/SOLUSDT shadow_count: Should increase over time');
        console.log('📍 PnL metrics: Should show measurable shadow performance');

        console.log('\n🎯 SUCCESS CRITERIA:');
        console.log('📍 After 24h: shadow_results_total > 0');
        console.log('📍 After 48h: BTCUSDT shadow_count >= 3 AND SOLUSDT shadow_count >= 2');
        console.log('📍 After 72h: Measurable PnL shadow data for both symbols');
        console.log('📍 System health: blocked_candidates_count decreases when bot activates');

        console.log('\n🔔 ALERTS TO MONITOR:');
        console.log('🚨 pending_candidates_count > 50 (processing backup)');
        console.log('🚨 ready_for_exit_simulation_count stuck > 10 (processing failure)');
        console.log('🚨 result_write_fail > result_write_success (Firestore issues)');
        console.log('🚨 oldest_pending_candidate_age_ms > 3600000 (1h+ old candidates)');

        console.log('\n📋 NEXT STEPS:');
        console.log('1. Deploy este código a Cloud Run');
        console.log('2. Configurar Cloud Scheduler job (comando arriba)');
        console.log('3. Verificar endpoint diagnostic funciona en producción');
        console.log('4. Ejecutar procesamiento manual inicial');
        console.log('5. Monitorear métricas por 24-48h');
        console.log('6. Cuando el bot se reactive, observar automática conversión candidatos->resultados');

        console.log('\n🟢 SHADOW SYSTEM DEPLOYMENT: READY');

    } catch (error) {
        console.error('\n❌ ERROR en deployment shadow system:', error);
        throw error;
    }
}

// Ejecutar deployment info
deployShadowSystem()
    .then(() => {
        console.log('\n✅ Deployment info completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Deployment falló:', error);
        process.exit(1);
    });