'use strict';

const { Contract } = require('fabric-contract-api');

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
    ctx.stub.setEvent('XCALL', Buffer.from(JSON.stringify(eventPayload)));

    return JSON.stringify({
      ok: true,
      txId,
      nonce,
      eventName: 'XCALL'
    });
  }
}

module.exports.contracts = [XCallContract];
