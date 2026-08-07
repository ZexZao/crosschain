const { connectFabric } = require('../../../fabric-client');
const { common } = require('fabric-protos');

class FabricEventScanner {
  constructor(options) {
    this.id = options.id;
    this.chainID = String(options.chainID);
    this.profile = options.profile;
    this.startBlock = options.startBlock === undefined ? null : Number(options.startBlock);
    this.eventNames = new Set(options.eventNames || [
      'XCALL',
      'ASSET_LOCKED_XCALL',
      'HXMSG_EXECUTED',
      'RESPONSE_COMPLETED',
      'CHALLENGE_STARTED',
      'REQUEST_COMPENSATED',
      'LIFECYCLE_CHECKPOINTED',
    ]);
    this.connection = null;
    this.listener = null;
  }

  async start(cursor, onEvent) {
    if (this.connection) return;
    this.connection = await connectFabric(this.profile);
    let startBlock;
    if (cursor?.lastScannedBlock !== undefined) {
      startBlock = Number(cursor.lastScannedBlock) + 1;
    } else if (this.startBlock !== null) {
      startBlock = this.startBlock;
    } else {
      const qscc = this.connection.network.getContract('qscc');
      const encodedInfo = await qscc.evaluateTransaction('GetChainInfo', this.profile.channel);
      const info = common.BlockchainInfo.decode(encodedInfo);
      startBlock = Number(info.height.toString());
    }
    this.listener = async (event) => {
      if (!this.eventNames.has(event.eventName)) return;
      const transaction = event.getTransactionEvent();
      if (!transaction.isValid) return;
      const blockHeight = Number(transaction.getBlockEvent().blockNumber.toString());
      let payload;
      try {
        payload = JSON.parse((event.payload || Buffer.alloc(0)).toString());
      } catch (_error) {
        payload = { rawPayload: (event.payload || Buffer.alloc(0)).toString('base64') };
      }
      await onEvent({
        eventID: `${this.chainID}:${transaction.transactionId}:${event.eventName}`,
        eventType: event.eventName,
        chainID: this.chainID,
        channelID: this.profile.channel,
        chaincodeID: this.profile.chaincode,
        blockHeight,
        blockHash: null,
        transactionID: transaction.transactionId,
        eventIndex: 0,
        requestID: payload.requestID || null,
        payload,
      }, {
        chainID: this.chainID,
        channelID: this.profile.channel,
        lastScannedBlock: blockHeight,
        lastTransactionID: transaction.transactionId,
      });
    };
    await this.connection.contract.addContractListener(this.listener, { startBlock });
  }

  async stop() {
    if (!this.connection) return;
    if (this.listener) this.connection.contract.removeContractListener(this.listener);
    this.connection.gateway.disconnect();
    this.connection = null;
    this.listener = null;
  }
}

module.exports = { FabricEventScanner };
