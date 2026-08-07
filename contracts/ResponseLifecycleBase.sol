// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./TEERegistry.sol";

interface IERC20EscrowToken {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice EVM 兼容源链共享的响应、挑战和真实资产补偿生命周期。
/// @dev 源链事实证明由派生合约负责；本合约只处理已绑定 requestID 的后续状态。
abstract contract ResponseLifecycleBase {
    enum RequestStatus { None, Pending, Challenged, Completed, Compensated, Failed, Cancelled }
    enum CommitmentType { NONE, INTENT_ONLY, STATE_LOCK, TOKEN_ESCROW, PERMISSION_LOCK, CUSTOM }

    uint8 public constant RESPONSE_STATUS_EXECUTED = 1;
    uint8 public constant MSG_TYPE_RESPONSE = 2;

    struct RequestRecord {
        bytes32 targetExecutionHash;
        bytes32 failureActionHash;
        uint64 feedbackTimeout;
        uint64 challengeWindow;
        uint64 challengeDeadline;
        CommitmentType commitmentType;
        RequestStatus status;
        bytes32 responseDigest;
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
        bool settled;
    }

    TEERegistry public immutable teeRegistry;
    address public immutable watcherAdmin;
    mapping(address => bool) public authorizedWatchers;
    mapping(bytes32 => RequestRecord) public requests;
    mapping(bytes32 => bool) public consumedResponses;
    mapping(bytes32 => TokenEscrow) public tokenEscrows;
    uint64 public lifecycleCheckpointEpoch;
    bytes32 public latestLifecycleCheckpointRoot;
    bytes32 public constant LIFECYCLE_CHECKPOINT_DOMAIN = keccak256("HXMSG_LIFECYCLE_CHECKPOINT_V1");

    event RequestStatusChanged(bytes32 indexed requestID, RequestStatus from, RequestStatus to);
    event ChallengeStarted(bytes32 indexed requestID, uint64 challengeDeadline);
    event ResponseCompleted(bytes32 indexed requestID, bytes32 responseDigest);
    event RequestCompensated(bytes32 indexed requestID, CommitmentType commitmentType);
    event TokenEscrowLocked(bytes32 indexed requestID, address indexed token, address indexed owner, uint256 amount);
    event TokenEscrowRefunded(bytes32 indexed requestID, address indexed token, address indexed owner, uint256 amount);
    event TokenEscrowSettled(bytes32 indexed requestID, address indexed token, address indexed owner, uint256 amount);
    event WatcherAuthorizationChanged(address indexed watcher, bool authorized);
    event LifecycleCheckpointed(uint64 indexed epoch, bytes32 indexed checkpointRoot, bytes32 terminalStateRoot, uint256 requestCount);

    modifier onlyWatcher() {
        require(authorizedWatchers[msg.sender], "unauthorized watcher");
        _;
    }

    constructor(address registry) {
        require(registry != address(0), "bad registry");
        teeRegistry = TEERegistry(registry);
        watcherAdmin = msg.sender;
        authorizedWatchers[msg.sender] = true;
        emit WatcherAuthorizationChanged(msg.sender, true);
    }

    function setWatcher(address watcher, bool authorized) external {
        require(msg.sender == watcherAdmin, "not watcher admin");
        require(watcher != address(0), "bad watcher");
        authorizedWatchers[watcher] = authorized;
        emit WatcherAuthorizationChanged(watcher, authorized);
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

    function _storeResponseLifecycle(
        bytes32 requestID,
        bytes32 targetExecutionHash,
        RequestPolicy calldata policy
    ) internal {
        if (!policy.feedbackRequired) return;
        requests[requestID] = RequestRecord({
            targetExecutionHash: targetExecutionHash,
            failureActionHash: policy.atomicity.failureActionHash,
            feedbackTimeout: policy.feedbackTimeout,
            challengeWindow: policy.atomicity.challengeWindow,
            challengeDeadline: 0,
            commitmentType: CommitmentType(policy.atomicity.commitmentType),
            status: RequestStatus.Pending,
            responseDigest: bytes32(0)
        });
        emit RequestStatusChanged(requestID, RequestStatus.None, RequestStatus.Pending);
    }

    function _lockTokenEscrow(bytes32 requestID, address token, address owner, uint256 amount) internal {
        require(token != address(0), "bad token");
        require(amount > 0, "bad amount");
        require(IERC20EscrowToken(token).transferFrom(owner, address(this), amount), "escrow transfer failed");
        tokenEscrows[requestID] = TokenEscrow(token, owner, amount, false, false);
        emit TokenEscrowLocked(requestID, token, owner, amount);
    }

    function startChallenge(bytes32 requestID) external onlyWatcher {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Pending, "not pending");
        require(record.challengeWindow > 0, "not atomic");
        require(block.timestamp > record.feedbackTimeout, "not timeout");
        record.status = RequestStatus.Challenged;
        record.challengeDeadline = uint64(block.timestamp) + record.challengeWindow;
        emit RequestStatusChanged(requestID, RequestStatus.Pending, RequestStatus.Challenged);
        emit ChallengeStarted(requestID, record.challengeDeadline);
    }

    function completeWithResponse(
        bytes32 requestID,
        HXMsgLib.ResponseProof calldata response,
        HXMsgLib.ClusterCertificate calldata cert
    ) external {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Pending || record.status == RequestStatus.Challenged, "bad status");
        require(response.originRequestID == requestID, "bad origin");
        require(response.targetExecutionHash == record.targetExecutionHash, "bad target execution");
        require(response.responseStatus == RESPONSE_STATUS_EXECUTED, "not executed");
        bytes32 responseDigest = HXMsgLib.hashResponse(response);
        require(!consumedResponses[responseDigest], "response replay");
        _verifyTEECluster(responseDigest, cert);

        RequestStatus from = record.status;
        consumedResponses[responseDigest] = true;
        record.responseDigest = responseDigest;
        if (record.commitmentType == CommitmentType.TOKEN_ESCROW) _settleTokenEscrow(requestID);
        record.status = RequestStatus.Completed;
        emit RequestStatusChanged(requestID, from, RequestStatus.Completed);
        emit ResponseCompleted(requestID, responseDigest);
    }

