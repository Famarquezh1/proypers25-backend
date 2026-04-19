// Quick test to verify the module can be required
console.log('Testing require of critical_safety_monitor...');

try {
  const CriticalSafetyMonitor = require('./lib/critical_safety_monitor');
  console.log('✅ Successfully required critical_safety_monitor');
  console.log('Exported functions:', Object.keys(CriticalSafetyMonitor));

  // Check if functions exist
  if (!CriticalSafetyMonitor.getCriticalAlertsSummary) {
    console.log('❌ getCriticalAlertsSummary is not exported');
  }
  if (!CriticalSafetyMonitor.getSystemHeartbeats) {
    console.log('❌ getSystemHeartbeats is not exported');
  }
  if (!CriticalSafetyMonitor.runCriticalSafetyCheck) {
    console.log('❌ runCriticalSafetyCheck is not exported');
  }

  if (CriticalSafetyMonitor.getCriticalAlertsSummary &&
      CriticalSafetyMonitor.getSystemHeartbeats &&
      CriticalSafetyMonitor.runCriticalSafetyCheck) {
    console.log('✅ All required functions are exported');
  }
} catch (err) {
  console.error('❌ Error requiring critical_safety_monitor:', err.message);
  console.error('Stack:', err.stack);
}
