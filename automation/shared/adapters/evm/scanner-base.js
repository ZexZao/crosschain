const { ethers } = require('ethers');

function normalizeCheckpoint(block) {
  return { height: Number(block.number), hash: block.hash };
}

class EvmLogScanner {
  constructor(options) {
    this.id = options.id;
    this.chainID = String(options.chainID);
    this.provider = options.provider || new ethers.JsonRpcProvider(options.rpc);
    this.address = ethers.getAddress(options.address);
    this.topic = options.topic;
    this.parseLog = options.parseLog;
    this.batchSize = Number(options.batchSize || 500);
    this.reorgWindow = Number(options.reorgWindow || 64);
    this.startBlock = options.startBlock === undefined ? null : Number(options.startBlock);
    this.eventType = options.eventType || 'CROSS_CHAIN_REQUEST';
  }

  async reconcileCursor(cursor, latestHeight) {
    if (!cursor) {
      const first = this.startBlock === null ? latestHeight + 1 : this.startBlock;
      return { fromBlock: first, checkpoints: [], reorgFrom: null };
    }
    if (Number(cursor.lastScannedBlock || 0) > Number(latestHeight)) {
      return {
        fromBlock: this.startBlock === null ? 0 : this.startBlock,
        checkpoints: [],
        reorgFrom: -1,
      };
    }
    const checkpoints = Array.isArray(cursor.checkpoints) ? cursor.checkpoints : [];
    if (!checkpoints.length || Number(cursor.lastScannedBlock || 0) <= 0) {
      return { fromBlock: Number(cursor.lastScannedBlock || 0) + 1, checkpoints, reorgFrom: null };
    }
    const last = checkpoints[checkpoints.length - 1];
    const canonical = await this.provider.getBlock(Number(last.height));
    if (canonical?.hash?.toLowerCase() === String(last.hash).toLowerCase()) {
      return { fromBlock: Number(last.height) + 1, checkpoints, reorgFrom: null };
    }
    for (let i = checkpoints.length - 2; i >= 0; i -= 1) {
      const candidate = checkpoints[i];
      const block = await this.provider.getBlock(Number(candidate.height));
      if (block?.hash?.toLowerCase() === String(candidate.hash).toLowerCase()) {
        return {
          fromBlock: Number(candidate.height) + 1,
          checkpoints: checkpoints.slice(0, i + 1),
          reorgFrom: Number(candidate.height),
        };
      }
    }
    const fallback = Math.max(0, Number(cursor.lastScannedBlock || 0) - this.reorgWindow);
    return { fromBlock: fallback, checkpoints: [], reorgFrom: fallback - 1 };
  }

  async scan(cursor) {
    const latestHeight = await this.provider.getBlockNumber();
    const reconciled = await this.reconcileCursor(cursor, latestHeight);
    if (reconciled.fromBlock > latestHeight) {
      return {
        events: [],
        cursor: {
          ...(cursor || {}),
          chainID: this.chainID,
          lastScannedBlock: Number(cursor?.lastScannedBlock || latestHeight),
          checkpoints: reconciled.checkpoints,
          reorgFrom: reconciled.reorgFrom,
        },
      };
    }
    const toBlock = Math.min(latestHeight, reconciled.fromBlock + this.batchSize - 1);
    const logs = await this.provider.getLogs({
      address: this.address,
      topics: [this.topic],
      fromBlock: reconciled.fromBlock,
      toBlock,
    });
    const events = logs.map((log) => {
      const parsed = this.parseLog(log);
      return {
        eventID: `${this.chainID}:${log.transactionHash}:${Number(log.index)}`,
        eventType: this.eventType,
        chainID: this.chainID,
        sourceAddress: this.address,
        blockHeight: Number(log.blockNumber),
        blockHash: log.blockHash,
        transactionID: log.transactionHash,
        eventIndex: Number(log.index),
        requestID: parsed.requestID,
        payload: parsed,
      };
    });
    const checkpoints = [...reconciled.checkpoints];
    for (let height = Math.max(reconciled.fromBlock, toBlock - this.reorgWindow + 1); height <= toBlock; height += 1) {
      const block = await this.provider.getBlock(height);
      if (block) checkpoints.push(normalizeCheckpoint(block));
    }
    const unique = new Map(checkpoints.map((item) => [Number(item.height), item]));
    const retained = [...unique.values()]
      .sort((a, b) => a.height - b.height)
      .slice(-this.reorgWindow);
    const tip = retained[retained.length - 1] || null;
    return {
      events,
      cursor: {
        chainID: this.chainID,
        lastScannedBlock: toBlock,
        lastScannedBlockHash: tip?.hash || null,
        checkpoints: retained,
        reorgFrom: reconciled.reorgFrom,
      },
    };
  }
}

module.exports = { EvmLogScanner };
