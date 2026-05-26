// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./TEERegistry.sol";

contract EvmSourceContract {
    enum RequestStatus {
        None,
        Pending,
        Challenged,
        Completed,
        Compensated,
        Failed,
        Cancelled
    }

    enum CommitmentType {
        NONE,
        INTENT_ONLY,
        STATE_LOCK,
        TOKEN_ESCROW,
        PERMISSION_LOCK,
        CUSTOM
    }

    uint8 public constant RESPONSE_STATUS_EXECUTED = 1;

    struct RequestRecord {
        address sender;
        bytes32 targetChainID;
        bytes32 targetDomainID;
        bytes32 targetObject;
        bytes4 functionSelector;
        bytes32 callDataHash;
        bytes32 businessPayloadHash;
        bytes32 receiver;
        bytes32 targetExecutionHash;
        bytes32 commitmentRefHash;
        bytes32 successActionHash;
        bytes32 failureActionHash;
        uint64 nonce;
        uint64 expireAt;
        uint64 feedbackTimeout;
        uint64 challengeWindow;
        uint64 challengeDeadline;
        CommitmentType commitmentType;
        RequestStatus status;
    }

    uint64 public nonce;
    TEERegistry public immutable teeRegistry;
    mapping(bytes32 => RequestRecord) public requests;
    mapping(bytes32 => bool) public consumedResponses;

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
        uint64 expireAt
    );

    event RequestStatusChanged(bytes32 indexed requestID, RequestStatus from, RequestStatus to);
    event ChallengeStarted(bytes32 indexed requestID, uint64 challengeDeadline);
    event ResponseCompleted(bytes32 indexed requestID, bytes32 responseDigest);
    event RequestCompensated(bytes32 indexed requestID, CommitmentType commitmentType);

    constructor(address registry) {
        teeRegistry = TEERegistry(registry);
    }

    function submitRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt
    ) external returns (bytes32) {
        return _submitRequest(
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            expireAt,
            expireAt,
            HXMsgLib.Atomicity({
                required: false,
                mode: 0,
                commitmentType: uint8(CommitmentType.NONE),
                commitmentRefHash: bytes32(0),
                successActionHash: bytes32(0),
                failureActionHash: bytes32(0),
                challengeWindow: 0
            })
        );
    }

    function submitAtomicRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        uint64 feedbackTimeout,
        HXMsgLib.Atomicity calldata atomicity
    ) external returns (bytes32) {
        require(atomicity.required, "atomicity required");
        require(atomicity.mode == 1, "bad atomicity mode");
        require(atomicity.challengeWindow > 0, "bad challenge window");
        require(feedbackTimeout > block.timestamp, "bad feedback timeout");
        return _submitRequest(
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            expireAt,
            feedbackTimeout,
            atomicity
        );
    }

    function _submitRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        uint64 feedbackTimeout,
        HXMsgLib.Atomicity memory atomicity
    ) internal returns (bytes32) {
        require(expireAt > block.timestamp, "expired request");
        nonce += 1;
        bytes32 requestID = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                nonce,
                targetChainID,
                targetDomainID,
                targetObject,
                functionSelector,
                callDataHash
            )
        );
        require(requests[requestID].status == RequestStatus.None, "duplicate request");

        bytes32 targetExecutionHash = keccak256(
            abi.encode(requestID, targetChainID, targetObject, functionSelector, callDataHash, receiver)
        );

        requests[requestID] = RequestRecord({
            sender: msg.sender,
            targetChainID: targetChainID,
            targetDomainID: targetDomainID,
            targetObject: targetObject,
            functionSelector: functionSelector,
            callDataHash: callDataHash,
            businessPayloadHash: businessPayloadHash,
            receiver: receiver,
            targetExecutionHash: targetExecutionHash,
            commitmentRefHash: atomicity.commitmentRefHash,
            successActionHash: atomicity.successActionHash,
            failureActionHash: atomicity.failureActionHash,
            nonce: nonce,
            expireAt: expireAt,
            feedbackTimeout: feedbackTimeout,
            challengeWindow: atomicity.challengeWindow,
            challengeDeadline: 0,
            commitmentType: CommitmentType(atomicity.commitmentType),
            status: RequestStatus.Pending
        });

        emit CrossChainCallRequested(
            requestID,
            msg.sender,
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            nonce,
            expireAt
        );
        emit RequestStatusChanged(requestID, RequestStatus.None, RequestStatus.Pending);
        return requestID;
    }

    function startChallenge(bytes32 requestID) external {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Pending, "not pending");
        require(record.challengeWindow > 0, "not atomic");
        require(block.timestamp > record.feedbackTimeout, "not timeout");
        RequestStatus from = record.status;
        record.status = RequestStatus.Challenged;
        record.challengeDeadline = uint64(block.timestamp) + record.challengeWindow;
        emit RequestStatusChanged(requestID, from, RequestStatus.Challenged);
        emit ChallengeStarted(requestID, record.challengeDeadline);
    }

    function completeWithResponse(
        bytes32 requestID,
        HXMsgLib.ResponseProof calldata response,
        HXMsgLib.TEECertification[] calldata certs,
        uint256 threshold
    ) external {
        RequestRecord storage record = requests[requestID];
        require(
            record.status == RequestStatus.Pending || record.status == RequestStatus.Challenged,
            "bad status"
        );
        require(response.originRequestID == requestID, "bad origin");
        require(response.targetExecutionHash == record.targetExecutionHash, "bad target execution");
        require(response.responseStatus == RESPONSE_STATUS_EXECUTED, "not executed");
        bytes32 responseDigest = HXMsgLib.hashResponse(response);
        require(!consumedResponses[responseDigest], "response replay");
        _verifyTEEQuorum(requestID, responseDigest, certs, threshold);

        RequestStatus from = record.status;
        consumedResponses[responseDigest] = true;
        record.status = RequestStatus.Completed;
        emit RequestStatusChanged(requestID, from, RequestStatus.Completed);
        emit ResponseCompleted(requestID, responseDigest);
    }

    function compensateAfterChallenge(bytes32 requestID, bytes calldata failureData) external {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Challenged, "not challenged");
        require(block.timestamp > record.challengeDeadline, "challenge active");
        require(keccak256(failureData) == record.failureActionHash, "bad failure data");
        require(
            record.commitmentType == CommitmentType.INTENT_ONLY || record.commitmentType == CommitmentType.STATE_LOCK,
            "unsupported commitment"
        );
        RequestStatus from = record.status;
        record.status = RequestStatus.Compensated;
        emit RequestStatusChanged(requestID, from, RequestStatus.Compensated);
        emit RequestCompensated(requestID, record.commitmentType);
    }

    function _verifyTEEQuorum(
        bytes32 requestID,
        bytes32 digest,
        HXMsgLib.TEECertification[] calldata certs,
        uint256 threshold
    ) internal view {
        require(threshold > 0, "bad threshold");
        require(certs.length >= threshold, "not enough certs");
        uint256 validCount = 0;
        for (uint256 i = 0; i < certs.length; i += 1) {
            require(certs[i].requestID == requestID, "cert request mismatch");
            require(certs[i].hmsgDigest == digest, "cert digest mismatch");
            address signer = _recover(digest, certs[i].signature);
            require(signer == certs[i].teeAddress, "bad tee signature");
            require(teeRegistry.trustedTEE(signer), "untrusted tee");
            for (uint256 j = 0; j < i; j += 1) {
                require(certs[j].teeAddress != signer, "duplicate tee");
            }
            validCount += 1;
        }
        require(validCount >= threshold, "tee quorum not reached");
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, s);
    }
}
