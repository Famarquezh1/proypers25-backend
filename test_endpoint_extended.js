#!/usr/bin/env node

/**
 * PRUEBA ENDPOINT EDGE CONSOLIDATION EXTENDIDO
 * Validar funcionamiento del endpoint con análisis de fee model + edge floor
 */

const express = require('express');
const app = express();
const PORT = 8181; // Puerto diferente para prueba

// Importar el router
app.use('/api/analizar', require('./backend/routes/analizar.route'));

// Middleware
app.use(express.json());

// Iniciar servidor de prueba
app.listen(PORT, () => {
    console.log(`🚀 Servidor de prueba ejecutándose en puerto ${PORT}`);
    console.log(`🎯 Endpoint: GET http://localhost:${PORT}/api/analizar/diagnostico/edge-consolidation`);

    // Test automático
    setTimeout(async() => {
        const http = require('http');

        console.log('\n🔍 TESTING ENDPOINT...');

        const options = {
            hostname: 'localhost',
            port: PORT,
            path: '/api/analizar/diagnostico/edge-consolidation',
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);

                    console.log('✅ RESPONSE STATUS:', res.statusCode);
                    console.log('✅ RESPONSE OK:', response.ok);

                    if (response.report) {
                        const report = response.report;

                        console.log('\n📊 FEE MODEL ANALYSIS:');
                        console.log('─'.repeat(40));
                        if (report.analysis && report.analysis.fee_model) {
                            const fm = report.analysis.fee_model;
                            console.log(`Shadow fee avg: ${fm.shadow_fee_avg}%`);
                            console.log(`Fee model validated: ${fm.fee_model_validated}`);
                            console.log(`Possible fee overcount: ${fm.possible_fee_overcount}`);
                            console.log(`Fee inconsistency detected: ${fm.fee_inconsistency_detected}`);
                            console.log(`Formula: ${fm.fee_formula_explanation}`);
                        }

                        console.log('\n🎯 EDGE FLOOR SIMULATIONS:');
                        console.log('─'.repeat(40));
                        if (report.analysis && report.analysis.edge_floor_simulations) {
                            const efs = report.analysis.edge_floor_simulations;
                            console.log(`No positive subgroup: ${efs.no_positive_subgroup}`);
                            console.log(`Best edge floor: ${efs.best_edge_floor ? efs.best_edge_floor.filter : 'NINGUNO'}`);
                            console.log(`Simulations count: ${efs.simulations.length}`);

                            // Mostrar primera simulación como ejemplo
                            if (efs.simulations.length > 0) {
                                const sim = efs.simulations[0];
                                console.log(`  Ejemplo: ${sim.filter}`);
                                console.log(`    Threshold: ${sim.threshold}%`);
                                console.log(`    Kept/Total: ${sim.trades_kept}/${sim.trades_kept + sim.trades_filtered}`);
                                console.log(`    PnL Neto: ${sim.pnl_neto_simulado}%`);
                            }
                        }

                        console.log('\n🔬 DIAGNÓSTICOS:');
                        console.log('─'.repeat(40));
                        if (report.diagnosis) {
                            console.log(`Diagnósticos: [${report.diagnosis.join(', ')}]`);
                        }

                        console.log('\n💼 EXECUTIVE SUMMARY:');
                        console.log('─'.repeat(40));
                        if (report.executive_summary) {
                            const es = report.executive_summary;
                            console.log(`Diagnóstico principal: ${es.diagnostico_principal}`);
                            console.log(`Reactivar bot: ${es.reactivar_bot}`);
                            console.log(`Acción recomendada: ${es.accion_recomendada}`);
                        }
                    }

                    console.log('\n✅ ENDPOINT TEST COMPLETADO');
                    process.exit(0);

                } catch (error) {
                    console.error('❌ Error parsing response:', error);
                    console.error('Raw response:', data);
                    process.exit(1);
                }
            });
        });

        req.on('error', (error) => {
            console.error('❌ Request error:', error);
            process.exit(1);
        });

        req.end();

    }, 2000); // Wait 2 seconds for server to start
});