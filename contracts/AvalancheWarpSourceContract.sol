// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./ResponseLifecycleBase.sol";

interface IWarpMessenger {
    event SendWarpMessage(address indexed sender, bytes32 indexed messageID, bytes message);
    function sendWarpMessage(bytes calldata payload) external returns (bytes32 messageID);
    function getBlockchainID() external view returns (bytes32 blockchainID);
}

/// @notice Avalanche 源链请求入口。
/// @dev Warp 权重签名证明源链事实；共享基类处理 RESPONSE、挑战和真实资产补偿。
contract AvalancheWarpSourceContract is ResponseLifecycleBase {
    IWarpMessenger public constant WARP_MESSENGER =
        IWarpMessenger(0x0200000000000000000000000000000000000005);

    struct WarpHXMsgRequest {
        bytes32 requestID;
        bytes32 targetChainID;
        bytes32 targetDomainID;
        bytes32 targetObject;
        bytes4 functionSelector;
        bytes32 callDataHash;
        bytes32 businessPayloadHash;
        bytes32 receiver;
        uint64 nonce;
        uint64 expireAt;
        bool feedbackRequired;
        uint8 expectedFeedbackMsgType;
        uint64 feedbackTimeout;
        bytes32 callbackRefHash;
        HXMsgLib.Atomicity atomicity;
        bytes32 validatorPolicyHash;
        bytes callData;
    }

    uint64 public nonce;
    mapping(bytes32 => bytes32) public requestToWarpMessage;

    event AvalancheHXMsgWarpRequested(
        bytes32 indexed requestID,
        bytes32 indexed warpMessageID,
        address indexed sender,
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 nonce,
        uint64 expireAt,
        bytes32 validatorPolicyHash,
        bytes32 feedbackHash,
        bytes32 atomicityHash
    );

    constructor(address registry) ResponseLifecycleBase(registry) {}

    function submitWarpHXMsgRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes calldata callData,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        bytes32 validatorPolicyHash,
        RequestPolicy calldata policy
    ) external returns (bytes32 requestID, bytes32 warpMessageID) {
        _validatePolicy(policy);
        return _createWarpRequest(targetChainID, targetDomainID, targetObject, functionSelector, callData,
            businessPayloadHash, receiver, expireAt, validatorPolicyHash, policy);
    }

    function submitTokenEscrowWarpHXMsgRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes calldata callData,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        bytes32 validatorPolicyHash,
        RequestPolicy calldata policy,
        address token,
        uint256 amount
    ) external returns (bytes32 requestID, bytes32 warpMessageID) {
        require(policy.atomicity.required, "atomicity required");
        require(policy.atomicity.commitmentType == uint8(CommitmentType.TOKEN_ESCROW), "token escrow required");
        _validatePolicy(policy);
        (requestID, warpMessageID) = _createWarpRequest(targetChainID, targetDomainID, targetObject,
            functionSelector, callData, businessPayloadHash, receiver, expireAt, validatorPolicyHash, policy);
        _lockTokenEscrow(requestID, token, msg.sender, amount);
    }

    function _createWarpRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes calldata callData,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        bytes32 validatorPolicyHash,
        RequestPolicy calldata policy
    ) internal returns (bytes32 requestID, bytes32 warpMessageID) {
        require(expireAt > block.timestamp, "expired request");
        require(validatorPolicyHash != bytes32(0), "bad validator policy");
        uint64 currentNonce = ++nonce;
        bytes32 callDataHash = keccak256(callData);
        bytes32 feedbackHash = keccak256(abi.encode(policy.feedbackRequired, policy.expectedFeedbackMsgType,
            policy.feedbackTimeout, policy.callbackRefHash));
        bytes32 atomicityHash = HXMsgLib.hashAtomicity(policy.atomicity);

        requestID = keccak256(abi.encode(block.chainid, address(this), msg.sender, currentNonce,
            targetChainID, targetDomainID, targetObject, functionSelector, callDataHash,
            businessPayloadHash, receiver, expireAt, validatorPolicyHash, feedbackHash, atomicityHash));
        bytes32 targetExecutionHash = keccak256(abi.encode(requestID, targetChainID, targetObject,
            functionSelector, callDataHash, receiver));
        _storeResponseLifecycle(requestID, targetExecutionHash, policy);

        bytes memory payload = abi.encode(WarpHXMsgRequest(requestID, targetChainID, targetDomainID, targetObject,
            functionSelector, callDataHash, businessPayloadHash, receiver, currentNonce, expireAt,
            policy.feedbackRequired, policy.expectedFeedbackMsgType, policy.feedbackTimeout,
            policy.callbackRefHash, policy.atomicity, validatorPolicyHash, callData));
        warpMessageID = WARP_MESSENGER.sendWarpMessage(payload);
        requestToWarpMessage[requestID] = warpMessageID;

        emit AvalancheHXMsgWarpRequested(requestID, warpMessageID, msg.sender, targetChainID,
            targetDomainID, targetObject, functionSelector, callDataHash, businessPayloadHash,
            receiver, currentNonce, expireAt, validatorPolicyHash, feedbackHash, atomicityHash);
    }

    function getAvalancheBlockchainID() external view returns (bytes32) {
        return WARP_MESSENGER.getBlockchainID();
    }
}
