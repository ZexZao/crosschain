const { hashJson } = require('./hash');
const { bytes32FromText } = require('./codec');

function buildEvmMelvPolicy({
  sourceChainID,
  sourceContract,
  requiredConfirmations = Number(process.env.MELV_REQUIRED_CONFIRMATIONS || 1),
  finalityMode = process.env.MELV_FINALITY_MODE || 'confirmation-based',
} = {}) {
  if (!sourceChainID) throw new Error('sourceChainID is required for MELV-EF policy');
  if (!sourceContract) throw new Error('sourceContract is required for MELV-EF policy');
  const policyID = `evm-${sourceChainID}-melv-ef-v1`;
  return {
    policyType: 'EVMFinalityPolicy',
    policyID,
    sourceChainID,
    trustedSourceContracts: [String(sourceContract).toLowerCase()],
    allowedEventSignatures: ['CrossChainCallRequested'],
    requiredConfirmations: Number(requiredConfirmations),
    finalityMode,
    receiptProofRequired: true,
    headerMaintainer: process.env.MELV_HEADER_MAINTAINER || 'committee-certified-header-window',
    headerCommitteeID: process.env.HEADER_COMMITTEE_ID || 'evm-header-committee-local-v1',
  };
}

function buildDefaultEvmMelvPolicy(args) {
  return buildEvmMelvPolicy(args);
}

function buildEvmMelvPolicyRef(args) {
  const policy = buildDefaultEvmMelvPolicy(args);
  return {
    policy,
    policyID: bytes32FromText(policy.policyID),
    policyHash: hashJson(policy),
  };
}

module.exports = {
  buildEvmMelvPolicy,
  buildDefaultEvmMelvPolicy,
  buildEvmMelvPolicyRef,
};
