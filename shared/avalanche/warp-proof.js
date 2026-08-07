const { ethers } = require('ethers');
const { utils } = require('@avalabs/avalanchejs');
const { bls12_381 } = require('@noble/curves/bls12-381.js');
const { hashJson } = require('../hxmsg');

const WARP_CODEC_ID = 0;
const ADDRESSED_CALL_TYPE_ID = 1;
const BLS_SIGNATURE_DST = 'BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_';

function bytesFromHex(hex, name = 'hex') {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) throw new Error(`${name} must be 0x-prefixed hex`);
  return Buffer.from(hex.slice(2), 'hex');
}

function cb58Encode(hexOrBytes) {
  const bytes = Buffer.isBuffer(hexOrBytes)
    ? hexOrBytes
    : bytesFromHex(hexOrBytes, 'CB58 input');
  const checksum = Buffer.from(ethers.getBytes(ethers.sha256(bytes))).subarray(28);
  return utils.base58.encode(Buffer.concat([bytes, checksum]));
}

function bitIsSet(bitmap, index) {
  const byteIndex = Math.floor(index / 8);
  const bitIndex = index % 8;
  return byteIndex < bitmap.length && ((bitmap[byteIndex] >> bitIndex) & 1) === 1;
}

function readUInt16(buffer, cursor) {
  if (cursor.offset + 2 > buffer.length) throw new Error('short uint16 read');
  const value = buffer.readUInt16BE(cursor.offset);
  cursor.offset += 2;
  return value;
}

function readUInt32(buffer, cursor) {
  if (cursor.offset + 4 > buffer.length) throw new Error('short uint32 read');
  const value = buffer.readUInt32BE(cursor.offset);
  cursor.offset += 4;
  return value;
}

function readBytes(buffer, cursor, length, label) {
  if (cursor.offset + length > buffer.length) throw new Error(`short ${label || 'bytes'} read`);
  const value = buffer.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value;
}

function readLengthPrefixedBytes(buffer, cursor, label) {
  const length = readUInt32(buffer, cursor);
  return readBytes(buffer, cursor, length, label);
}

function parseUnsignedWarpMessage(unsignedWarpMessage) {
  const buffer = bytesFromHex(unsignedWarpMessage, 'unsignedWarpMessage');
  const cursor = { offset: 0 };
  const codecID = readUInt16(buffer, cursor);
  if (codecID !== WARP_CODEC_ID) throw new Error(`bad Warp codec ID: ${codecID}`);
  const networkID = readUInt32(buffer, cursor);
  const sourceChainIDBytes = readBytes(buffer, cursor, 32, 'sourceChainID');
  const addressedCallBytes = readLengthPrefixedBytes(buffer, cursor, 'Warp payload');
  if (cursor.offset !== buffer.length) throw new Error('trailing bytes in unsigned Warp message');

  const addressed = parseAddressedCall(addressedCallBytes);
  return {
    codecID,
    networkID,
    sourceChainID: `0x${sourceChainIDBytes.toString('hex')}`,
    sourceAddress: addressed.sourceAddress,
    payload: addressed.payload,
    unsignedMessageHash: ethers.sha256(unsignedWarpMessage),
    unsignedMessageBytes: buffer,
  };
}

function parseAddressedCall(addressedCallBytes) {
  const cursor = { offset: 0 };
  const codecID = readUInt16(addressedCallBytes, cursor);
  if (codecID !== WARP_CODEC_ID) throw new Error(`bad AddressedCall codec ID: ${codecID}`);
  const typeID = readUInt32(addressedCallBytes, cursor);
  if (typeID !== ADDRESSED_CALL_TYPE_ID) throw new Error(`bad AddressedCall type ID: ${typeID}`);
  const sourceAddressBytes = readLengthPrefixedBytes(addressedCallBytes, cursor, 'sourceAddress');
  if (sourceAddressBytes.length !== 20) throw new Error('AddressedCall sourceAddress must be 20 bytes');
  const payload = readLengthPrefixedBytes(addressedCallBytes, cursor, 'AddressedCall payload');
  if (cursor.offset !== addressedCallBytes.length) throw new Error('trailing bytes in AddressedCall payload');
  return {
    codecID,
    typeID,
    sourceAddress: ethers.getAddress(`0x${sourceAddressBytes.toString('hex')}`),
    payload: `0x${payload.toString('hex')}`,
  };
}

