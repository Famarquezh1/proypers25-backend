const fs = require('fs');
const content = fs.readFileSync('src/app/servicios/auth.service.ts', 'utf8');
const lines = content.split(/\\r?\\n/);
lines.forEach((line, index) => {
  if (line.includes('console.log')) {
    console.log(index + 1, JSON.stringify(line));
  }
});
