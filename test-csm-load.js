// Quick test to verify CriticalSafetyMonitor can be required
console.log('Testing CriticalSafetyMonitor require...');

try {
  const csm = require('./backend/lib/critical_safety_monitor');
  console.log('✓ Module loaded successfully');
  console.log('✓ Exported functions:', Object.keys(csm));
  process.exit(0);
} catch (err) {
  console.error('✗ Error loading module:', err.message);
  console.error('Stack:', err.stack);
  process.exit(1);
}
