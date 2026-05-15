// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TEERegistry {
    address public owner;
    mapping(address => bool) public trustedTEE;

    event TEERegistered(address indexed tee);
    event TEERemoved(address indexed tee);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function registerTEE(address tee) external onlyOwner {
        trustedTEE[tee] = true;
        emit TEERegistered(tee);
    }

    function removeTEE(address tee) external onlyOwner {
        trustedTEE[tee] = false;
        emit TEERemoved(tee);
    }
}
