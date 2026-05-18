// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TargetContract {
    event MessageExecuted(
        bytes32 indexed requestID,
        address indexed gateway,
        bytes32 payloadHash,
        uint256 executionCount
    );

    address public immutable gateway;
    bytes32 public lastRequestID;
    bytes32 public lastPayloadHash;
    uint256 public executionCount;

    constructor(address gateway_) {
        gateway = gateway_;
    }

    function execute(bytes32 requestID, bytes calldata payload) external returns (bool) {
        require(msg.sender == gateway, "only gateway");
        bytes32 payloadHash = keccak256(payload);

        lastRequestID = requestID;
        lastPayloadHash = payloadHash;
        executionCount += 1;
        emit MessageExecuted(requestID, msg.sender, payloadHash, executionCount);
        return true;
    }
}
