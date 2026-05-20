const { ChainType, VerificationMethod } = require('../../shared/hxmsg');
const fabricHFsvAdapter = require('./fabric-hfsv-adapter');
const evmMelvAdapter = require('./evm-melv-adapter');

const sourceAdapters = [
  fabricHFsvAdapter,
  evmMelvAdapter,
];

function resolveSourceAdapter(hxmsg) {
  const sourceChainType = Number(hxmsg.source?.chainType);
  const verificationMethod = Number(hxmsg.verification?.verificationMethod);
  const adapter = sourceAdapters.find((item) =>
    Number(item.sourceChainType) === sourceChainType &&
    Number(item.verificationMethod) === verificationMethod
  );
  if (!adapter) {
    const chainName = Object.entries(ChainType).find(([, value]) => Number(value) === sourceChainType)?.[0] || sourceChainType;
    const methodName = Object.entries(VerificationMethod).find(([, value]) => Number(value) === verificationMethod)?.[0] || verificationMethod;
    throw new Error(`no source adapter registered for chainType=${chainName}, verificationMethod=${methodName}`);
  }
  return adapter;
}

async function verifySourceFact({ hxmsg, helperData, chainState, saveChainState }) {
  const adapter = resolveSourceAdapter(hxmsg);
  return adapter.verifySourceFact({
    hxmsg,
    helperData: helperData || {},
    chainState,
    saveChainState,
  });
}

module.exports = {
  sourceAdapters,
  resolveSourceAdapter,
  verifySourceFact,
};
