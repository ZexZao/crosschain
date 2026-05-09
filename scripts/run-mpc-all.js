// MPC-TSS Combined Test Suite: forward + round-trip, auto-saves combined summary
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

console.log('='.repeat(60));
console.log('  MPC-TSS Combined Test Suite');
console.log('='.repeat(60));

const t0 = Date.now();

console.log('\n>>> Phase 1/2: Forward Test (MPC-TSS)\n');
execSync('node scripts/run-mpc-test.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

console.log('\n>>> Phase 2/2: Round-Trip Test (MPC-TSS)\n');
execSync('node scripts/run-mpc-roundtrip.js', { stdio: 'inherit', cwd: path.join(__dirname, '..') });

// Generate combined summary
const fwd = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'mpc-e2e-results.json'), 'utf8'));
const rt = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'mpc-roundtrip-results.json'), 'utf8'));

let md = '# MPC-TSS 双独立验证混合桥 测试结果\n\n';
md += `**测试时间**：${new Date().toISOString()}\n`;
md += `**签名方案**：MPC-TSS (single ECDSA) | **合约**：VerifierContractV3MPC\n\n`;

// Forward
md += '## 一、正向测试 (Fabric → EVM)\n\n';
md += `**通过率**：${fwd.pass}/${fwd.total}\n\n`;
md += '| 用例 | Gas | 端到端时延 | 字段 | 状态 |\n';
md += '|------|-----|------------|------|------|\n';
let fg = 0, ft = 0;
for (const r of fwd.results) {
  const g = parseInt(r.gasUsed) || 0; fg += g;
  const t = parseInt(r.totalMs) || 0; ft += t;
  const f = r.fieldCheck || {};
  md += `| ${r.caseId} | ${g.toLocaleString()} | ${t}ms | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${r.pass?'✅':'❌'} |\n`;
}
const fn = fwd.results.length || 1;
md += `\n| **平均** | **${Math.round(fg/fn).toLocaleString()}** | **${Math.round(ft/fn)}ms** | **${fwd.pass}/${fwd.total}** | **${fwd.pass}/${fwd.total}** |\n\n`;

// Round-trip
md += '## 二、闭环测试 (Fabric → EVM → Fabric ACK)\n\n';
md += `**通过率**：${rt.pass}/${rt.total}\n\n`;
md += '| 用例 | 正向 Gas | ACK | 字段 | 总耗时 | 状态 |\n';
md += '|------|----------|-----|------|--------|------|\n';
let rg = 0, rs = 0;
for (const r of rt.results) {
  const g = parseInt(r.forwardGasUsed) || 0; rg += g;
  const t = parseInt(r.totalMs) || 0; rs += t;
  const f = r.fieldCheck || {};
  const ackOk = r.ackFabricResult?.fabricResult?.includes('"ok":true');
  md += `| ${r.caseId} | ${g.toLocaleString()} | ${ackOk?'✅ confirmed':'❌'} | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${t}ms | ${r.pass?'✅':'❌'} |\n`;
}
const rn = rt.results.length || 1;
md += `\n| **平均** | **${Math.round(rg/rn).toLocaleString()}** | **${rt.pass}/${rt.total}** | **${rt.pass}/${rt.total}** | **${Math.round(rs/rn)}ms** | **${rt.pass}/${rt.total}** |\n`;

fs.writeFileSync(path.join(RUNTIME_DIR, 'test-summary.md'), md);

const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
console.log(`  Total: ${totalSec}s | Forward: ${fwd.pass}/${fwd.total} | Round-trip: ${rt.pass}/${rt.total}`);
console.log(`  Results: runtime/test-summary.md`);
console.log(`${'='.repeat(60)}`);
