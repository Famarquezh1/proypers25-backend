const db = require('./firebase-admin-config.js');
const https = require('https');

/**
 * ANÁLISIS DE DESCUBRIMIENTO DE OPORTUNIDADES
 * Último 24h: ¿Qué oportunidades existieron vs qué el sistema vio?
 */

// Helpers para fetch de datos
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function analyzeDiscoveryCapability() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 ANÁLISIS DE DESCUBRIMIENTO: Últimas 24h');
        console.log('='.repeat(80));

        const now = new Date();
        const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

        // PARTE 1: QUÉ VIO EL SISTEMA
        console.log(`\n📊 PARTE 1: QUÉ VIERON LOS CANDIDATOS DEL SISTEMA`);
        console.log(`Período: ${oneDayAgo.toISOString().substring(0, 16)} → ${now.toISOString().substring(0, 16)}\n`);

        // Buscar documentos de candidatos (sin filtro de fecha si no hay timestamp)
        let candidatesSnapshot;
        try {
            candidatesSnapshot = await db.collection('spot_opportunity_candidates').limit(100).get();
        } catch (e) {
            candidatesSnapshot = await db.collection('spot_opportunity_candidates').get();
        }

        const candidates = [];
        candidatesSnapshot.forEach(doc => {
            candidates.push(doc.data());
        });

        console.log(`Candidatos evaluados en últimas 24h: ${candidates.length}`);

        if (candidates.length > 0) {
            // Agrupar por score
            const byScore = {};
            candidates.forEach(c => {
                const score = Math.round(c.composite_score / 10) * 10;
                if (!byScore[score]) byScore[score] = [];
                byScore[score].push(c);
            });

            console.log('\nDistribución por score:');
            Object.keys(byScore)
                .sort((a, b) => b - a)
                .forEach(score => {
                    console.log(`  [${score}]: ${byScore[score].length} pares`);
                });

            // Top 10 candidatos
            const top10 = candidates
                .sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0))
                .slice(0, 10);

            console.log('\nTop 10 candidatos detectados:');
            top10.forEach((c, idx) => {
                console.log(`  ${idx + 1}. ${c.symbol} | Score: ${(c.composite_score || 0).toFixed(0)} | Vol24h: ${(c.volume_24h || 0).toFixed(0)}`);
            });
        } else {
            console.log('⚠️ Sin datos de candidatos en últimas 24h (puede ser tiempo de cooldown)');
        }

        // PARTE 2: QUÉ FUE EJECUTADO
        console.log(`\n📈 PARTE 2: QUÉ FUE EJECUTADO EN ÚLTIMAS 24h\n`);

        let executedSnapshot;
        try {
            executedSnapshot = await db.collection('real_spot_positions')
                .where('opened_at', '>=', oneDayAgo)
                .where('opened_at', '<=', now)
                .get();
        } catch (e) {
            // Si el filtro de fecha falla, obtener todos y filtrar después
            const allPositions = await db.collection('real_spot_positions').get();
            executedSnapshot = {
                forEach: (cb) => {
                    allPositions.forEach(doc => {
                        const data = doc.data();
                        const openTime = new Date(data.opened_at);
                        if (openTime >= oneDayAgo && openTime <= now) {
                            cb(doc);
                        }
                    });
                }
            };
        }

        const executed = [];
        executedSnapshot.forEach(doc => {
            executed.push(doc.data());
        });

        console.log(`Trades ejecutados: ${executed.length}`);

        if (executed.length > 0) {
            executed.forEach((e, idx) => {
                console.log(`  ${idx + 1}. ${e.symbol} | Entry: ${e.entry_price.toFixed(8)} | Capital: ${e.capital_usdt} USDT | Strategy: ${e.strategy}`);
            });
        }

        // PARTE 3: ANÁLISIS DEL MERCADO REAL
        console.log(`\n🌍 PARTE 3: MERCADO REAL ÚLTIMA 24h\n`);

        console.log('⏳ Obteniendo data de mercado (CoinGecko)...');

        try {
            // Top gainers últimas 24h
            let marketResponse = await fetchJSON(
                'https://api.coingecko.com/api/v3/coins/markets?' +
                'vs_currency=usd&order=market_cap_desc&per_page=250'
            );

            // Si la respuesta es objeto con 'data', extraer array
            if (marketResponse.data && Array.isArray(marketResponse.data)) {
                marketResponse = marketResponse.data;
            }

            // Validar que es array
            if (!Array.isArray(marketResponse)) {
                console.log(`\n⚠️ Response de CoinGecko inesperado: ${typeof marketResponse}`);
                console.log(`   Intentando acceso directo...`);
                // Si es un objeto, intentar encontrar array dentro
                const possibleArray = Object.values(marketResponse).find(v => Array.isArray(v));
                if (possibleArray) {
                    marketResponse = possibleArray;
                } else {
                    throw new Error('No se pudo parsear response como array');
                }
            }

            // Filtrar por gainers significativos
            const gainers24h = marketResponse
                .filter(coin => coin && coin.market_cap && coin.market_cap > 100000) // > $100k market cap
                .filter(coin => coin.price_change_percentage_24h !== null && coin.price_change_percentage_24h !== undefined && coin.price_change_percentage_24h > 0)
                .sort((a, b) => (b.price_change_percentage_24h || 0) - (a.price_change_percentage_24h || 0))
                .slice(0, 50);

            const gainers20plus = gainers24h.filter(c => (c.price_change_percentage_24h || 0) > 20);
            const gainers40plus = gainers24h.filter(c => (c.price_change_percentage_24h || 0) > 40);
            const gainers100plus = gainers24h.filter(c => (c.price_change_percentage_24h || 0) > 100);

            console.log(`Monedas con gain > 20% (24h): ${gainers20plus.length}`);
            console.log(`Monedas con gain > 40% (24h): ${gainers40plus.length}`);
            console.log(`Monedas con gain > 100% (24h): ${gainers100plus.length}`);

            console.log('\nTop gainers (+20%):');
            gainers20plus.slice(0, 15).forEach((coin, idx) => {
                const symbol = coin.symbol ? coin.symbol.toUpperCase() + 'USDT' : 'UNKNOWN';
                console.log(`  ${idx + 1}. ${symbol} | +${coin.price_change_percentage_24h.toFixed(2)}% | Cap: $${coin.market_cap ? (coin.market_cap / 1e6).toFixed(1) : 0}M`);
            });

            // PARTE 4: COMPARACIÓN GAPS
            console.log(`\n${'='.repeat(80)}`);
            console.log('🔬 PARTE 4: ANÁLISIS DE GAPS\n');

            const executedSymbols = executed.map(e => e.symbol.replace('USDT', '').toLowerCase());
            const gainersSymbols = gainers20plus.map(c => c.symbol.toLowerCase());

            const executedButNotTop = executed.filter(e => {
                const sym = e.symbol.replace('USDT', '').toLowerCase();
                return !gainersSymbols.includes(sym);
            });

            const toppingButNotExecuted = gainers20plus.filter(c => {
                const sym = c.symbol.toLowerCase();
                return !executedSymbols.includes(sym);
            });

            console.log(`Trades ejecutados que NO están en top gainers: ${executedButNotTop.length}`);
            executedButNotTop.forEach(t => {
                console.log(`  • ${t.symbol}`);
            });

            console.log(`\nTop gainers que NO fueron ejecutados: ${toppingButNotExecuted.length}`);
            toppingButNotExecuted.slice(0, 10).forEach(t => {
                console.log(`  • ${t.symbol.toUpperCase()}USDT | +${t.price_change_percentage_24h.toFixed(2)}%`);
            });

            // PARTE 5: HALLAZGOS CUALITATIVOS
            console.log(`\n${'='.repeat(80)}`);
            console.log('📝 PARTE 5: HALLAZGOS Y CONCLUSIONES\n');

            if (executed.length === 0) {
                console.log(`⚠️ HALLAZGO 1: NO HAY TRADES EJECUTADOS`);
                console.log(`   Mientras el mercado tuvo ${gainers20plus.length} pares con gain > 20%`);
                console.log(`   El sistema no ejecutó NADA`);
                console.log(`\n   Posibles causas:`);
                console.log(`   a) Suppression logic activada (cooldowns, rate limits)`);
                console.log(`   b) Score threshold muy alto (min 70?)`);
                console.log(`   c) Ningún par alcanzó threshold requerido`);
                console.log(`   d) Pool vacío de capital / límites de entrada`);
            } else if (executedButNotTop.length === executed.length) {
                console.log(`⚠️ HALLAZGO 2: SELECCIÓN CONTRARIA AL MERCADO`);
                console.log(`   Ejecutó pares que NO ganaron 20%+`);
                console.log(`   Mientras ignoró los top gainers`);
                console.log(`\n   Interpretación:`);
                console.log(`   → Sistema busca ANTIFRAGILITY (entra donde otros no)`);
                console.log(`   → O: Score no correlaciona con momentum real`);
            } else if (executed.length > 0 && gainersSymbols.includes(executedSymbols[0])) {
                console.log(`✅ HALLAZGO 3: SINCRONIZACIÓN CORRECTA`);
                console.log(`   Ejecutó pares que sí están en top gainers`);
                console.log(`   → Sistema SÍ detectó oportunidades reales`);
            }

            // PARTE 6: RATIO DE DESCUBRIMIENTO
            console.log(`\n${'='.repeat(80)}`);
            console.log('📊 PARTE 6: RATIO DE DESCUBRIMIENTO\n');

            const detectionRatio = executed.length > 0 ?
                (executed.filter(e => gainersSymbols.includes(e.symbol.replace('USDT', '').toLowerCase())).length / executed.length * 100) :
                0;

            const suppressionCount = candidates.length - (executed.length || 0);

            console.log(`Total candidatos considerados: ${candidates.length}`);
            console.log(`Total candidatos ejecutados: ${executed.length}`);
            console.log(`Ratio ejecución: ${candidates.length > 0 ? ((executed.length / candidates.length) * 100).toFixed(2) : 0}%`);
            console.log(`Candidatos suppressados/no ejecutados: ${suppressionCount}`);
            console.log(`\nDetección de mercado real: ${detectionRatio.toFixed(1)}%`);
            console.log(`  → Si es 0%, el sistema entra donde el mercado NO ve oportunidades`);
            console.log(`  → Si es 100%, el sistema sincroniza perfectamente con top gainers`);

            console.log(`\n${'='.repeat(80)}`);
            console.log('🎯 CONCLUSIÓN FINAL\n');

            if (detectionRatio === 0 && executed.length > 0) {
                console.log(`🔷 El sistema opera en MODO CONTRARIO AL MOMENTUM`);
                console.log(`   • Detecta "buenos pares" donde el mercado NO ve ganancias inmediatas`);
                console.log(`   • Esto es consistente con arquitectura ASIMÉTRICA`);
                console.log(`   • Los trades pueden ganar DESPUÉS cuando momentum late`);
                console.log(`   • No es "mal", es FILOSOFÍA DIFERENTE`);
            } else if (detectionRatio > 50 && executed.length > 0) {
                console.log(`✅ El sistema opera en SINCRONIZACIÓN CON MOMENTUM`);
                console.log(`   • Detecta y entra en pares que sí están en top gainers`);
                console.log(`   • Timing está probablemente correcto`);
                console.log(`   • Edge está en identificar ganadores ANTES de que exploten`);
            } else if (executed.length === 0) {
                console.log(`⚠️ El sistema está en MODO COOLDOWN/ESPERANDO`);
                console.log(`   • Puede estar suppressado por límites de entrada`);
                console.log(`   • O ningún par alcanzó score mínimo requerido`);
                console.log(`   • En un mercado con ${gainers20plus.length} oportunidades,`);
                console.log(`   • La inacción puede ser: a) Prudente, b) Demasiado restrictivo`);
            } else {
                console.log(`❓ PATRÓN MIXTO: Ejecutó algunos pero no todos los obvios`);
            }

        } catch (err) {
            console.log(`❌ Error obteniendo data de mercado: ${err.message}`);
            console.log(`   (API puede estar limitada o mercado down)`);
        }

    } catch (error) {
        console.error('Error general:', error.message);
    }
}

analyzeDiscoveryCapability();
