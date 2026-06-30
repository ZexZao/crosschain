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

    struct ClusterCertificate {
        bytes32 clusterID;
        uint64 epoch;
        uint16 threshold;
        uint16 participantCount;
        uint256 signerBitmap;
        bytes32 selectedSignerHash;
        bytes signatures;
        bytes32 signingDigest;
        uint64 committedTerm;
        uint64 committedIndex;
    }

    struct Atomicity {
        bool required;
        uint8 mode;
        uint8 commitmentType;
        bytes32 commitmentRefHash;
        bytes32 successActionHash;
        bytes32 failureActionHash;
        uint64 challengeWindow;
    }

    struct ResponseProof {
        bytes32 originRequestID;
        bytes32 originHmsgDigest;
        uint8 responseStatus;
        bytes32 targetExecutionHash;
        bytes32 targetProofRefHash;
        bytes32 responsePayloadHash;
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
        bytes32 atomicityHash = keccak256(abi.encode(false, uint8(0), uint8(0), bytes32(0), bytes32(0), bytes32(0), uint64(0)));
        return keccak256(
            abi.encode(headerHash, endpointHash, actionHash, verificationHash, bindingHash, feedbackHash, atomicityHash)
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

    function hashAtomicity(Atomicity memory atomicity) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                atomicity.required,
                atomicity.mode,
                atomicity.commitmentType,
                atomicity.commitmentRefHash,
                atomicity.successActionHash,
                atomicity.failureActionHash,
                atomicity.challengeWindow
            )
        );
    }

    function hashResponse(ResponseProof calldata response) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                response.originRequestID,
                response.originHmsgDigest,
                response.responseStatus,
                response.targetExecutionHash,
                response.targetProofRefHash,
                response.responsePayloadHash
            )
        );
    }

}
