// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TEERegistry {
    address public owner;
    mapping(address => bool) public trustedTEE;
    uint256 public trustedTEECount;
    uint64 public teeEpoch = 1;

    event TEERegistered(address indexed tee);
    event TEERemoved(address indexed tee);
    event TEEEpochAdvanced(uint64 indexed epoch);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerTEE(address tee) external onlyOwner {
        if (!trustedTEE[tee]) {
            trustedTEECount += 1;
        }
        trustedTEE[tee] = true;
        emit TEERegistered(tee);
    }

    function removeTEE(address tee) external onlyOwner {
        if (trustedTEE[tee]) {
            trustedTEECount -= 1;
        }
        trustedTEE[tee] = false;
        emit TEERemoved(tee);
    }

    function quorumThreshold() external view returns (uint256) {
        require(trustedTEECount > 0, "empty tee cluster");
        return (trustedTEECount / 2) + 1;
    }

    function advanceEpoch() external onlyOwner {
        teeEpoch += 1;
        emit TEEEpochAdvanced(teeEpoch);
    }
}