function decodeHXMsgWarpPayload(payloadHex) {
  const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
    ['tuple(bytes32 requestID,bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,tuple(bool required,uint8 mode,uint8 commitmentType,bytes32 commitmentRefHash,bytes32 successActionHash,bytes32 failureActionHash,uint64 challengeWindow) atomicity,bytes32 validatorPolicyHash,bytes callData)'],
    payloadHex
  );
  return {
    requestID: decoded.requestID,
    targetChainID: decoded.targetChainID,
    targetDomainID: decoded.targetDomainID,
    targetObject: decoded.targetObject,
    functionSelector: decoded.functionSelector,
    callDataHash: decoded.callDataHash,
    businessPayloadHash: decoded.businessPayloadHash,
    receiver: decoded.receiver,
    nonce: Number(decoded.nonce),
    expireAt: Number(decoded.expireAt),
    feedback: {
      required: decoded.feedbackRequired,
      expectedMsgType: Number(decoded.expectedFeedbackMsgType),
      timeout: Number(decoded.feedbackTimeout),
      callbackRefHash: decoded.callbackRefHash,
    },
    atomicity: {
      required: decoded.atomicity.required,
      mode: Number(decoded.atomicity.mode),
      commitmentType: Number(decoded.atomicity.commitmentType),
      commitmentRefHash: decoded.atomicity.commitmentRefHash,
      successActionHash: decoded.atomicity.successActionHash,
      failureActionHash: decoded.atomicity.failureActionHash,
      challengeWindow: Number(decoded.atomicity.challengeWindow),
    },
    validatorPolicyHash: decoded.validatorPolicyHash,
    // 兼容只读取验证者策略哈希的调用方；不再表示响应/原子性策略。
    policyHash: decoded.validatorPolicyHash,
    callData: decoded.callData,
  };
}

function canonicalizeValidators(validators) {
  if (!Array.isArray(validators) || validators.length === 0) throw new Error('Avalanche validator set is required');
  return validators
    .map((validator) => ({
      nodeID: String(validator.nodeID),
      weight: String(validator.weight),
      publicKey: ethers.hexlify(validator.publicKey || validator.signer?.publicKey || validator.blsPublicKey),
    }))
    .sort((a, b) => a.nodeID.localeCompare(b.nodeID));
}

function validatorSetHash(validators) {
  return hashJson(canonicalizeValidators(validators));
}

function verifyAvalancheWeightedSignatures({ unsignedWarpMessage, validatorSet, signatures, quorumNumerator = 67, quorumDenominator = 100 }) {
  const unsigned = parseUnsignedWarpMessage(unsignedWarpMessage);
  const validators = canonicalizeValidators(validatorSet);
  const byNode = new Map(validators.map((validator) => [validator.nodeID, validator]));
  const seen = new Set();
  let signedWeight = 0n;
  let totalWeight = 0n;
  for (const validator of validators) totalWeight += BigInt(validator.weight);
  if (totalWeight <= 0n) throw new Error('Avalanche validator totalWeight is zero');

  const verifiedSigners = [];
  for (const item of signatures || []) {
    const nodeID = String(item.nodeID);
    if (seen.has(nodeID)) throw new Error(`duplicate Avalanche signature for ${nodeID}`);
    seen.add(nodeID);
    const validator = byNode.get(nodeID);
    if (!validator) throw new Error(`Avalanche signature from non-validator ${nodeID}`);
    const signature = bytesFromHex(item.signature, `signature ${nodeID}`);
    if (signature.length !== 96) throw new Error(`bad BLS signature length for ${nodeID}`);
    const publicKey = bytesFromHex(validator.publicKey, `publicKey ${nodeID}`);
    const message = bls12_381.longSignatures.hash(unsigned.unsignedMessageBytes, BLS_SIGNATURE_DST);
    const ok = bls12_381.longSignatures.verify(signature, message, publicKey);
    if (!ok) throw new Error(`bad Avalanche BLS signature for ${nodeID}`);
    signedWeight += BigInt(validator.weight);
    verifiedSigners.push(nodeID);
  }

  const numerator = BigInt(Number(quorumNumerator || 67));
  const denominator = BigInt(Number(quorumDenominator || 100));
  if (signedWeight * denominator < totalWeight * numerator) {
    throw new Error(`Avalanche signed weight below quorum: ${signedWeight}/${totalWeight}`);
  }

  return {
    ...unsigned,
    validators,
    validatorSetHash: validatorSetHash(validators),
    signedWeight: signedWeight.toString(),
    totalWeight: totalWeight.toString(),
    verifiedSigners,
  };
}

module.exports = {
  cb58Encode,
  bitIsSet,
  parseUnsignedWarpMessage,
  decodeHXMsgWarpPayload,
  canonicalizeValidators,
  validatorSetHash,
  verifyAvalancheWeightedSignatures,
};
