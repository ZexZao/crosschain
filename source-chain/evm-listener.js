const { ethers } = require('ethers');
const { ensureRuntime, writeJSON, readJSON, nowMs } = require('../shared/utils');
const { buildHXMsgFromEvmReceipt, CROSS_CHAIN_CALL_EVENT } = require('../hxmsg-builder/evm-to-fabric');

function normalizeArgv(argv) {
  const options = {
    rpc: process.env.EVM_RPC || 'http://127.0.0.1:8545',
    mode: 'forward'
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--rpc') options.rpc = args[++i];
  }
  return options;
}

function getForwardEventConfig(deployment) {
  if (!deployment.evmSourceContract) {
    throw new Error('deployment.json missing evmSourceContract; run deploy first');
  }
  return {
    address: deployment.evmSourceContract,
    abi: [CROSS_CHAIN_CALL_EVENT],
    eventName: 'CrossChainCallRequested',
    dstChainName: 'fabric-mychannel',
    dstContract: ethers.ZeroAddress,
    captureFile: 'evm-captured-event.json',
    xmsgFile: 'latest-evm-xmsg.json'
  };
}

async function handleLog(provider, deployment, config, log) {
  const iface = new ethers.Interface(config.abi);
  const parsed = iface.parseLog(log);
  const block = await provider.getBlock(log.blockNumber);
  const receipt = await provider.getTransactionReceipt(log.transactionHash);
  const listenerReceivedAtMs = nowMs();

  const rawPayload = readJSON('latest-evm-business-payload.json') || {};

  const captured = {
    networkName: 'evm-localhost',
    emitterAddress: config.address,
    eventName: config.eventName,
    rawPayload,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    logIndex: log.index,
    nonce: Number(parsed.args.nonce),
    dstChainName: config.dstChainName,
    dstContract: config.dstContract,
    listenerTiming: {
      listenerReceivedAtMs,
      listenerReceivedAt: new Date(listenerReceivedAtMs).toISOString()
    }
  };

  writeJSON(config.captureFile, captured);
  const xmsg = buildHXMsgFromEvmReceipt({
    deployment,
    receipt,
    block,
    businessPayload: rawPayload,
  });
  const xmsgWrittenAtMs = nowMs();
  xmsg.listenerTiming = {
    ...captured.listenerTiming,
    xmsgWrittenAtMs,
    xmsgWrittenAt: new Date(xmsgWrittenAtMs).toISOString(),
    processingMs: xmsgWrittenAtMs - listenerReceivedAtMs
  };
  writeJSON(config.xmsgFile, xmsg);
  console.log(JSON.stringify({
    ok: true,
    mode: 'forward',
    txHash: captured.txHash,
    requestID: xmsg.requestID,
    srcHeight: xmsg.srcHeight,
    listenerProcessingMs: xmsg.listenerTiming.processingMs,
    proofBuildMs: xmsg.proofMeta?.proofBuildMs || 0,
    proofType: xmsg.proofMeta?.proofType || 'evm-v1'
  }));
}

async function main() {
  ensureRuntime();
  const options = normalizeArgv(process.argv.slice(2));
  const deployment = readJSON('deployment.json');
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }
  const provider = new ethers.JsonRpcProvider(options.rpc);
  const config = getForwardEventConfig(deployment);
  const iface = new ethers.Interface(config.abi);
  const topic = iface.getEvent(config.eventName).topicHash;
  let nextBlock = await provider.getBlockNumber();

  console.log(`Listening EVM forward events on ${config.address}:${config.eventName}`);

  while (true) {
    try {
      const latestBlock = await provider.getBlockNumber();
      if (latestBlock >= nextBlock) {
        const logs = await provider.getLogs({
          address: config.address,
          topics: [topic],
          fromBlock: nextBlock,
          toBlock: latestBlock
        });
        for (const log of logs) {
          await handleLog(provider, deployment, config, log);
        }
        nextBlock = latestBlock + 1;
      }
    } catch (error) {
      console.error(`EVM event polling failed: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
