const { ethers } = require('ethers');
const { ensureRuntime, writeJSON, readJSON, nowMs } = require('../shared/utils');
const { buildXmsgFromEvmEvent } = require('../proof-builder/evm-proof-builder');

function normalizeArgv(argv) {
  const options = {
    rpc: process.env.EVM_RPC || 'http://127.0.0.1:8545',
    mode: process.env.EVM_LISTENER_MODE || 'forward'
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--rpc') options.rpc = args[++i];
    else if (arg === '--mode') options.mode = args[++i];
  }
  return options;
}

function getForwardEventConfig(deployment) {
  if (!deployment.evmSourceContract) {
    throw new Error('deployment.json missing evmSourceContract; run deploy first');
  }
  return {
    address: deployment.evmSourceContract,
    abi: ['event FabricCallRequested(uint64 indexed nonce, address indexed requester, string payloadJson)'],
    eventName: 'FabricCallRequested',
    dstChainName: 'fabric-mychannel',
    dstContract: ethers.ZeroAddress,
    captureFile: 'evm-captured-event.json',
    xmsgFile: 'latest-evm-xmsg.json'
  };
}

function getAckEventConfig(deployment) {
  if (!deployment.targetContract) {
    throw new Error('deployment.json missing targetContract; run deploy first');
  }
  return {
    address: deployment.targetContract,
    abi: ['event BusinessExecuted(bytes32 indexed requestID,address indexed caller,string op,string recordId,string actor,string amount)'],
    eventName: 'BusinessExecuted',
    dstChainName: 'fabric-mychannel',
    dstContract: ethers.ZeroAddress,
    captureFile: 'evm-ack-captured-event.json',
    xmsgFile: 'latest-ack-xmsg.json'
  };
}

async function handleLog(provider, deployment, config, mode, log) {
  const iface = new ethers.Interface(config.abi);
  const parsed = iface.parseLog(log);
  const block = await provider.getBlock(log.blockNumber);
  const listenerReceivedAtMs = nowMs();

  let rawPayload;
  let nonce;
  if (mode === 'forward') {
    rawPayload = JSON.parse(parsed.args.payloadJson);
    nonce = Number(parsed.args.nonce);
  } else {
    rawPayload = {
      op: 'ack_confirm',
      originRequestID: parsed.args.requestID,
      status: 'success',
      relayTxHash: log.transactionHash,
      targetOp: parsed.args.op,
      targetRecordId: parsed.args.recordId,
      targetActor: parsed.args.actor,
      targetAmount: parsed.args.amount
    };
    nonce = Number(log.index);
  }

  const captured = {
    networkName: 'evm-localhost',
    emitterAddress: config.address,
    eventName: config.eventName,
    rawPayload,
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    logIndex: log.index,
    nonce,
    dstChainName: config.dstChainName,
    dstContract: config.dstContract,
    listenerTiming: {
      listenerReceivedAtMs,
      listenerReceivedAt: new Date(listenerReceivedAtMs).toISOString()
    }
  };

  writeJSON(config.captureFile, captured);
  const xmsg = await buildXmsgFromEvmEvent({
    deployment,
    ...captured
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
    mode,
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
  const config = options.mode === 'ack' ? getAckEventConfig(deployment) : getForwardEventConfig(deployment);
  const iface = new ethers.Interface(config.abi);
  const topic = iface.getEvent(config.eventName).topicHash;
  let nextBlock = await provider.getBlockNumber();

  console.log(`Listening EVM ${options.mode} events on ${config.address}:${config.eventName}`);

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
          await handleLog(provider, deployment, config, options.mode, log);
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
