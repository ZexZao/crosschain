const { CROSS_CHAIN_CALL_TOPIC, parseCrossChainCallLog } = require('../../../../hxmsg-builder/source-builders/evm');
const { EvmLogScanner } = require('../evm/scanner-base');

class EthereumEventScanner extends EvmLogScanner {
  constructor(options) {
    super({
      ...options,
      topic: CROSS_CHAIN_CALL_TOPIC,
      parseLog: parseCrossChainCallLog,
      eventType: 'CROSS_CHAIN_REQUEST',
    });
  }
}

module.exports = { EthereumEventScanner };
