// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMercuryTEERegistry {
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

    function verifyClusterCertificate(bytes32 expectedDigest, ClusterCertificate calldata cert)
        external
        view
        returns (bool);
}

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Source-chain vault for the MERCURY challenge/response protocol.
/// A deposit stays refundable until a TEE quorum certifies a finalized target
/// transfer. Completed/refunded records are deleted, matching Algorithm 1.
contract MercuryVault {
    enum Status {
        None,
        Pending,
        Challenged
    }

    enum Outcome {
        None,
        Completed,
        Refunded
    }

    struct DepositRecord {
        address owner;
        address token;
        uint256 amount;
        bytes32 requestHash;
        uint64 responseDeadline;
        uint64 challengeStartedAt;
        Status status;
    }

    IMercuryTEERegistry public immutable teeRegistry;
    address public immutable treasury;
    uint256 public immutable challengePledge;
    uint64 public immutable challengeWait;
    uint64 public nonce;
    uint256 private locked;

    mapping(bytes32 => DepositRecord) public deposits;
    mapping(bytes32 => Outcome) public outcomes;
    mapping(bytes32 => bool) public acceptedCheckpoints;

    event MercuryDepositCreated(
        bytes32 indexed depositID,
        address indexed owner,
        address indexed token,
        uint256 amount,
        bytes32 requestHash,
        uint64 responseDeadline
    );
    event MercuryDepositConfirmed(bytes32 indexed depositID, bytes32 indexed targetTxID);
    event MercuryChallengeStarted(bytes32 indexed depositID, uint64 challengeDeadline, uint256 pledge);
    event MercuryRefunded(bytes32 indexed depositID, address indexed owner, uint256 amount, uint256 pledge);
    event MercuryCheckpointUpdated(bytes32 indexed checkpointID, bytes32 indexed idSetHash, uint256 depositCount);

    modifier nonReentrant() {
        require(locked == 0, "reentrant");
        locked = 1;
        _;
        locked = 0;
    }

    constructor(address registry, address treasury_, uint256 challengePledge_, uint64 challengeWait_) {
        require(registry != address(0), "bad registry");
        require(treasury_ != address(0), "bad treasury");
        require(challengeWait_ > 0, "bad challenge wait");
        teeRegistry = IMercuryTEERegistry(registry);
        treasury = treasury_;
        challengePledge = challengePledge_;
        challengeWait = challengeWait_;
    }

    function createDeposit(address token, uint256 amount, bytes32 requestHash, uint64 responseDeadline)
        external
        nonReentrant
        returns (bytes32 depositID)
    {
        require(token != address(0), "bad token");
        require(amount > 0, "bad amount");
        require(requestHash != bytes32(0), "bad request");
        require(responseDeadline > block.timestamp, "bad deadline");

        nonce += 1;
        depositID = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce, token, amount, requestHash));
        require(outcomes[depositID] == Outcome.None && deposits[depositID].status == Status.None, "duplicate");
        _safeTransferFrom(token, msg.sender, address(this), amount);

        deposits[depositID] = DepositRecord({
            owner: msg.sender,
            token: token,
            amount: amount,
            requestHash: requestHash,
            responseDeadline: responseDeadline,
            challengeStartedAt: 0,
            status: Status.Pending
        });
        emit MercuryDepositCreated(depositID, msg.sender, token, amount, requestHash, responseDeadline);
    }

    /// @notice Confirm one finalized target transfer. This is also the
    /// operator response path for an active challenge.
    function confirmTransfer(
        bytes32 depositID,
        bytes32 targetTxID,
        IMercuryTEERegistry.ClusterCertificate calldata cert
    ) external nonReentrant {
        require(targetTxID != bytes32(0), "bad target tx");
        DepositRecord memory record = deposits[depositID];
        require(record.status == Status.Pending || record.status == Status.Challenged, "bad status");
        bytes32 expectedDigest = confirmationDigest(depositID, record.requestHash, targetTxID);
        require(teeRegistry.verifyClusterCertificate(expectedDigest, cert), "bad tee cert");

        delete deposits[depositID];
        outcomes[depositID] = Outcome.Completed;
        _safeTransfer(record.token, treasury, record.amount);
        if (record.status == Status.Challenged && challengePledge > 0) {
            _safeTransferETH(treasury, challengePledge);
        }
        emit MercuryDepositConfirmed(depositID, targetTxID);
    }

    function startChallenge(bytes32 depositID) external payable {
        DepositRecord storage record = deposits[depositID];
        require(record.status == Status.Pending, "bad status");
        require(msg.sender == record.owner, "not owner");
        require(block.timestamp > record.responseDeadline, "not timeout");
        require(msg.value == challengePledge, "bad pledge");
        record.status = Status.Challenged;
        record.challengeStartedAt = uint64(block.timestamp);
        emit MercuryChallengeStarted(depositID, uint64(block.timestamp) + challengeWait, msg.value);
    }

    function resolveChallenge(bytes32 depositID) external nonReentrant {
        DepositRecord memory record = deposits[depositID];
        require(record.status == Status.Challenged, "not challenged");
        require(msg.sender == record.owner, "not owner");
        require(block.timestamp > uint256(record.challengeStartedAt) + challengeWait, "challenge active");

        delete deposits[depositID];
        outcomes[depositID] = Outcome.Refunded;
        _safeTransfer(record.token, record.owner, record.amount);
        if (challengePledge > 0) _safeTransferETH(record.owner, challengePledge);
        emit MercuryRefunded(depositID, record.owner, record.amount, challengePledge);
    }

    /// @notice Batch-confirms completed target transfers and removes the
    /// corresponding pending source deposits, as MERCURY Algorithm 1 does.
    function updateCheckpoint(
        bytes32 checkpointID,
        bytes32 targetTxRoot,
        bytes32[] calldata depositIDs,
        IMercuryTEERegistry.ClusterCertificate calldata cert
    ) external nonReentrant {
        require(checkpointID != bytes32(0), "bad checkpoint");
        require(!acceptedCheckpoints[checkpointID], "checkpoint replay");
        require(depositIDs.length > 0, "empty checkpoint");
        bytes32 idSetHash = keccak256(abi.encode(depositIDs));
        bytes32 expectedDigest = checkpointDigest(checkpointID, targetTxRoot, idSetHash);
        require(teeRegistry.verifyClusterCertificate(expectedDigest, cert), "bad tee cert");

        acceptedCheckpoints[checkpointID] = true;
        for (uint256 i = 0; i < depositIDs.length; i += 1) {
            bytes32 depositID = depositIDs[i];
            DepositRecord memory record = deposits[depositID];
            require(record.status == Status.Pending, "checkpoint deposit unavailable");
            delete deposits[depositID];
            outcomes[depositID] = Outcome.Completed;
            _safeTransfer(record.token, treasury, record.amount);
        }
        emit MercuryCheckpointUpdated(checkpointID, idSetHash, depositIDs.length);
    }

    function confirmationDigest(bytes32 depositID, bytes32 requestHash, bytes32 targetTxID)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode("MERCURY_CONFIRM_V1", block.chainid, address(this), depositID, requestHash, targetTxID)
        );
    }

    function checkpointDigest(bytes32 checkpointID, bytes32 targetTxRoot, bytes32 idSetHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode("MERCURY_CHECKPOINT_V1", block.chainid, address(this), checkpointID, targetTxRoot, idSetHash)
        );
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(IERC20Like.transferFrom.selector, from, to, amount)
        );
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "transferFrom failed");
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "transfer failed");
    }

    function _safeTransferETH(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pledge transfer failed");
    }
}
