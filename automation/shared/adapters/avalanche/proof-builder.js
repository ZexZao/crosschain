const axios = require('axios');
const { ethers } = require('ethers');
const { composeHXMsg } = require('../../../../hxmsg-builder/compose');
const { buildEvmContractCallTarget } = require('../../../../hxmsg-builder/target-builders/evm');
const { buildFabricChaincodeTarget } = require('../../../../hxmsg-builder/target-builders/fabric');
const { encodeCompactBusinessCall } = require('../../../../shared/xmsg');
const {
  ChainType,
  RefType,
  MsgType,
  FinalityModel,
  PolicyType,
  VerificationMethod,
  bytes32FromText,
  hashJson,
  hashBytes,
  getExecutionData,
} = require('../../../../shared/hxmsg');
const {
  cb58Encode,
  parseUnsignedWarpMessage,
  decodeHXMsgWarpPayload,
  validatorSetHash,
} = require('../../../../shared/avalanche/warp-proof');

const NODE_ENDPOINTS = () => String(process.env.AVALANCHE_NODE_ENDPOINTS
  || 'http://127.0.0.1:9650,http://127.0.0.1:9656,http://127.0.0.1:9652,http://127.0.0.1:9654,http://127.0.0.1:9658')
  .split(',').map((value) => value.trim()).filter(Boolean);

async function rpc(url, method, params) {
  const response = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 30_000 });
  if (response.data.error) throw new Error(`${method}: ${response.data.error.message}`);
  return response.data.result;
}

async function getValidatorSetRef() {
  const pChain = process.env.AVALANCHE_PCHAIN_RPC_URL || 'http://127.0.0.1:9650/ext/P';
  const validatorsResponse = await rpc(pChain, 'platform.getCurrentValidators', [{}]);
  const heightResponse = await rpc(pChain, 'platform.getHeight', [{}]).catch(() => ({ height: 0 }));
  const validators = validatorsResponse.validators.map((validator) => ({
    nodeID: validator.nodeID,
    weight: validator.weight,
    publicKey: validator.signer.publicKey,
  }));
  const ref = {
    networkID: Number(process.env.AVALANCHE_NETWORK_ID || 1337),
    pChainHeight: Number(heightResponse.height || heightResponse || 0),
    validatorSetHash: validatorSetHash(validators),
    totalWeight: validators.reduce((sum, item) => sum + BigInt(item.weight), 0n).toString(),
    quorumNumerator: 67,
    quorumDenominator: 100,
    canonicalOrdering: 'nodeID-ascending',
  };
  return { validators, ref };
}

async function collectSignatures(messageIDHex) {
  const messageID = cb58Encode(messageIDHex);
  const signatures = [];
  for (const baseURL of NODE_ENDPOINTS()) {
    const node = await rpc(`${baseURL}/ext/info`, 'info.getNodeID', []);
    const signature = await rpc(`${baseURL}/ext/bc/C/rpc`, 'warp_getMessageSignature', [messageID]);
    signatures.push({ nodeID: node.nodeID, signature });
  }
  return signatures.sort((a, b) => a.nodeID.localeCompare(b.nodeID));
}

