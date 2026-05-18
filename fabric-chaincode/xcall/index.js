'use strict';

const { Contract } = require('fabric-contract-api');
const { ethers } = require('ethers');

const ABI = ethers.AbiCoder.defaultAbiCoder();

function parseJson(value, fieldName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error.message}`);
  }
}

function computeCoreHash(xmsg, teePubKey) {
  return ethers.keccak256(
    ABI.encode(
      [
        'uint8',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'address',
        'bytes32',
        'bytes32',
        'uint64',
        'bytes32',
        'bytes32',
        'uint64',
        'address'
      ],
      [
        Number(xmsg.version),
        xmsg.requestID,
        xmsg.srcChainID,
        xmsg.dstChainID,
        xmsg.srcEmitter,
        xmsg.dstContract || ethers.ZeroAddress,
        ethers.keccak256(xmsg.payload),
        xmsg.payloadHash,
        Number(xmsg.srcHeight),
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.eventProof)),
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.finalityInfo)),
        Number(xmsg.nonce),
        teePubKey
      ]
    )
  );
}

function computeDigest(xmsg, ctr, prevDigest, teePubKey) {
  const coreHash = computeCoreHash(xmsg, teePubKey);
  return ethers.keccak256(ABI.encode(['bytes32', 'uint64', 'bytes32'], [coreHash, Number(ctr), prevDigest]));
}

function decodeBusinessPayload(payloadHex) {
  const [op, recordId, actor, amount, metadata, requireAck] = ABI.decode(
    ['string', 'string', 'string', 'string', 'string', 'bool'],
    payloadHex
  );
  return {
    op,
    recordId,
    actor,
    amount,
    metadata,
    requireAck
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(value)));
}

function addressToBytes32(value) {
  return ethers.zeroPadValue(ethers.getAddress(value), 32);
}

function selectorOf(signature) {
  return ethers.id(signature).slice(0, 10);
}

function bytes32FromText(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(text)));
}

function normalizeFeedback(feedback = {}) {
  return {
    required: Boolean(feedback.required),
    expectedMsgType: Number(feedback.expectedMsgType || 0),
    timeout: Number(feedback.timeout || 0),
    callbackRefHash: feedback.callbackRefHash || ethers.ZeroHash
  };
}

function computeTargetExecutionHashFromHXMsg(hxmsg) {
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [
        hxmsg.header.requestID,
        hxmsg.target.chainID,
        hxmsg.targetAction.targetObject,
        hxmsg.targetAction.functionSelector,
        hxmsg.targetAction.callDataHash,
        hxmsg.targetAction.receiver
      ]
    )
  );
}

function computeHXMsgDigest(hxmsg) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  const headerHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'uint8', 'uint64', 'uint64', 'uint64'],
      [
        Number(hxmsg.header.version),
        hxmsg.header.requestID,
        Number(hxmsg.header.msgType),
        Number(hxmsg.header.nonce),
        Number(hxmsg.header.createdAt),
        Number(hxmsg.header.expireAt)
      ]
    )
  );
  const endpointHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32', 'uint8', 'bytes32'],
      [
        Number(hxmsg.source.chainType),
        hxmsg.source.chainID,
        hxmsg.source.domainID,
        Number(hxmsg.target.chainType),
        hxmsg.target.chainID,
        hxmsg.target.domainID,
        Number(hxmsg.sourceRef.refType),
        hxmsg.sourceRef.refHash
      ]
    )
  );
  const actionHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [
        Number(hxmsg.targetAction.actionType),
        hxmsg.targetAction.targetObject,
        hxmsg.targetAction.functionSelector,
        hxmsg.targetAction.callDataHash,
        hxmsg.targetAction.receiver
      ]
    )
  );
  const verificationHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'uint8', 'uint16', 'uint8', 'bytes32', 'bytes32', 'bytes32'],
      [
        Number(hxmsg.verification.verificationMethod),
        Number(hxmsg.verification.finalityModel),
        Number(hxmsg.verification.requiredConfirmations),
        Number(hxmsg.verification.policyRef.policyType),
        hxmsg.verification.policyRef.policyID,
        hxmsg.verification.policyRef.policyHash,
        hxmsg.verification.adapterID
      ]
    )
  );
  const bindingHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [
        hxmsg.payloadBinding.sourcePayloadHash,
        hxmsg.payloadBinding.businessPayloadHash,
        hxmsg.payloadBinding.targetExecutionHash
      ]
    )
  );
  const feedbackHash = ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint64', 'bytes32'],
      [feedback.required, feedback.expectedMsgType, feedback.timeout, feedback.callbackRefHash]
    )
  );
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [headerHash, endpointHash, actionHash, verificationHash, bindingHash, feedbackHash]
    )
  );
}

async function isTrustedTEE(ctx, address) {
  const key = `trustedTEE:${ethers.getAddress(address)}`;
  const data = await ctx.stub.getState(key);
  return data && data.length > 0;
}

async function verifyTEECertification(ctx, hxmsg, certEnvelope) {
  const hmsgDigest = computeHXMsgDigest(hxmsg);
  const certs = certEnvelope.certifications || (
    certEnvelope.teeCertification ? [certEnvelope.teeCertification] : [certEnvelope]
  );
  const threshold = Number(certEnvelope.threshold || 1);
  const seen = new Set();
  let valid = 0;
  for (const cert of certs) {
    if (!cert || cert.requestID !== hxmsg.header.requestID) continue;
    if (String(cert.hmsgDigest).toLowerCase() !== hmsgDigest.toLowerCase()) continue;
    const signer = ethers.getAddress(ethers.recoverAddress(hmsgDigest, cert.signature));
    if (signer !== ethers.getAddress(cert.teeAddress)) continue;
    if (!(await isTrustedTEE(ctx, signer))) continue;
    if (seen.has(signer)) continue;
    seen.add(signer);
    valid += 1;
  }
  if (valid < threshold) {
    throw new Error(`TEE quorum not satisfied: ${valid}/${threshold}`);
  }
  return { hmsgDigest, validTEECount: valid, threshold, signers: Array.from(seen) };
}

class XCallContract extends Contract {
  async InitLedger() {
    return;
  }

  async EmitXCall(ctx, payloadJson) {
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (error) {
      throw new Error(`payloadJson must be valid JSON: ${error.message}`);
    }

    const nonceKey = 'xcall_nonce';
    const nonceBytes = await ctx.stub.getState(nonceKey);
    const nonce = nonceBytes && nonceBytes.length > 0 ? Number(nonceBytes.toString()) + 1 : 1;
    await ctx.stub.putState(nonceKey, Buffer.from(String(nonce)));

    const txId = ctx.stub.getTxID();
    const txTime = ctx.stub.getTxTimestamp();
    const createdAt = Number(txTime.seconds.low || txTime.seconds || Math.floor(Date.now() / 1000));
    const requestID = payload.requestID || ethers.keccak256(
      ethers.toUtf8Bytes(`fabric:${ctx.stub.getChannelID()}:${txId}:${nonce}`)
    );
    const businessPayload = payload.businessPayload || payload.payload || payload;
    const businessPayloadHash = payload.businessPayloadHash || hashJson(businessPayload);
    const targetObject = payload.targetObject || (
      payload.targetContract ? addressToBytes32(payload.targetContract) : ethers.ZeroHash
    );
    const receiver = payload.receiver || targetObject;
    const functionSelector = payload.functionSelector || selectorOf('execute(bytes32,bytes)');
    const callDataHash = payload.callDataHash;
    if (!callDataHash) {
      throw new Error('payload.callDataHash is required for h-xmsg binding');
    }
    const expireAt = Number(payload.expireAt || (createdAt + 3600));

    const eventRecord = {
      requestID,
      sourceTxID: txId,
      fabricCaller: ctx.clientIdentity.getID(),
      targetChainType: payload.targetChainType || 'EVM',
      targetChainID: payload.targetChainID || '',
      targetObject,
      functionSelector,
      callDataHash,
      businessPayloadHash,
      receiver,
      nonce,
      createdAt,
      expireAt,
      status: 'COMMITTED',
      businessPayload
    };

    const eventPayload = {
      ...eventRecord,
      fabricTxId: txId,
      fabricNonce: nonce,
      emittedAt: new Date(createdAt * 1000).toISOString()
    };

    await ctx.stub.putState(`xcall:${txId}`, Buffer.from(JSON.stringify(eventPayload)));
    await ctx.stub.putState(`crosschainEvents:${requestID}`, Buffer.from(JSON.stringify(eventRecord)));
    await ctx.stub.putState(`outbound:${txId}`, Buffer.from(JSON.stringify({
      txId,
      requestID,
      nonce,
      status: 'pending',
      updatedAt: new Date().toISOString()
    })));
    ctx.stub.setEvent('XCALL', Buffer.from(JSON.stringify(eventPayload)));

    return JSON.stringify({
      ok: true,
      txId,
      requestID,
      nonce,
      eventName: 'XCALL'
    });
  }

  async QueryCrosschainEvent(ctx, requestID) {
    const data = await ctx.stub.getState(`crosschainEvents:${requestID}`);
    if (!data || data.length === 0) {
      throw new Error(`crosschain event not found: ${requestID}`);
    }
    return data.toString();
  }

  async RegisterTrustedTEE(ctx, teeAddress) {
    const address = ethers.getAddress(teeAddress);
    await ctx.stub.putState(`trustedTEE:${address}`, Buffer.from(JSON.stringify({
      address,
      registeredByMSP: ctx.clientIdentity.getMSPID(),
      updatedAt: new Date().toISOString()
    })));
    return JSON.stringify({ ok: true, address });
  }

  async QueryTrustedTEE(ctx, teeAddress) {
    const address = ethers.getAddress(teeAddress);
    const data = await ctx.stub.getState(`trustedTEE:${address}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async ExecuteHXMsg(ctx, hxmsgJson, callDataHex, certJson) {
    const hxmsg = parseJson(hxmsgJson, 'hxmsgJson');
    const certEnvelope = parseJson(certJson, 'certJson');
    const requestID = hxmsg.header.requestID;
    const consumedKey = `hxmsg-consumed:${requestID}`;
    const consumed = await ctx.stub.getState(consumedKey);
    if (consumed && consumed.length > 0) {
      throw new Error('replay requestID');
    }

    const now = Number(ctx.stub.getTxTimestamp().seconds.low || ctx.stub.getTxTimestamp().seconds || Math.floor(Date.now() / 1000));
    if (Number(hxmsg.header.expireAt) < now) throw new Error('h-xmsg expired');
    if (Number(hxmsg.target.chainType) !== 2) throw new Error('target is not Fabric');
    if (Number(hxmsg.targetAction.actionType) !== 5) throw new Error('action is not chaincode invoke');

    const expectedChainID = bytes32FromText(`fabric-${ctx.stub.getChannelID()}`);
    const expectedDomainID = bytes32FromText('fabric-local-domain');
    const expectedTargetObject = bytes32FromText(`fabric:${ctx.stub.getChannelID()}:xcall`);
    if (String(hxmsg.target.chainID).toLowerCase() !== expectedChainID.toLowerCase()) {
      throw new Error('Fabric target chainID mismatch');
    }
    if (String(hxmsg.target.domainID).toLowerCase() !== expectedDomainID.toLowerCase()) {
      throw new Error('Fabric target domainID mismatch');
    }
    if (String(hxmsg.targetAction.targetObject).toLowerCase() !== expectedTargetObject.toLowerCase()) {
      throw new Error('Fabric target object mismatch');
    }
    if (String(hxmsg.targetAction.callDataHash).toLowerCase() !== ethers.keccak256(callDataHex).toLowerCase()) {
      throw new Error('callDataHash mismatch');
    }
    const targetExecutionHash = computeTargetExecutionHashFromHXMsg(hxmsg);
    if (String(hxmsg.payloadBinding.targetExecutionHash).toLowerCase() !== targetExecutionHash.toLowerCase()) {
      throw new Error('targetExecutionHash mismatch');
    }

    const certResult = await verifyTEECertification(ctx, hxmsg, certEnvelope);
    const parsedPayload = decodeBusinessPayload(callDataHex);
    const record = {
      requestID,
      txId: ctx.stub.getTxID(),
      callerMSP: ctx.clientIdentity.getMSPID(),
      hmsgDigest: certResult.hmsgDigest,
      validTEECount: certResult.validTEECount,
      teeThreshold: certResult.threshold,
      teeSigners: certResult.signers,
      sourceChainType: hxmsg.source.chainType,
      sourceTxID: hxmsg.txId || '',
      srcHeight: hxmsg.srcHeight || 0,
      callDataHash: hxmsg.targetAction.callDataHash,
      businessPayloadHash: hxmsg.payloadBinding.businessPayloadHash,
      op: parsedPayload.op,
      recordId: parsedPayload.recordId,
      actor: parsedPayload.actor,
      amount: parsedPayload.amount,
      metadata: parsedPayload.metadata,
      requireAck: Boolean(parsedPayload.requireAck),
      status: 'executed',
      updatedAt: new Date().toISOString()
    };

    await ctx.stub.putState(consumedKey, Buffer.from('1'));
    await ctx.stub.putState(`crosschainExec:${requestID}`, Buffer.from(JSON.stringify(record)));
    await ctx.stub.putState(`inbound:${requestID}`, Buffer.from(JSON.stringify(record)));
    ctx.stub.setEvent('HXMSG_EXECUTED', Buffer.from(JSON.stringify(record)));

    return JSON.stringify({ ok: true, requestID, status: 'executed', validTEECount: certResult.validTEECount });
  }

  async ExecuteInboundXMsg(ctx, xmsgJson, voucherJson) {
    const xmsg = parseJson(xmsgJson, 'xmsgJson');
    const voucher = parseJson(voucherJson, 'voucherJson');

    if (ethers.keccak256(xmsg.payload) !== xmsg.payloadHash) {
      throw new Error('payload hash mismatch');
    }
    if (
      ethers.keccak256(voucher.teeReport) !==
      ethers.keccak256(ethers.solidityPacked(['string', 'address'], ['SIM_TEE_REPORT', voucher.teePubKey]))
    ) {
      throw new Error('bad tee report');
    }

    const consumedKey = `inbound-consumed:${xmsg.requestID}`;
    const consumed = await ctx.stub.getState(consumedKey);
    if (consumed && consumed.length > 0) {
      throw new Error('replay requestID');
    }

    const digest = computeDigest(xmsg, voucher.ctr, voucher.prevDigest, voucher.teePubKey);
    const signer = ethers.recoverAddress(digest, voucher.teeSig);
    if (ethers.getAddress(signer) !== ethers.getAddress(voucher.teePubKey)) {
      throw new Error('invalid tee signature');
    }

    const parsedPayload = decodeBusinessPayload(xmsg.payload);
    const record = {
      requestID: xmsg.requestID,
      txId: ctx.stub.getTxID(),
      callerMSP: ctx.clientIdentity.getMSPID(),
      srcChainID: xmsg.srcChainID,
      srcHeight: xmsg.srcHeight,
      payloadHash: xmsg.payloadHash,
      op: parsedPayload.op,
      recordId: parsedPayload.recordId,
      actor: parsedPayload.actor,
      amount: parsedPayload.amount,
      metadata: parsedPayload.metadata,
      requireAck: Boolean(parsedPayload.requireAck),
      status: 'executed',
      updatedAt: new Date().toISOString()
    };

    await ctx.stub.putState(consumedKey, Buffer.from('1'));
    await ctx.stub.putState(`inbound:${xmsg.requestID}`, Buffer.from(JSON.stringify(record)));
    ctx.stub.setEvent('INBOUND_XCALL_EXECUTED', Buffer.from(JSON.stringify(record)));

    return JSON.stringify({
      ok: true,
      requestID: xmsg.requestID,
      status: 'executed'
    });
  }

  async ConfirmAckXMsg(ctx, xmsgJson, voucherJson) {
    const xmsg = parseJson(xmsgJson, 'xmsgJson');
    const voucher = parseJson(voucherJson, 'voucherJson');

    if (ethers.keccak256(xmsg.payload) !== xmsg.payloadHash) {
      throw new Error('payload hash mismatch');
    }

    // Legacy ACK path retained only until ACK is reintroduced as h-xmsg RESPONSE/ACK.
    // attestDigest = keccak256(abi.encode(reportHash, teePubKey))
    if (voucher.reportHash && voucher.teeSig) {
      const attestDigest = ethers.keccak256(
        ABI.encode(['bytes32', 'address'], [voucher.reportHash, voucher.teePubKey])
      );
      const signer = ethers.recoverAddress(attestDigest, voucher.teeSig);
      if (ethers.getAddress(signer) !== ethers.getAddress(voucher.teePubKey)) {
        throw new Error('invalid tee signature (attestDigest)');
      }
    }
    // ── Legacy ECDSA path ( /verify-sign ) ──
    else if (voucher.ctr !== undefined && voucher.prevDigest !== undefined) {
      if (
        ethers.keccak256(voucher.teeReport) !==
        ethers.keccak256(ethers.solidityPacked(['string', 'address'], ['SIM_TEE_REPORT', voucher.teePubKey]))
      ) {
        throw new Error('bad tee report');
      }
      const digest = computeDigest(xmsg, voucher.ctr, voucher.prevDigest, voucher.teePubKey);
      const signer = ethers.recoverAddress(digest, voucher.teeSig);
      if (ethers.getAddress(signer) !== ethers.getAddress(voucher.teePubKey)) {
        throw new Error('invalid tee signature (legacy)');
      }
    } else {
      throw new Error('unrecognized voucher format');
    }

    const parsedPayload = decodeBusinessPayload(xmsg.payload);
    const ackMetadata = parseJson(parsedPayload.metadata, 'ack metadata');
    const ackRecord = {
      ackRequestID: xmsg.requestID,
      originRequestID: ackMetadata.originRequestID || parsedPayload.recordId,
      status: ackMetadata.status || 'success',
      relayTxHash: ackMetadata.relayTxHash || '',
      targetOp: ackMetadata.targetOp || parsedPayload.op,
      updatedAt: new Date().toISOString()
    };

    await ctx.stub.putState(`ack:${ackRecord.originRequestID}`, Buffer.from(JSON.stringify(ackRecord)));
    ctx.stub.setEvent('XACK_CONFIRMED', Buffer.from(JSON.stringify(ackRecord)));

    return JSON.stringify({
      ok: true,
      originRequestID: ackRecord.originRequestID,
      status: ackRecord.status
    });
  }

  async GetInboundStatus(ctx, requestID) {
    const data = await ctx.stub.getState(`inbound:${requestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async GetAckStatus(ctx, originRequestID) {
    const data = await ctx.stub.getState(`ack:${originRequestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }
}

module.exports.contracts = [XCallContract];
