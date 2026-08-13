// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library HXMsgLib {
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
        bytes32 replayScope;
        uint64 sourceNonce;
        uint8 sourceChainType;
        bytes32 sourceChainID;
    }

    struct ClusterCertificate {
        bytes32 clusterID;
        uint8 sourceChainType;
        bytes32 sourceChainID;
        uint64 epoch;
        uint16 threshold;
        uint16 participantCount;
        uint256 signerBitmap;
        bytes32 selectedSignerHash;
        bytes signatures;
        bytes32 signingDigest;
        bytes32 subjectDigest;
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

    function hashDelivery(HXMsgMinimal calldata m) internal pure returns (bytes32) {
        bytes32 chainHash = keccak256(
            abi.encode(m.requestID, m.hmsgDigest, m.sourceChainType, m.sourceChainID,
                m.targetChainType, m.targetChainID, m.actionType)
        );
        bytes32 actionHash = keccak256(
            abi.encode(m.targetObject, m.functionSelector, m.callDataHash, m.receiver, m.targetExecutionHash)
        );
        bytes32 feedbackHash = keccak256(
            abi.encode(m.feedbackRequired, m.expectedFeedbackMsgType, m.feedbackTimeout, m.callbackRefHash, m.expireAt)
        );
        bytes32 replayHash = keccak256(abi.encode(m.replayScope, m.sourceNonce));
        return keccak256(abi.encode(chainHash, actionHash, feedbackHash, replayHash));
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
