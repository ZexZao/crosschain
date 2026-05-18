// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library HXMsgLib {
    struct PolicyRef {
        uint8 policyType;
        bytes32 policyID;
        bytes32 policyHash;
    }

    struct HXMsgOnChain {
        uint8 version;
        uint8 msgType;
        bytes32 requestID;
        uint8 sourceChainType;
        bytes32 sourceChainID;
        bytes32 sourceDomainID;
        uint8 targetChainType;
        bytes32 targetChainID;
        bytes32 targetDomainID;
        uint8 sourceRefType;
        bytes32 sourceRefHash;
        uint8 actionType;
        bytes32 targetObject;
        bytes4 functionSelector;
        bytes32 callDataHash;
        bytes32 receiver;
        uint8 verificationMethod;
        uint8 finalityModel;
        uint16 requiredConfirmations;
        PolicyRef policyRef;
        bytes32 adapterID;
        bytes32 sourcePayloadHash;
        bytes32 businessPayloadHash;
        bytes32 targetExecutionHash;
        bool feedbackRequired;
        uint8 expectedFeedbackMsgType;
        uint64 feedbackTimeout;
        bytes32 callbackRefHash;
        uint64 nonce;
        uint64 createdAt;
        uint64 expireAt;
    }

    struct HXMsgMinimal {
        bytes32 requestID;
        bytes32 hmsgDigest;
        uint8 targetChainType;
        bytes32 targetChainID;
        uint8 actionType;
        bytes32 targetObject;
        bytes4 functionSelector;
        bytes32 callDataHash;
        bytes32 receiver;
        bytes32 targetExecutionHash;
        bool feedbackRequired;
        uint8 expectedFeedbackMsgType;
        uint64 feedbackTimeout;
        bytes32 callbackRefHash;
        uint64 expireAt;
    }

    struct TEECertification {
        bytes32 requestID;
        bytes32 hmsgDigest;
        address teeAddress;
        uint64 verifiedAt;
        bytes signature;
    }

    function hashHXMsg(HXMsgOnChain calldata m) internal pure returns (bytes32) {
        bytes32 headerHash = keccak256(
            abi.encode(m.version, m.requestID, m.msgType, m.nonce, m.createdAt, m.expireAt)
        );
        bytes32 endpointHash = keccak256(
            abi.encode(
                m.sourceChainType,
                m.sourceChainID,
                m.sourceDomainID,
                m.targetChainType,
                m.targetChainID,
                m.targetDomainID,
                m.sourceRefType,
                m.sourceRefHash
            )
        );
        bytes32 actionHash = keccak256(
            abi.encode(
                m.actionType,
                m.targetObject,
                m.functionSelector,
                m.callDataHash,
                m.receiver
            )
        );
        bytes32 verificationHash = keccak256(
            abi.encode(
                m.verificationMethod,
                m.finalityModel,
                m.requiredConfirmations,
                m.policyRef.policyType,
                m.policyRef.policyID,
                m.policyRef.policyHash,
                m.adapterID
            )
        );
        bytes32 bindingHash = keccak256(
            abi.encode(m.sourcePayloadHash, m.businessPayloadHash, m.targetExecutionHash)
        );
        bytes32 feedbackHash = keccak256(
            abi.encode(
                m.feedbackRequired,
                m.expectedFeedbackMsgType,
                m.feedbackTimeout,
                m.callbackRefHash
            )
        );
        return keccak256(
            abi.encode(headerHash, endpointHash, actionHash, verificationHash, bindingHash, feedbackHash)
        );
    }

    function hashDelivery(HXMsgMinimal calldata m) internal pure returns (bytes32) {
        bytes32 chainHash = keccak256(
            abi.encode(m.requestID, m.hmsgDigest, m.targetChainType, m.targetChainID, m.actionType)
        );
        bytes32 actionHash = keccak256(
            abi.encode(m.targetObject, m.functionSelector, m.callDataHash, m.receiver, m.targetExecutionHash)
        );
        bytes32 feedbackHash = keccak256(
            abi.encode(m.feedbackRequired, m.expectedFeedbackMsgType, m.feedbackTimeout, m.callbackRefHash, m.expireAt)
        );
        return keccak256(abi.encode(chainHash, actionHash, feedbackHash));
    }

    function hashDeliveryFromFull(HXMsgOnChain calldata m, bytes32 hmsgDigest) internal pure returns (bytes32) {
        bytes32 chainHash = keccak256(
            abi.encode(m.requestID, hmsgDigest, m.targetChainType, m.targetChainID, m.actionType)
        );
        bytes32 actionHash = keccak256(
            abi.encode(m.targetObject, m.functionSelector, m.callDataHash, m.receiver, m.targetExecutionHash)
        );
        bytes32 feedbackHash = keccak256(
            abi.encode(m.feedbackRequired, m.expectedFeedbackMsgType, m.feedbackTimeout, m.callbackRefHash, m.expireAt)
        );
        return keccak256(abi.encode(chainHash, actionHash, feedbackHash));
    }

}
