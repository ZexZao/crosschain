// Combined test entry point — runs both forward and round-trip tests.
// Usage: node scripts/run-all-tests.js [forward|full]
// Default: full (forward + round-trip)

const { execSync } = require('child_process');

const mode = process.argv[2] || 'full';

console.log('================================================================================');
console.log('  Cross-Chain E2E Test Suite (BLS + TEE Hybrid Bridge)');
console.log('================================================================================\n');

const tTotalStart = Date.now();

// Phase 1: Forward test
console.log('>>> Phase 1/2: Forward Test (Fabric → EVM)\n');
execSync('node scripts/run-fabric-e2e-tests.js', { stdio: 'inherit', cwd: __dirname + '/..' });

if (mode === 'full') {
  // Phase 2: Round-trip test
  console.log('\n>>> Phase 2/2: Round-Trip Test (Fabric → EVM → Fabric ACK)\n');
  execSync('node scripts/run-full-suite.js', { stdio: 'inherit', cwd: __dirname + '/..' });

  // Generate combined summary
  console.log('\n>>> Generating combined summary...');
  execSync('node scripts/save-summary.js combined', { stdio: 'inherit', cwd: __dirname + '/..' });
}

const totalSec = ((Date.now() - tTotalStart) / 1000).toFixed(1);
console.log(`\n================================================================================`);
console.log(`  Total test time: ${totalSec}s`);
console.log(`  Results: runtime/test-summary.md (表格汇总)`);
console.log(`================================================================================`);
