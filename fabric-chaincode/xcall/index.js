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
  const [op, recordId, actor, amount, metadata] = ABI.decode(
    ['string', 'string', 'string', 'string', 'string'],
    payloadHex
  );
  return {
    op,
    recordId,
    actor,
    amount,
    metadata
  };
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
    const eventPayload = {
      ...payload,
      fabricTxId: txId,
      fabricNonce: nonce,
      emittedAt: new Date().toISOString()
    };

    await ctx.stub.putState(`xcall:${txId}`, Buffer.from(JSON.stringify(eventPayload)));
    await ctx.stub.putState(`outbound:${txId}`, Buffer.from(JSON.stringify({
      txId,
      nonce,
      status: 'pending',
      updatedAt: new Date().toISOString()
    })));
    ctx.stub.setEvent('XCALL', Buffer.from(JSON.stringify(eventPayload)));

    return JSON.stringify({
      ok: true,
      txId,
      nonce,
      eventName: 'XCALL'
    });
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
    if (
      ethers.keccak256(voucher.teeReport) !==
      ethers.keccak256(ethers.solidityPacked(['string', 'address'], ['SIM_TEE_REPORT', voucher.teePubKey]))
    ) {
      throw new Error('bad tee report');
    }

    const digest = computeDigest(xmsg, voucher.ctr, voucher.prevDigest, voucher.teePubKey);
    const signer = ethers.recoverAddress(digest, voucher.teeSig);
    if (ethers.getAddress(signer) !== ethers.getAddress(voucher.teePubKey)) {
      throw new Error('invalid tee signature');
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
