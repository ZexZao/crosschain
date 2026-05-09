// Shared summary generator — called by test scripts after results are saved.
// Reads a results JSON file and generates a formatted markdown summary table.

const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

function saveForwardSummary(resultsFile) {
  const data = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, resultsFile), 'utf8'));
  const results = data.results || [];
  const total = results.length;
  const pass = results.filter(r => r.pass).length;
  const fail = total - pass;

  let md = '# 正向跨链测试结果 (Fabric → EVM)\n\n';
  md += `**测试时间**：${new Date().toISOString()}\n`;
  md += `**通过率**：${pass}/${total} | **签名方案**：ECDSA threshold (3/4) | **证明类型**：hybrid-v3 | **合约**：VerifierContractV3\n\n`;
  md += '| 用例 | 业务 | 金额 | Fabric 区块 | EVM Gas | 端到端时延 | 字段 | 状态 |\n';
  md += '|------|------|------|------------|---------|------------|------|------|\n';

  let gasTotal = 0, timeTotal = 0, blkTotal = 0;
  for (const r of results) {
    const g = parseInt(r.gasUsed) || 0; gasTotal += g;
    const t = parseInt(r.totalMs) || 0; timeTotal += t;
    const b = parseInt(r.srcHeight) || 0; blkTotal += b;
    const f = r.fieldCheck || {};
    md += `| ${r.caseId} | ${r.expectedTargetFields?.op||'-'} | ${r.expectedTargetFields?.amount||'-'} | ${b} | ${g.toLocaleString()} | ${t}ms | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${r.pass?'✅':'❌'} |\n`;
  }
  const n = results.length || 1;
  md += `\n| **平均** | | | **${Math.round(blkTotal/n)}** | **${Math.round(gasTotal/n).toLocaleString()}** | **${Math.round(timeTotal/n)}ms** | **${pass}/${total}** | **${pass}/${total}** |\n`;

  const outPath = path.join(RUNTIME_DIR, 'test-summary.md');
  fs.writeFileSync(outPath, md);
  console.log(`\nFormatted summary saved to: runtime/test-summary.md`);
  return outPath;
}

function saveRoundtripSummary(resultsFile) {
  const data = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, resultsFile), 'utf8'));
  const results = data.results || [];
  const total = results.length;
  const pass = results.filter(r => r.pass).length;
  const fail = total - pass;

  let md = '# 闭环跨链测试结果 (Fabric → EVM → Fabric ACK)\n\n';
  md += `**测试时间**：${new Date().toISOString()}\n`;
  md += `**通过率**：${pass}/${total} | **签名方案**：ECDSA threshold (3/4) | **证明类型**：hybrid-v3 | **合约**：VerifierContractV3\n\n`;
  md += '| 用例 | 业务 | 金额 | 正向 Gas | ACK (BLS+TEE) | 字段 | 总耗时 | 状态 |\n';
  md += '|------|------|------|----------|---------------|------|--------|------|\n';

  let gasTotal = 0, timeTotal = 0;
  for (const r of results) {
    const g = parseInt(r.forwardGasUsed) || parseInt(r.gasUsed) || 0; gasTotal += g;
    const t = parseInt(r.totalMs) || 0; timeTotal += t;
    const f = r.fieldCheck || {};
    const ackOk = r.ackFabricResult?.fabricResult?.includes('"ok":true');
    md += `| ${r.caseId} | ${r.expectedTargetFields?.op||'-'} | ${r.expectedTargetFields?.amount||'-'} | ${g.toLocaleString()} | ${ackOk?'✅ confirmed':'❌'} | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${t}ms | ${r.pass?'✅':'❌'} |\n`;
  }
  const n = results.length || 1;
  md += `\n| **平均** | | | **${Math.round(gasTotal/n).toLocaleString()}** | **${pass}/${total}** | **${pass}/${total}** | **${Math.round(timeTotal/n)}ms** | **${pass}/${total}** |\n`;

  // ACK verification path section (only relevant for roundtrip)
  md += '\n## ACK 验证链路\n\n';
  md += '| 步骤 | 说明 |\n';
  md += '|------|------|\n';
  md += '| BLS 聚合签名 | 4 EVM validator 签名聚合 (3/4 阈值) |\n';
  md += '| TEE 验证 | /attest 端点, 验证 eventProof + finalityInfo + BLS aggregateSig |\n';
  md += '| TEE 签名 | attestDigest = keccak256(reportHash, teePubKey) |\n';
  md += '| Fabric 链码 | ConfirmAckXMsg attestDigest 验证 |\n';
  md += '| Gateway 复用 | ACK 守护进程复用连接, 每用例 ~5.7s |\n';

  const outPath = path.join(RUNTIME_DIR, 'test-summary.md');
  fs.writeFileSync(outPath, md);
  console.log(`\nFormatted summary saved to: runtime/test-summary.md`);
  return outPath;
}

