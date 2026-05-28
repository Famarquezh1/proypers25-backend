const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function generateCompleteReport() {
    try {
        console.log('╔' + '═'.repeat(78) + '╗');
        console.log('║' + ' '.repeat(20) + 'REPORTE DE ESTADO DEL SISTEMA DE TRADING' + ' '.repeat(20) + '║');
        console.log('╚' + '═'.repeat(78) + '╝');
        console.log();

        // SECCIÓN 1: Posiciones Activas
        console.log('┌─ 1. POSICIONES ACTIVAS (REAL_OPEN)');
        console.log('│');

        const realOpenSnapshot = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_OPEN')
            .get();

        if (realOpenSnapshot.empty) {
            console.log('│  ❌ NO HAY POSICIONES ABIERTAS');
            console.log('│  Capital en riesgo: $0.00 USDT');
        } else {
            console.log(`│  ✓ ${realOpenSnapshot.size} posición(es) abierta(s):`);
            let totalRisk = 0;
            realOpenSnapshot.forEach(doc => {
                const data = doc.data();
                totalRisk += data.capital_usdt || 0;
                console.log(`│    • ${data.symbol}: $${(data.capital_usdt || 0).toFixed(2)} USDT (Entry: ${data.entry_price})`);
            });
            console.log(`│  Capital total en riesgo: $${totalRisk.toFixed(2)} USDT`);
        }
        console.log('└─');
        console.log();

        // SECCIÓN 2: Posiciones Cerradas
        console.log('┌─ 2. ÚLTIMAS POSICIONES CERRADAS (REAL_CLOSED)');
        console.log('│');

        const allClosedSnapshot = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_CLOSED')
            .get();

        if (allClosedSnapshot.empty) {
            console.log('│  ❌ NO HAY POSICIONES CERRADAS');
        } else {
            const allClosed = [];
            allClosedSnapshot.forEach(doc => {
                const data = doc.data();
                allClosed.push({
                    symbol: data.symbol || 'N/A',
                    pnl: data.pnl_usdt || 0,
                    closedAt: data.closed_at,
                    reason: data.close_reason || 'N/A'
                });
            });

            // Ordenar por fecha
            allClosed.sort((a, b) => {
                const aMs = a.closedAt ? (typeof a.closedAt.toMillis === 'function' ? a.closedAt.toMillis() : new Date(a.closedAt).getTime()) : 0;
                const bMs = b.closedAt ? (typeof b.closedAt.toMillis === 'function' ? b.closedAt.toMillis() : new Date(b.closedAt).getTime()) : 0;
                return bMs - aMs;
            });

            console.log(`│  Total cerradas: ${allClosed.length}`);
            console.log(`│  Últimas 5:`);
            console.log('│');

            let totalPnL = 0;
            const last5 = allClosed.slice(0, 5);
            last5.forEach((pos, idx) => {
                totalPnL += pos.pnl;
                const pnlStr = pos.pnl >= 0 ? `+$${pos.pnl.toFixed(2)}` : `-$${Math.abs(pos.pnl).toFixed(2)}`;
                const closeDateStr = pos.closedAt ? 
                    (typeof pos.closedAt.toDate === 'function' ? 
                        new Date(pos.closedAt.toDate()).toISOString().substring(0, 19) :
                        new Date(pos.closedAt).toISOString().substring(0, 19))
                    : 'N/A';
                
                console.log(`│    ${idx + 1}. ${pos.symbol.padEnd(10)} | PnL: ${pnlStr.padStart(10)} | Reason: ${pos.reason.padEnd(10)} | Closed: ${closeDateStr}`);
            });

            console.log('│');
            console.log(`│  PnL Acumulado (últimas 5): $${totalPnL.toFixed(2)} USDT`);
        }
        console.log('└─');
        console.log();

        // SECCIÓN 3: Configuración del Sistema
        console.log('┌─ 3. CONFIGURACIÓN DEL SISTEMA');
        console.log('│');

        const controlDoc = await db.collection('real_spot_config')
            .doc('control')
            .get();

        if (controlDoc.exists) {
            const control = controlDoc.data();

            console.log('│  CAPITAL:');
            console.log(`│    • Total: $${(control.total_capital || 0).toFixed(2)} USDT`);
            console.log(`│    • Operativo: $${(control.capital_usdt_operational || 0).toFixed(2)} USDT`);
            console.log(`│    • Locked (en posiciones): $${(control.current_spot_locked || 0).toFixed(2)} USDT`);
            console.log(`│    • Disponible: $${(control.current_spot_available || 0).toFixed(2)} USDT`);
            console.log('│');

            console.log('│  HOLDINGS EMERGENTES:');
            if (control.emerging_holdings && control.emerging_holdings.CATI) {
                const cati = control.emerging_holdings.CATI;
                console.log(`│    • CATI: ${cati.quantity || 0} tokens = $${cati.value_usdt || 0} USDT`);
                console.log(`│      Status: ${cati.status || 'N/A'}`);
                console.log(`│      Target: ${cati.target_multiplier || 'N/A'}`);
            } else {
                console.log('│    • Sin holdings emergentes');
            }
            console.log('│');

            console.log('│  MODO OPERATIVO:');
            console.log(`│    • Mode: ${control.mode || 'N/A'}`);
            console.log(`│    • New Entries Enabled: ${control.new_entries_enabled ? '✓ YES' : '❌ NO'}`);
            console.log(`│    • System Enabled: ${control.enabled ? '✓ YES' : '❌ NO'}`);
            console.log(`│    • Kill Switch: ${control.kill_switch ? '⚠️  ACTIVE' : '✓ OFF'}`);
            console.log('│');

            console.log('│  ESTRATEGIA:');
            console.log(`│    • Strategy Mode: ${control.strategy_mode || 'N/A'}`);
            console.log(`│    • Conservative: ${control.conservative_strategy_pct || 0}% | Moonshot: ${control.moonshot_strategy_pct || 0}%`);
            console.log(`│    • Max Open Positions: ${control.max_open_positions || 'N/A'}`);
            console.log(`│    • Entries Used This Session: ${control.entries_used_this_session || 0}`);
            console.log('│');

            if (control.last_entry_at) {
                const lastEntryDate = typeof control.last_entry_at.toDate === 'function' ?
                    new Date(control.last_entry_at.toDate()).toISOString() :
                    new Date(control.last_entry_at).toISOString();
                console.log(`│  ÚLTIMA ACTIVIDAD:`);
                console.log(`│    • Last Entry: ${control.last_entry_symbol || 'N/A'} at ${lastEntryDate.substring(0, 19)}`);
                console.log(`│    • Updated: ${new Date(control.updated_at.toDate ? control.updated_at.toDate() : control.updated_at).toISOString().substring(0, 19)}`);
            }
        } else {
            console.log('│  ❌ NO EXISTE DOCUMENTO DE CONTROL');
        }
        console.log('└─');
        console.log();

        // SECCIÓN 4: Eventos de Ejecución
        console.log('┌─ 4. EVENTOS DE EJECUCIÓN');
        console.log('│');

        const executionResults = await db.collection('real_spot_execution_results')
            .orderBy('timestamp', 'desc')
            .limit(5)
            .get();

        if (executionResults.empty) {
            console.log('│  ❌ Sin eventos registrados');
        } else {
            console.log(`│  Últimos 5 eventos:`);
            console.log('│');
            executionResults.forEach(doc => {
                const data = doc.data();
                const ts = typeof data.timestamp.toDate === 'function' ?
                    new Date(data.timestamp.toDate()).toISOString().substring(0, 19) :
                    new Date(data.timestamp).toISOString().substring(0, 19);
                console.log(`│    • ${ts} | ${(data.status || 'UNKNOWN').padEnd(10)} | ${data.symbol || 'N/A'}`);
            });
        }
        console.log('└─');
        console.log();

        // SECCIÓN 5: RESUMEN Y ALERTAS
        console.log('┌─ 5. RESUMEN Y ALERTAS');
        console.log('│');

        const alerts = [];

        if (!controlDoc.exists) {
            alerts.push('🔴 CRÍTICO: No existe documento de configuración');
        }

        if (controlDoc.exists && !controlDoc.data().enabled) {
            alerts.push('🟡 ADVERTENCIA: Sistema deshabilitado (enabled=false)');
        }

        if (controlDoc.exists && controlDoc.data().kill_switch) {
            alerts.push('🔴 CRÍTICO: Kill switch activado');
        }

        if (controlDoc.exists && !controlDoc.data().new_entries_enabled) {
            alerts.push('🟡 ADVERTENCIA: New entries deshabilitadas (new_entries_enabled=false)');
        }

        // Buscar posiciones con PnL = 0
        const allClosedForPnL = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_CLOSED')
            .get();

        let pnlZeroCount = 0;
        allClosedForPnL.forEach(doc => {
            const pnl = doc.data().pnl_usdt;
            if (pnl === 0 || pnl === undefined) pnlZeroCount++;
        });

        if (pnlZeroCount === allClosedForPnL.size && allClosedForPnL.size > 0) {
            alerts.push('🟡 ADVERTENCIA: Todas las posiciones cerradas tienen PnL = 0 (datos incompletos)');
        }

        if (alerts.length === 0) {
            console.log('│  ✓ Sin alertas críticas');
        } else {
            alerts.forEach(alert => {
                console.log(`│  ${alert}`);
            });
        }
        console.log('│');

        console.log('│  ESTADO GENERAL:');
        const openCount = realOpenSnapshot.size;
        const closedCount = allClosedForPnL.size;
        if (openCount === 0 && closedCount > 0) {
            console.log('│    ✓ Sistema en descanso (sin operaciones activas)');
        } else if (openCount > 0) {
            console.log('│    🟢 Sistema activo con operaciones abiertas');
        } else {
            console.log('│    ⚪ Sistema inactivo');
        }
        console.log('└─');
        console.log();

        console.log('═'.repeat(80));

        process.exit(0);
    } catch (err) {
        console.error('❌ ERROR:', err.message);
        process.exit(1);
    }
}

generateCompleteReport();
