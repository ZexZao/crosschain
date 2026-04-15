// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EvmSourceContract {
    uint64 public nonce;

    event FabricCallRequested(
        uint64 indexed nonce,
        address indexed requester,
        string payloadJson
    );

    function requestFabricCall(string calldata payloadJson) external returns (uint64) {
        nonce += 1;
        emit FabricCallRequested(nonce, msg.sender, payloadJson);
        return nonce;
    }
}