// CLI: node scripts/save-summary.js <forward|roundtrip|combined> [results-file]
if (require.main === module) {
  const mode = process.argv[2] || 'forward';
  const file = process.argv[3] || (mode === 'roundtrip' ? 'fabric-full-roundtrip-results.json' : 'fabric-hybrid-e2e-results.json');
  if (mode === 'roundtrip') {
    saveRoundtripSummary(file);
  } else if (mode === 'combined') {
    saveCombinedSummary();
  } else {
    saveForwardSummary(file);
  }
}

function saveCombinedSummary() {
  let md = '';

  // Forward section
  const fwdPath = path.join(RUNTIME_DIR, 'fabric-hybrid-e2e-results.json');
  if (fs.existsSync(fwdPath)) {
    const fwd = JSON.parse(fs.readFileSync(fwdPath, 'utf8'));
    const results = fwd.results || [];
    const total = results.length;
    const pass = results.filter(r => r.pass).length;
    md += '# 一、正向测试 (Fabric → EVM)\n\n';
    md += `**通过率**：${pass}/${total} | **签名方案**：ECDSA threshold (3/4) | **证明类型**：hybrid-v3 | **合约**：VerifierContractV3\n\n`;
    md += '| 用例 | 业务 | 金额 | Fabric 区块 | EVM Gas | 端到端时延 | 字段 | 状态 |\n';
    md += '|------|------|------|------------|---------|------------|------|------|\n';
    let gs = 0, ts = 0, bs = 0;
    for (const r of results) {
      const g = parseInt(r.gasUsed) || 0; gs += g;
      const t = parseInt(r.totalMs) || 0; ts += t;
      const b = parseInt(r.srcHeight) || 0; bs += b;
      const f = r.fieldCheck || {};
      md += `| ${r.caseId} | ${r.expectedTargetFields?.op||'-'} | ${r.expectedTargetFields?.amount||'-'} | ${b} | ${g.toLocaleString()} | ${t}ms | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${r.pass?'✅':'❌'} |\n`;
    }
    const n = results.length || 1;
    md += `\n| **平均** | | | **${Math.round(bs/n)}** | **${Math.round(gs/n).toLocaleString()}** | **${Math.round(ts/n)}ms** | **${pass}/${total}** | **${pass}/${total}** |\n\n`;
  }

  // Round-trip section
  const rtPath = path.join(RUNTIME_DIR, 'fabric-full-roundtrip-results.json');
  if (fs.existsSync(rtPath)) {
    const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
    const results = rt.results || [];
    const total = results.length;
    const pass = results.filter(r => r.pass).length;
    md += '# 二、闭环测试 (Fabric → EVM → Fabric ACK)\n\n';
    md += `**通过率**：${pass}/${total} | **签名方案**：ECDSA threshold (3/4)\n\n`;
    md += '| 用例 | 业务 | 金额 | 正向 Gas | ACK (BLS+TEE) | 字段 | 总耗时 | 状态 |\n';
    md += '|------|------|------|----------|---------------|------|--------|------|\n';
    let gs = 0, ts = 0;
    for (const r of results) {
      const g = parseInt(r.forwardGasUsed) || parseInt(r.gasUsed) || 0; gs += g;
      const t = parseInt(r.totalMs) || 0; ts += t;
      const f = r.fieldCheck || {};
      const ackOk = r.ackFabricResult?.fabricResult?.includes('\"ok\":true');
      md += `| ${r.caseId} | ${r.expectedTargetFields?.op||'-'} | ${r.expectedTargetFields?.amount||'-'} | ${g.toLocaleString()} | ${ackOk?'✅ confirmed':'❌'} | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${t}ms | ${r.pass?'✅':'❌'} |\n`;
    }
    const n = results.length || 1;
    md += `\n| **平均** | | | **${Math.round(gs/n).toLocaleString()}** | **${pass}/${total}** | **${pass}/${total}** | **${Math.round(ts/n)}ms** | **${pass}/${total}** |\n\n`;

    md += '## ACK 验证链路\n\n';
    md += '| 步骤 | 说明 |\n|------|------|\n';
    md += '| BLS 聚合签名 | 4 EVM validator 签名聚合 (3/4 阈值) |\n';
    md += '| TEE 验证 | /attest 端点, 验证 eventProof + finalityInfo + BLS aggregateSig |\n';
    md += '| TEE 签名 | attestDigest = keccak256(reportHash, teePubKey) |\n';
    md += '| Fabric 链码 | ConfirmAckXMsg attestDigest 验证 |\n';
    md += '| Gateway 复用 | ACK 守护进程复用连接 |\n';
  }

  md = `**测试时间**：${new Date().toISOString()}\n\n` + md;
  const outPath = path.join(RUNTIME_DIR, 'test-summary.md');
  fs.writeFileSync(outPath, md);
  console.log(`\nCombined summary saved to: runtime/test-summary.md`);
  return outPath;
}

module.exports = { saveForwardSummary, saveRoundtripSummary, saveCombinedSummary };
