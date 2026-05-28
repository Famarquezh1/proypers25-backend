#!/usr/bin/env node

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

let lastCheckTime = new Date();
let lastClosedCount = 0;
let cycleCount = 0;

async function monitorStatus() {
    try {
        const now = new Date();
        
        // 1. Check configuration
        const cfgDoc = await db.collection('real_spot_config').doc('control').get();
        const config = cfgDoc.data() || {};
        
        // 2. Check open positions
        const openSnap = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        // 3. Check closed positions
        const closedSnap = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_CLOSED')
            .get();
        
        const newClosedCount = closedSnap.size;
        const newClosures = newClosedCount - lastClosedCount;
        
        // 4. Calculate total PnL from latest closes
        let totalPnL = 0;
        let latestClosed = [];
        
        if (newClosures > 0) {
            const docs = closedSnap.docs.slice(-newClosures);
            docs.forEach(doc => {
                const p = doc.data();
                const pnl = p.pnl_usdt || 0;
                totalPnL += pnl;
                latestClosed.push({
                    symbol: p.symbol,
                    pnl: pnl,
                    reason: p.closing_reason || 'N/A'
                });
            });
        }
        
        // 5. Get capital status
        const balDoc = await db.collection('real_spot_config').doc('balance').get();
        const balance = balDoc.data() || {};
        
        cycleCount++;
        
        console.log(`\n[${now.toISOString()}] CICLO #${cycleCount}`);
        console.log('═══════════════════════════════════════════════════════════');
        
        console.log('📊 ESTADO:');
        console.log(`   Sistema habilitado: ${config.new_entries_enabled ? '✅ SÍ' : '❌ NO'}`);
        console.log(`   Posiciones abiertas: ${openSnap.size}`);
        
        if (openSnap.size > 0) {
            openSnap.docs.forEach(doc => {
                const p = doc.data();
                console.log(`      • ${p.symbol} @ ${p.entry_price} USDT`);
            });
        }
        
        console.log(`   Total cerradas: ${newClosedCount}`);
        
        if (newClosures > 0) {
            console.log(`\n✅ NUEVAS CIERRES: ${newClosures}`);
            latestClosed.forEach(c => {
                console.log(`   • ${c.symbol} PnL: ${c.pnl} USDT (${c.reason})`);
            });
            console.log(`   📈 PnL Total: ${totalPnL} USDT`);
        }
        
        console.log(`\n💰 CAPITAL:`);
        console.log(`   Disponible: ${balance.available_usdt || 0} USDT`);
        console.log(`   En posiciones: ${balance.in_positions_usdt || 0} USDT`);
        console.log(`   Total: ${(balance.available_usdt || 0) + (balance.in_positions_usdt || 0)} USDT`);
        
        // Check for system health issues
        if (!config.new_entries_enabled) {
            console.log('\n⚠️  ALERTA: Sistema está deshabilitado para nuevas entradas!');
        }
        
        if (config.disable_after_first_entry === true) {
            console.log('\n⚠️  ALERTA: Flag disable_after_first_entry está activo!');
        }
        
        lastClosedCount = newClosedCount;
        lastCheckTime = now;
        
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ❌ Error:`, err.message);
    }
}

// Initial info
console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║        MONITOREO EN VIVO - TRADING CONTINUO                     ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('\nVerificando estado cada 30 segundos...');
console.log('Presiona Ctrl+C para detener.\n');

// Initial check
monitorStatus();

// Check every 30 seconds
setInterval(monitorStatus, 30000);

// Keep process alive
process.on('SIGINT', () => {
    console.log('\n\nMonitoreo terminado.');
    process.exit(0);
});