async function buildAvalancheEvidence({ profile, targetProfile, event, material }) {
  if (!material?.businessPayload) throw new Error(`source material missing for ${event.requestID}`);
  const unsignedWarpMessage = await rpc(profile.rpc, 'warp_getMessage', [cb58Encode(event.payload.warpMessageID)]);
  const parsed = parseUnsignedWarpMessage(unsignedWarpMessage);
  const warpPayload = decodeHXMsgWarpPayload(parsed.payload);
  const encoded = encodeCompactBusinessCall(material.businessPayload);
  if (encoded.compactCallHash.toLowerCase() !== String(warpPayload.callDataHash).toLowerCase()) {
    throw new Error('Avalanche source material callDataHash mismatch');
  }
  if (hashJson(encoded.normalized).toLowerCase() !== String(warpPayload.businessPayloadHash).toLowerCase()) {
    throw new Error('Avalanche source material businessPayloadHash mismatch');
  }
  const { validators, ref: validatorSetRef } = await getValidatorSetRef();
  const signatures = await collectSignatures(event.payload.warpMessageID);
  const targetPart = targetProfile.kind === 'fabric'
    ? buildFabricChaincodeTarget({
      channelID: targetProfile.channel,
      chaincodeName: targetProfile.chaincode,
      requestID: warpPayload.requestID,
      functionSelector: warpPayload.functionSelector,
      callDataHash: warpPayload.callDataHash,
      receiver: warpPayload.receiver,
    })
    : buildEvmContractCallTarget({
      chainId: targetProfile.deployment.chainId,
      requestID: warpPayload.requestID,
      targetAddress: targetProfile.deployment.targetContract,
      functionSelector: warpPayload.functionSelector,
      callDataHash: warpPayload.callDataHash,
      receiver: warpPayload.receiver,
      chainType: targetProfile.chainType,
    });
  const sourceProof = {
    proofType: 'AvalancheWarpMessage',
    warpMessageID: event.payload.warpMessageID,
    unsignedWarpMessage,
    unsignedWarpMessageHash: parsed.unsignedMessageHash,
    sourceChainID: parsed.sourceChainID,
    sourceContract: profile.deployment.avalancheWarpSourceContract,
    networkID: parsed.networkID,
  };
  const sourceRecord = {
    proofType: sourceProof.proofType,
    warpMessageID: sourceProof.warpMessageID,
    unsignedWarpMessageHash: sourceProof.unsignedWarpMessageHash,
    sourceChainID: sourceProof.sourceChainID,
    sourceContract: sourceProof.sourceContract,
    networkID: Number(sourceProof.networkID),
    validatorSetHash: validatorSetRef.validatorSetHash,
    pChainHeight: validatorSetRef.pChainHeight,
    signatureSetHash: hashJson(signatures),
    signedWeight: validators.reduce((sum, item) => sum + BigInt(item.weight), 0n).toString(),
  };
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  const block = await provider.getBlock(event.blockHeight);
  const hxmsg = composeHXMsg({
    header: {
      version: 1,
      requestID: warpPayload.requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce: warpPayload.nonce,
      nonceScope: ethers.zeroPadValue(ethers.getAddress(sourceProof.sourceContract), 32),
      createdAt: Number(block?.timestamp || Math.floor(Date.now() / 1000)),
      expireAt: warpPayload.expireAt,
    },
    source: {
      chainType: ChainType.AVALANCHE,
      chainID: parsed.sourceChainID,
      domainID: bytes32FromText('avalanche-local-domain'),
    },
    target: targetPart.target,
    sourceRef: {
      refType: RefType.AVALANCHE_WARP_MESSAGE,
      refHash: hashBytes(unsignedWarpMessage),
      encodedRef: unsignedWarpMessage,
    },
    targetAction: targetPart.targetAction,
    verification: {
      verificationMethod: VerificationMethod.AVALANCHE_ICM_BLS,
      finality: {
        model: FinalityModel.APPLICATION,
        confirmations: 0,
        checkpointRoot: validatorSetRef.validatorSetHash,
        epoch: validatorSetRef.pChainHeight,
        committeePolicyHash: warpPayload.policyHash,
      },
      policyRef: { policyType: PolicyType.AVALANCHE_VALIDATOR_SET, policyHash: warpPayload.policyHash },
      verifierProfileHash: bytes32FromText('avalanche-icm-real-warp-profile-v1'),
      adapterID: 'avalanche-icm-bls',
    },
    payloadBinding: {
      sourcePayloadHash: hashJson(sourceRecord),
      businessPayloadHash: warpPayload.businessPayloadHash,
      targetExecutionHash: targetPart.targetExecutionHash,
    },
    feedback: warpPayload.feedback,
    atomicity: warpPayload.atomicity,
    callData: warpPayload.callData,
    compactCall: encoded.compact,
    callDataDecoded: encoded.normalized,
    txId: sourceProof.warpMessageID,
    srcHeight: validatorSetRef.pChainHeight,
    sourceRecord,
    proofMeta: {
      proofType: sourceProof.proofType,
      pChainHeight: validatorSetRef.pChainHeight,
      validatorSetHash: validatorSetRef.validatorSetHash,
    },
  });
  const helperData = {
    avalancheProof: {
      sourceProof,
      validatorSetRef,
      validatorSet: validators,
      signatureProof: {
        scheme: 'BLS12-381',
        signedMessageHash: parsed.unsignedMessageHash,
        signatures,
      },
      payloadBinding: { sourceMessageID: sourceProof.warpMessageID },
    },
  };
  return { hxmsg, helperData, execution: getExecutionData(hxmsg), syncCommitteeState: null };
}

module.exports = { buildAvalancheEvidence, getValidatorSetRef, collectSignatures };
