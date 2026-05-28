const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function analyzeFundDistribution() {
  console.log('\n?? FUND DISTRIBUTION ANALYSIS (From Firestore)\n');
  
  try {
    // 1. Get config for capital info
    const configSnap = await db.collection('real_spot_config').doc('control').get();
    const config = configSnap.data() || {};
    
    const TOTAL_CAPITAL = config.max_total_capital_usdt || 100;
    const CONSERVATIVE_CAPITAL = config.conservative_capital_usdt || 63;
    const MOONSHOT_CAPITAL = config.moonshot_capital_usdt || 27;
    
    console.log('?? CAPITAL ALLOCATION:');
    console.log(`   Total Available: ${TOTAL_CAPITAL} USDT`);
    console.log(`   Conservative Strategy (70%): ${CONSERVATIVE_CAPITAL} USDT`);
    console.log(`   Moonshot Strategy (30%): ${MOONSHOT_CAPITAL} USDT`);
    console.log('');
    
    // 2. Get all open positions
    console.log('?? OPEN POSITIONS:');
    const openPos = await db.collection('real_spot_positions')
      .where('status', 'in', ['open', 'OPEN'])
      .get();
    
    if (openPos.size === 0) {
      console.log('   No open positions currently.\n');
    } else {
      let totalUsed = 0;
      let conservativeUsed = 0;
      let moonshotUsed = 0;
      
      const positions = [];
      
      for (const doc of openPos.docs) {
        const pos = doc.data();
        const capital = pos.initial_capital || 15;
        totalUsed += capital;
        
        if (pos.strategy === 'CONSERVATIVE') {
          conservativeUsed += capital;
        } else if (pos.strategy === 'MOONSHOT') {
          moonshotUsed += capital;
        }
        
        const pnl = pos.profit_loss || {};
        const pnlPct = pnl.current_pnl_pct || 0;
        const pnlUsdt = pnl.current_pnl_usdt || 0;
        
        positions.push({
          symbol: pos.symbol,
          strategy: pos.strategy,
          capital: capital,
          entry: pos.entry_price,
          current: pos.current_price || pos.entry_price,
          pnl_usdt: pnlUsdt,
          pnl_pct: pnlPct
        });
      }
      
      // Sort by capital
      positions.sort((a, b) => b.capital - a.capital);
      
      console.log(`   Total Positions: ${positions.length}`);
      console.log('');
      console.log('Symbol'.padEnd(12) + 'Strategy'.padEnd(14) + 'Capital'.padEnd(12) + 'Entry Price'.padEnd(14) + 'P&L %');
      console.log('='.repeat(70));
      
      for (const pos of positions) {
        const strategyLabel = pos.strategy === 'CONSERVATIVE' ? 'CONSERVATIVE' : 'MOONSHOT';
        console.log(
          pos.symbol.padEnd(12) +
          strategyLabel.padEnd(14) +
          (pos.capital.toFixed(2) + ' USDT').padEnd(12) +
          (pos.entry ? pos.entry.toFixed(8) : '0').padEnd(14) +
          pos.pnl_pct.toFixed(2) + '%'
        );
      }
      
      console.log('');
      console.log('USAGE SUMMARY:');
      console.log(`   Conservative Used: ${conservativeUsed}/${CONSERVATIVE_CAPITAL} USDT (${(conservativeUsed/CONSERVATIVE_CAPITAL*100).toFixed(1)}%)`);
      console.log(`   Moonshot Used: ${moonshotUsed}/${MOONSHOT_CAPITAL} USDT (${(moonshotUsed/MOONSHOT_CAPITAL*100).toFixed(1)}%)`);
      console.log(`   Total Used: ${totalUsed}/${TOTAL_CAPITAL} USDT (${(totalUsed/TOTAL_CAPITAL*100).toFixed(1)}%)`);
      console.log(`   Available: ${(TOTAL_CAPITAL - totalUsed).toFixed(2)} USDT`);
    }
    
    // 3. Get closed positions (last 5)
    console.log('\n?? RECENT CLOSED POSITIONS (Last 5):');
    try {
        const closedPos = await db.collection('real_spot_positions')
          .where('status', '==', 'CLOSED')
          .orderBy('closed_at', 'desc')
          .limit(5)
          .get();
        
        if (closedPos.size === 0) {
          console.log('   No closed positions yet.\n');
        } else {
          console.log('Symbol'.padEnd(12) + 'Strategy'.padEnd(14) + 'Result'.padEnd(12) + 'Exit Reason');
          console.log('='.repeat(70));
          
          for (const doc of closedPos.docs) {
            const pos = doc.data();
            const pnl = pos.final_pnl_usdt || 0;
            const reason = pos.close_reason || 'Unknown';
            const strategyLabel = pos.strategy === 'CONSERVATIVE' ? 'CONSERVATIVE' : 'MOONSHOT';
            
            const resultColor = pnl >= 0 ? '+' : '-';
            const resultStr = resultColor + Math.abs(pnl).toFixed(2) + ' USDT';
            
            console.log(
              pos.symbol.padEnd(12) +
              strategyLabel.padEnd(14) +
              resultStr.padEnd(12) +
              reason
            );
          }
        }
    } catch (indexErr) {
        console.log('   (Closed positions check failed - likely requires Firestore index)');
    }
    
    console.log('\n? Analysis complete\n');
    process.exit(0);
  } catch (err) {
    console.error('? Error:', err.message);
    process.exit(1);
  }
}

analyzeFundDistribution();
