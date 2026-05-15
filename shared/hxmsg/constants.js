const ChainType = Object.freeze({
  UNKNOWN: 0,
  EVM: 1,
  FABRIC: 2,
  CUSTOM: 255,
});

const RefType = Object.freeze({
  UNKNOWN: 0,
  EVM_EVENT: 1,
  EVM_RECEIPT: 2,
  FABRIC_VIEW: 3,
  FABRIC_TX: 4,
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
  CUSTOM_TEE_ADAPTER: 255,
});

const PolicyType = Object.freeze({
  UNKNOWN: 0,
  EVM_FINALITY: 1,
  FABRIC_ENDORSEMENT: 2,
  FABRIC_MEMBERSHIP: 3,
  ADAPTER_LOCAL: 5,
  CUSTOM: 255,
});

module.exports = {
  ChainType,
  RefType,
  MsgType,
  FeedbackType,
  ActionType,
  FinalityModel,
  VerificationMethod,
  PolicyType,
};
