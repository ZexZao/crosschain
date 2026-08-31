const { getExecutionData } = require('../../../../shared/hxmsg');
const { buildHXMsgFromFabricEvent } = require('../../../../hxmsg-builder/fabric-to-evm');

async function buildFabricEvidence({ profile, targetProfile, event }) {
  if (!['XCALL', 'ASSET_LOCKED_XCALL'].includes(event.eventType)) {
    throw new Error(`unsupported Fabric source event: ${event.eventType}`);
  }
  const hxmsg = buildHXMsgFromFabricEvent({
    deployment: targetProfile.deployment,
    channelName: profile.channel,
    chaincodeId: profile.chaincode,
    rawPayload: event.payload,
    txId: event.transactionID,
    blockNumber: event.blockHeight,
    nonce: event.payload.nonce,
    createdAt: event.payload.createdAt,
    targetChainType: targetProfile.chainType,
    targetDomainID: event.payload.targetDomainID,
  });
  return {
    hxmsg,
    helperData: {},
    execution: getExecutionData(hxmsg),
    syncCommitteeState: null,
  };
}

module.exports = { buildFabricEvidence };
