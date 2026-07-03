const ChainType = Object.freeze({
  UNKNOWN: 0,
  EVM: 1,
  FABRIC: 2,
  AVALANCHE: 3,
  CUSTOM: 255,
});

const RefType = Object.freeze({
  UNKNOWN: 0,
  EVM_EVENT: 1,
  EVM_RECEIPT: 2,
  FABRIC_VIEW: 3,
  FABRIC_TX: 4,
  AVALANCHE_WARP_MESSAGE: 5,
  CUSTOM: 255,
});

const MsgType = Object.freeze({
  UNKNOWN: 0,
  CONTRACT_CALL: 1,
  RESPONSE: 2,
  ACK: 3,
  CHALLENGE: 4,
});

const FeedbackType = Object.freeze({
  NONE: 0,
  RESPONSE: MsgType.RESPONSE,
  ACK: MsgType.ACK,
  CHALLENGE: MsgType.CHALLENGE,
  CUSTOM: 255,
});

const AtomicityMode = Object.freeze({
  NONE: 0,
  COMMIT_OR_COMPENSATE: 1,
  CUSTOM: 255,
});

const CommitmentType = Object.freeze({
  NONE: 0,
  INTENT_ONLY: 1,
  STATE_LOCK: 2,
  TOKEN_ESCROW: 3,
  PERMISSION_LOCK: 4,
  CUSTOM: 255,
});

const ResponseStatus = Object.freeze({
  UNKNOWN: 0,
  EXECUTED: 1,
  FAILED: 2,
  REVERTED: 3,
});

const ActionType = Object.freeze({
  UNKNOWN: 0,
  CONTRACT_CALL: 1,
  ASSET_MINT: 2,
  ASSET_UNLOCK: 3,
  STATE_UPDATE: 4,
  CHAINCODE_INVOKE: 5,
  CUSTOM: 255,
});

const FinalityModel = Object.freeze({
  UNKNOWN: 0,
  IMMEDIATE: 1,
  PROBABILISTIC: 2,
  ECONOMIC: 3,
  CHECKPOINT: 4,
  APPLICATION: 5,
});

const VerificationMethod = Object.freeze({
  UNKNOWN: 0,
  EVM_EVENT: 1,
  EVM_RECEIPT: 2,
  EVM_LIGHT_CLIENT: 3,
  H_FSV: 4,
  FABRIC_TX_STATUS: 5,
  AVALANCHE_ICM_BLS: 6,
  CUSTOM_TEE_ADAPTER: 255,
});

const PolicyType = Object.freeze({
  UNKNOWN: 0,
  EVM_FINALITY: 1,
  FABRIC_ENDORSEMENT: 2,
  FABRIC_MEMBERSHIP: 3,
  AVALANCHE_VALIDATOR_SET: 4,
  ADAPTER_LOCAL: 5,
  CUSTOM: 255,
});

module.exports = {
  ChainType,
  RefType,
  MsgType,
  FeedbackType,
  AtomicityMode,
  CommitmentType,
  ResponseStatus,
  ActionType,
  FinalityModel,
  VerificationMethod,
  PolicyType,
};
