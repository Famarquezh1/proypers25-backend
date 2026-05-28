const https = require('https');
const db = require('./firebase-admin-config.js');

// Function to fetch Binance price
function getBinancePrice(symbol) {
    return new Promise((resolve, reject) => {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(parseFloat(JSON.parse(data).price));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function monitorPositions() {
    try {
        console.log('\n🔄 MONITOREO EN VIVO - ' + new Date().toLocaleString('es-ES'));
        console.log('='.repeat(70));

        // Get positions from Firestore
        const positionsSnap = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_OPEN')
            .get();

        if (positionsSnap.empty) {
            console.log('❌ Sin posiciones abiertas');
            process.exit(0);
        }

        let totalCapital = 0;
        let gainedCapital = 0;

        for (const doc of positionsSnap.docs) {
            const position = doc.data();
            const { symbol, entry_price, executed_quantity, capital_usdt } = position;
            const baseSymbol = symbol.replace('USDT', '');

            try {
                // Get current price
                const currentPrice = await getBinancePrice(baseSymbol);
                const currentValue = currentPrice * executed_quantity;
                const profit = currentValue - capital_usdt;
                const profitPct = (profit / capital_usdt) * 100;

                totalCapital += capital_usdt;
                gainedCapital += profit;

                // Calculate TP levels (for moonshot: 50%, 150%, 500%)
                const tp1 = entry_price * 1.5; // +50%
                const tp2 = entry_price * 2.5; // +150%
                const tp3 = entry_price * 6.0; // +500%
                const sl = entry_price * 0.8; // -20%

                const distToTP1 = ((currentPrice - entry_price) / entry_price) * 100;
                const distToTP2 = ((currentPrice - entry_price) / entry_price) * 100;
                const distToTP3 = ((currentPrice - entry_price) / entry_price) * 100;
                const distToSL = ((currentPrice - entry_price) / entry_price) * 100;

                console.log(`\n📊 ${symbol}`);
                console.log('-'.repeat(70));
                console.log(`  Entry: ${entry_price.toFixed(8)} USDT | Current: ${currentPrice.toFixed(8)} USDT`);
                console.log(`  Qty: ${executed_quantity.toFixed(2)} | Capital: ${capital_usdt.toFixed(2)} USDT`);
                console.log(`\n  📈 Progreso hacia Take Profits:`);
                console.log(`     TP1 (+50%, ${tp1.toFixed(8)}):   ${distToTP1.toFixed(2)}% ${distToTP1 >= 50 ? '✅ ALCANZADO' : '→ ' + (50 - distToTP1).toFixed(2) + '% falta'}`);
                console.log(`     TP2 (+150%, ${tp2.toFixed(8)}):  ${distToTP2.toFixed(2)}% ${distToTP2 >= 150 ? '✅ ALCANZADO' : '→ ' + (150 - distToTP2).toFixed(2) + '% falta'}`);
                console.log(`     TP3 (+500%, ${tp3.toFixed(8)}):  ${distToTP3.toFixed(2)}% ${distToTP3 >= 500 ? '✅ ALCANZADO' : '→ ' + (500 - distToTP3).toFixed(2) + '% falta'}`);
                console.log(`     🛑 SL (-20%, ${sl.toFixed(8)}):   ${distToSL.toFixed(2)}% ${distToSL <= -20 ? '❌ ALCANZADO' : '← ' + (Math.abs(distToSL) - 20).toFixed(2) + '% seguro'}`);

                const gainColor = profit >= 0 ? '🟢' : '🔴';
                console.log(`\n  ${gainColor} Ganancia actual: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} USDT (${profit >= 0 ? '+' : ''}${profitPct.toFixed(2)}%)`);

            } catch (err) {
                console.log(`\n  ⚠️ ${symbol}: Error obteniendo precio - ${err.message}`);
            }
        }

        console.log('\n' + '='.repeat(70));
        console.log('\n💼 RESUMEN TOTAL:');
        console.log(`   Capital total en riesgo: ${totalCapital.toFixed(2)} USDT`);
        const totalProfitColor = gainedCapital >= 0 ? '🟢' : '🔴';
        const totalProfitPct = (gainedCapital / totalCapital) * 100;
        console.log(`   ${totalProfitColor} Ganancia total: ${gainedCapital >= 0 ? '+' : ''}${gainedCapital.toFixed(2)} USDT (${gainedCapital >= 0 ? '+' : ''}${totalProfitPct.toFixed(2)}%)`);
        console.log('\n');

    } catch (error) {
        console.error('Error:', error.message);
    }

    process.exit(0);
}

monitorPositions();
