const { registerFabricTEEs } = require('../../shared/tee/registration');
const { connectFabric } = require('../fabric-client');
const { teeURLs } = require('../config');

function sameHex(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

async function bindFabricResponseLifecycles({ sourceProfile, items }) {
  const pending = items.filter((item) => item.hxmsg.feedback?.required);
  if (sourceProfile.kind !== 'fabric' || pending.length === 0) return [];
  const { gateway, contract } = await connectFabric(sourceProfile);
  try {
    await registerFabricTEEs({
      contract,
      certificate: pending[0].certificate,
      teeURLs: teeURLs(Number(pending[0].hxmsg.source.chainType)),
    });
    const results = [];
    for (const item of pending) {
      const encoded = await contract.evaluateTransaction(
        'QueryResponseLifecycle',
        item.hxmsg.header.requestID
      );
      const lifecycle = JSON.parse(encoded.toString());
      if (lifecycle.hmsgDigest && !sameHex(lifecycle.hmsgDigest, '0x' + '00'.repeat(32))) {
        if (!sameHex(lifecycle.hmsgDigest, item.hxmsg.hmsgDigest)) {
          throw new Error(`Fabric response lifecycle digest conflict: ${item.hxmsg.header.requestID}`);
        }
        results.push({ requestID: item.hxmsg.header.requestID, alreadyBound: true });
        continue;
      }
      const response = await contract.submitTransaction(
        'BindResponseLifecycleHXMsg',
        JSON.stringify(item.hxmsg),
        JSON.stringify(item.certificate)
      );
      results.push(JSON.parse(response.toString()));
    }
    return results;
  } finally {
    gateway.disconnect();
  }
}

async function bindSourceLifecycle({ sourceProfile, hxmsg, certificate }) {
  return bindFabricResponseLifecycles({
    sourceProfile,
    items: [{ hxmsg, certificate }],
  });
}

module.exports = { bindSourceLifecycle, bindFabricResponseLifecycles };