    function compensateAfterChallenge(bytes32 requestID, bytes calldata failureData) external onlyWatcher {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Challenged, "not challenged");
        require(block.timestamp > record.challengeDeadline, "challenge active");
        require(keccak256(failureData) == record.failureActionHash, "bad failure data");
        require(record.commitmentType == CommitmentType.TOKEN_ESCROW, "unsupported commitment");
        _refundTokenEscrow(requestID);
        record.status = RequestStatus.Compensated;
        emit RequestStatusChanged(requestID, RequestStatus.Challenged, RequestStatus.Compensated);
        emit RequestCompensated(requestID, record.commitmentType);
    }

    function previewLifecycleCheckpoint(bytes32[] calldata requestIDs)
        external
        view
        returns (bytes32 terminalStateRoot, bytes32 signingDigest, uint64 nextEpoch)
    {
        terminalStateRoot = _computeTerminalStateRoot(requestIDs);
        nextEpoch = lifecycleCheckpointEpoch + 1;
        signingDigest = _checkpointSigningDigest(nextEpoch, terminalStateRoot, requestIDs.length);
    }

    function updateLifecycleCheckpoint(
        bytes32[] calldata requestIDs,
        bytes32 terminalStateRoot,
        HXMsgLib.ClusterCertificate calldata cert
    ) external onlyWatcher {
        require(requestIDs.length > 0 && requestIDs.length <= 256, "bad checkpoint size");
        bytes32 computedRoot = _computeTerminalStateRoot(requestIDs);
        require(computedRoot == terminalStateRoot, "bad terminal root");
        uint64 nextEpoch = lifecycleCheckpointEpoch + 1;
        _verifyTEECluster(_checkpointSigningDigest(nextEpoch, computedRoot, requestIDs.length), cert);

        for (uint256 i = 0; i < requestIDs.length; i += 1) {
            RequestRecord storage record = requests[requestIDs[i]];
            if (record.responseDigest != bytes32(0)) delete consumedResponses[record.responseDigest];
            delete tokenEscrows[requestIDs[i]];
            delete requests[requestIDs[i]];
        }
        bytes32 checkpointRoot = keccak256(
            abi.encode(latestLifecycleCheckpointRoot, nextEpoch, computedRoot, requestIDs.length)
        );
        lifecycleCheckpointEpoch = nextEpoch;
        latestLifecycleCheckpointRoot = checkpointRoot;
        emit LifecycleCheckpointed(nextEpoch, checkpointRoot, computedRoot, requestIDs.length);
    }

    function _computeTerminalStateRoot(bytes32[] calldata requestIDs) private view returns (bytes32 root) {
        require(requestIDs.length > 0 && requestIDs.length <= 256, "bad checkpoint size");
        for (uint256 i = 0; i < requestIDs.length; i += 1) {
            if (i > 0) require(uint256(requestIDs[i]) > uint256(requestIDs[i - 1]), "requestIDs not sorted");
            RequestRecord storage record = requests[requestIDs[i]];
            require(
                record.status == RequestStatus.Completed || record.status == RequestStatus.Compensated ||
                    record.status == RequestStatus.Failed || record.status == RequestStatus.Cancelled,
                "request not terminal"
            );
            TokenEscrow storage escrow = tokenEscrows[requestIDs[i]];
            if (record.commitmentType == CommitmentType.TOKEN_ESCROW) {
                require(escrow.refunded || escrow.settled, "escrow not terminal");
            }
            bytes32 leaf = keccak256(
                abi.encode(
                    requestIDs[i], record.status, record.commitmentType, record.targetExecutionHash,
                    record.failureActionHash, record.responseDigest, escrow.refunded, escrow.settled
                )
            );
            root = keccak256(abi.encode(root, leaf));
        }
    }

    function _checkpointSigningDigest(uint64 epoch, bytes32 terminalStateRoot, uint256 requestCount)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                LIFECYCLE_CHECKPOINT_DOMAIN, block.chainid, address(this), epoch,
                latestLifecycleCheckpointRoot, terminalStateRoot, requestCount
            )
        );
    }

    function _refundTokenEscrow(bytes32 requestID) private {
        TokenEscrow storage escrow = tokenEscrows[requestID];
        require(escrow.token != address(0), "token escrow not found");
        require(!escrow.refunded && !escrow.settled, "escrow closed");
        escrow.refunded = true;
        require(IERC20EscrowToken(escrow.token).transfer(escrow.owner, escrow.amount), "refund transfer failed");
        emit TokenEscrowRefunded(requestID, escrow.token, escrow.owner, escrow.amount);
    }

    function _settleTokenEscrow(bytes32 requestID) private {
        TokenEscrow storage escrow = tokenEscrows[requestID];
        require(escrow.token != address(0), "token escrow not found");
        require(!escrow.refunded && !escrow.settled, "escrow closed");
        escrow.settled = true;
        emit TokenEscrowSettled(requestID, escrow.token, escrow.owner, escrow.amount);
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
