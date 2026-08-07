// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./ResponseLifecycleBase.sol";

/// @notice EVM 源链请求入口；响应生命周期由共享基类实现。
contract EvmSourceContract is ResponseLifecycleBase {
    uint64 public nonce;

    event CrossChainCallRequested(
        bytes32 indexed requestID,
        address indexed sender,
        bytes32 indexed targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 nonce,
        uint64 expireAt,
        bool feedbackRequired,
        uint8 expectedFeedbackMsgType,
        uint64 feedbackTimeout,
        bytes32 callbackRefHash,
        bytes32 atomicityHash
    );

    constructor(address registry) ResponseLifecycleBase(registry) {}

    function submitHXMsgRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        RequestPolicy calldata policy
    ) external returns (bytes32) {
        _validatePolicy(policy);
        return _createRequest(targetChainID, targetDomainID, targetObject, functionSelector, callDataHash,
            businessPayloadHash, receiver, expireAt, policy);
    }

    function submitTokenEscrowHXMsgRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        RequestPolicy calldata policy,
        address token,
        uint256 amount
    ) external returns (bytes32) {
        require(policy.atomicity.required, "atomicity required");
        require(policy.atomicity.commitmentType == uint8(CommitmentType.TOKEN_ESCROW), "token escrow required");
        _validatePolicy(policy);
        bytes32 requestID = _createRequest(targetChainID, targetDomainID, targetObject, functionSelector,
            callDataHash, businessPayloadHash, receiver, expireAt, policy);
        _lockTokenEscrow(requestID, token, msg.sender, amount);
        return requestID;
    }

    function _createRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        RequestPolicy calldata policy
    ) internal returns (bytes32 requestID) {
        require(expireAt > block.timestamp, "expired request");
        uint64 currentNonce = ++nonce;
        requestID = keccak256(abi.encode(block.chainid, address(this), msg.sender, currentNonce,
            targetChainID, targetDomainID, targetObject, functionSelector, callDataHash));
        bytes32 targetExecutionHash = keccak256(abi.encode(requestID, targetChainID, targetObject,
            functionSelector, callDataHash, receiver));
        _storeResponseLifecycle(requestID, targetExecutionHash, policy);

        emit CrossChainCallRequested(requestID, msg.sender, targetChainID, targetDomainID, targetObject,
            functionSelector, callDataHash, businessPayloadHash, receiver, currentNonce, expireAt,
            policy.feedbackRequired, policy.expectedFeedbackMsgType, policy.feedbackTimeout,
            policy.callbackRefHash, HXMsgLib.hashAtomicity(policy.atomicity));
    }
}
