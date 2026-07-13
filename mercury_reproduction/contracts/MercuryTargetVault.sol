// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MercuryVault.sol";

/// @notice EVM target-chain realization of MERCURY's batched TRANSFER.
/// The EOS contract uses the same batch/item digest semantics.
contract MercuryTargetVault {
    struct TransferInstruction {
        bytes32 depositID;
        address token;
        address receiver;
        uint256 amount;
    }

    IMercuryTEERegistry public immutable teeRegistry;
    mapping(bytes32 => bool) public executedBatches;
    mapping(bytes32 => bool) public executedDeposits;
    uint256 private locked;

    event MercuryBatchExecuted(bytes32 indexed batchID, bytes32 indexed transferSetHash, uint256 transferCount);
    event MercuryTargetTransfer(
        bytes32 indexed batchID,
        bytes32 indexed depositID,
        address indexed receiver,
        address token,
        uint256 amount
    );

    modifier nonReentrant() {
        require(locked == 0, "reentrant");
        locked = 1;
        _;
        locked = 0;
    }

    constructor(address registry) {
        require(registry != address(0), "bad registry");
        teeRegistry = IMercuryTEERegistry(registry);
    }

    function executeBatch(
        bytes32 batchID,
        TransferInstruction[] calldata transfers,
        IMercuryTEERegistry.ClusterCertificate calldata cert
    ) external nonReentrant {
        require(batchID != bytes32(0), "bad batch");
        require(!executedBatches[batchID], "batch replay");
        require(transfers.length > 0, "empty batch");
        bytes32 transferSetHash = keccak256(abi.encode(transfers));
        bytes32 expectedDigest = batchDigest(batchID, transferSetHash);
        require(teeRegistry.verifyClusterCertificate(expectedDigest, cert), "bad tee cert");

        executedBatches[batchID] = true;
        for (uint256 i = 0; i < transfers.length; i += 1) {
            TransferInstruction calldata item = transfers[i];
            require(!executedDeposits[item.depositID], "deposit replay");
            require(item.token != address(0) && item.receiver != address(0) && item.amount > 0, "bad transfer");
            executedDeposits[item.depositID] = true;
            _safeTransfer(item.token, item.receiver, item.amount);
            emit MercuryTargetTransfer(batchID, item.depositID, item.receiver, item.token, item.amount);
        }
        emit MercuryBatchExecuted(batchID, transferSetHash, transfers.length);
    }

    function batchDigest(bytes32 batchID, bytes32 transferSetHash) public view returns (bytes32) {
        return keccak256(
            abi.encode("MERCURY_TRANSFER_BATCH_V1", block.chainid, address(this), batchID, transferSetHash)
        );
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeWithSelector(IERC20Like.transfer.selector, to, amount));
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "transfer failed");
    }
}
