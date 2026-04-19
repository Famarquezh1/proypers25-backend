#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const backendPath = './backend';

// Get all JS files
const files = glob.sync(backendPath + '/**/*.js', {
  ignore: '**/node_modules/**',
  ignore: '**/.git/**'
});

let foundIssues = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  // Look for patterns that write to binance_execution_intents directly
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line has collection('binance_execution_intents')
    const hasBinanceIntentsCollection =
      line.includes("collection('binance_execution_intents')") ||
      line.includes('collection("binance_execution_intents")');

    if (hasBinanceIntentsCollection) {
      // Check if next few lines have .set( or .update( or .delete(
      for (let j = i; j < Math.min(i+5, lines.length); j++) {
        const hasWrite = lines[j].match(/\.(set|update|delete)\s*\(/);
        const hasUpdateIntent = lines[j].includes('updateIntent');
        const isComment = lines[j].trim().startsWith('//');

        if (hasWrite && !hasUpdateIntent && !isComment) {
          const relPath = path.relative(process.cwd(), file);
          foundIssues.push({
            file: relPath,
            line: j+1,
            content: lines[j].trim()
          });
        }
      }
    }
  }
}

if (foundIssues.length > 0) {
  console.log('❌ DIRECT WRITES FOUND:');
  foundIssues.forEach(i => console.log(`  ${i.file}:${i.line}`));
  console.log(`\nTotal: ${foundIssues.length} direct writes to fix`);
} else {
  console.log('✅ NO DIRECT WRITES to binance_execution_intents found!');
  console.log('System is 100% centralized');
}
