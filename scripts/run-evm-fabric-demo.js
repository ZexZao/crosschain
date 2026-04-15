const path = require('path');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForXmsg(projectRoot, txHash, relPath, timeoutMs = 20000) {
  const target = path.join(projectRoot, 'runtime', relPath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(target)) {
        const data = fs.readJsonSync(target);
        if (data.txId === txHash) {
          return data;
        }
      }
    } catch (_) {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${relPath} for txHash ${txHash}`);
}

async function main() {
  const projectRoot = path.join(__dirname, '..');
  const payloadArg = process.argv[2] || '';
  const invokeStdout = execFileSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'request-evm-fabric-call.js'),
    payloadArg
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  const invoke = JSON.parse(invokeStdout);
  await waitForXmsg(projectRoot, invoke.txHash, 'latest-evm-xmsg.json');

  const relayStdout = execFileSync(process.execPath, [
    path.join(projectRoot, 'relayer', 'evm-to-fabric.js')
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  console.log(relayStdout.trim());
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
