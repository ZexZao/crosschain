// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./TEERegistry.sol";

interface IERC20EscrowToken {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

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
    uint8 public constant MSG_TYPE_RESPONSE = 2;

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

    struct RequestPolicy {
        bool feedbackRequired;
        uint8 expectedFeedbackMsgType;
        uint64 feedbackTimeout;
        bytes32 callbackRefHash;
        HXMsgLib.Atomicity atomicity;
    }

    struct TokenEscrow {
        address token;
        address owner;
        uint256 amount;
        bool refunded;
    }

    uint64 public nonce;
    TEERegistry public immutable teeRegistry;
    mapping(bytes32 => RequestRecord) public requests;
    mapping(bytes32 => bool) public consumedResponses;
    mapping(bytes32 => TokenEscrow) public tokenEscrows;

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

    event RequestStatusChanged(bytes32 indexed requestID, RequestStatus from, RequestStatus to);
    event ChallengeStarted(bytes32 indexed requestID, uint64 challengeDeadline);
    event ResponseCompleted(bytes32 indexed requestID, bytes32 responseDigest);
    event RequestCompensated(bytes32 indexed requestID, CommitmentType commitmentType);
    event TokenEscrowLocked(bytes32 indexed requestID, address indexed token, address indexed owner, uint256 amount);
    event TokenEscrowRefunded(bytes32 indexed requestID, address indexed token, address indexed owner, uint256 amount);

    constructor(address registry) {
        teeRegistry = TEERegistry(registry);
    }

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
        return _createRequest(
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            expireAt,
            policy
        );
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
        require(token != address(0), "bad token");
        require(amount > 0, "bad amount");
        require(policy.atomicity.required, "atomicity required");
        require(policy.atomicity.commitmentType == uint8(CommitmentType.TOKEN_ESCROW), "token escrow required");
        _validatePolicy(policy);
        bytes32 requestID = _createRequest(
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            expireAt,
            policy
        );
        require(IERC20EscrowToken(token).transferFrom(msg.sender, address(this), amount), "escrow transfer failed");
        tokenEscrows[requestID] = TokenEscrow({
            token: token,
            owner: msg.sender,
            amount: amount,
            refunded: false
        });
        emit TokenEscrowLocked(requestID, token, msg.sender, amount);
        return requestID;
    }

    function _validatePolicy(RequestPolicy calldata policy) internal view {
        if (policy.feedbackRequired) {
            require(policy.expectedFeedbackMsgType == MSG_TYPE_RESPONSE, "bad feedback type");
            require(policy.feedbackTimeout > block.timestamp, "bad feedback timeout");
        } else {
            require(policy.expectedFeedbackMsgType == 0, "unexpected feedback type");
            require(policy.feedbackTimeout == 0, "unexpected feedback timeout");
            require(policy.callbackRefHash == bytes32(0), "unexpected callback ref");
        }

        if (policy.atomicity.required) {
            require(policy.feedbackRequired, "atomicity requires feedback");
            require(policy.expectedFeedbackMsgType == MSG_TYPE_RESPONSE, "atomicity requires response");
            require(policy.atomicity.mode == 1, "bad atomicity mode");
            require(policy.atomicity.challengeWindow > 0, "bad challenge window");
        } else {
            require(policy.atomicity.mode == 0, "unexpected atomicity mode");
            require(policy.atomicity.commitmentType == uint8(CommitmentType.NONE), "unexpected commitment type");
            require(policy.atomicity.commitmentRefHash == bytes32(0), "unexpected commitment ref");
            require(policy.atomicity.successActionHash == bytes32(0), "unexpected success action");
            require(policy.atomicity.failureActionHash == bytes32(0), "unexpected failure action");
            require(policy.atomicity.challengeWindow == 0, "unexpected challenge window");
        }
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
            commitmentRefHash: policy.atomicity.commitmentRefHash,
            successActionHash: policy.atomicity.successActionHash,
            failureActionHash: policy.atomicity.failureActionHash,
            nonce: nonce,
            expireAt: expireAt,
            feedbackTimeout: policy.feedbackTimeout,
            challengeWindow: policy.atomicity.challengeWindow,
            challengeDeadline: 0,
            commitmentType: CommitmentType(policy.atomicity.commitmentType),
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
            expireAt,
            policy.feedbackRequired,
            policy.expectedFeedbackMsgType,
            policy.feedbackTimeout,
            policy.callbackRefHash,
            HXMsgLib.hashAtomicity(policy.atomicity)
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
        HXMsgLib.ClusterCertificate calldata cert
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
        _verifyTEECluster(responseDigest, cert);

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
        require(record.commitmentType == CommitmentType.TOKEN_ESCROW, "unsupported commitment");
        RequestStatus from = record.status;
        _refundTokenEscrow(requestID);
        record.status = RequestStatus.Compensated;
        emit RequestStatusChanged(requestID, from, RequestStatus.Compensated);
        emit RequestCompensated(requestID, record.commitmentType);
    }

    function _refundTokenEscrow(bytes32 requestID) internal {
        TokenEscrow storage escrow = tokenEscrows[requestID];
        require(escrow.token != address(0), "token escrow not found");
        require(!escrow.refunded, "token escrow refunded");
        escrow.refunded = true;
        require(IERC20EscrowToken(escrow.token).transfer(escrow.owner, escrow.amount), "refund transfer failed");
        emit TokenEscrowRefunded(requestID, escrow.token, escrow.owner, escrow.amount);
    }

    function _verifyTEECluster(bytes32 digest, HXMsgLib.ClusterCertificate calldata cert) internal view {
        require(teeRegistry.verifyClusterCertificate(digest, TEERegistry.ClusterCertificate({
            clusterID: cert.clusterID,
            epoch: cert.epoch,
            threshold: cert.threshold,
            participantCount: cert.participantCount,
            signerBitmap: cert.signerBitmap,
            selectedSignerHash: cert.selectedSignerHash,
            signatures: cert.signatures,
            signingDigest: cert.signingDigest,
            committedTerm: cert.committedTerm,
            committedIndex: cert.committedIndex
        })), "bad cluster cert");
    }
}
