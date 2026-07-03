// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Avalanche WarpMessenger 预编译接口。
/// @dev 预编译地址固定为 0x0200000000000000000000000000000000000005。
interface IWarpMessenger {
    event SendWarpMessage(address indexed sender, bytes32 indexed messageID, bytes message);

    function sendWarpMessage(bytes calldata payload) external returns (bytes32 messageID);
    function getBlockchainID() external view returns (bytes32 blockchainID);
}

/// @notice Avalanche 作为源链时的 h-xmsg 请求合约。
/// @dev 合约只负责把业务绑定 payload 写入官方 Warp message。
///      交易存在性与 payload 未篡改性由 Avalanche ICM/Warp 权重签名证明提供。
contract AvalancheWarpSourceContract {
    IWarpMessenger public constant WARP_MESSENGER =
        IWarpMessenger(0x0200000000000000000000000000000000000005);

    struct WarpHXMsgRequest {
        bytes32 targetChainID;
        bytes32 targetDomainID;
        bytes32 targetObject;
        bytes4 functionSelector;
        bytes32 callDataHash;
        bytes32 businessPayloadHash;
        bytes32 receiver;
        uint64 nonce;
        uint64 expireAt;
        bytes32 policyHash;
        bytes callData;
    }

    uint64 public nonce;
    mapping(bytes32 => bytes32) public requestToWarpMessage;

    event AvalancheHXMsgWarpRequested(
        bytes32 indexed requestID,
        bytes32 indexed warpMessageID,
        address indexed sender,
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 nonce,
        uint64 expireAt,
        bytes32 policyHash
    );

    function submitWarpHXMsgRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes calldata callData,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt,
        bytes32 policyHash
    ) external returns (bytes32 requestID, bytes32 warpMessageID) {
        require(expireAt > block.timestamp, "expired");
        uint64 currentNonce = ++nonce;
        bytes32 callDataHash = keccak256(callData);

        requestID = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                targetChainID,
                targetDomainID,
                targetObject,
                functionSelector,
                callDataHash,
                businessPayloadHash,
                receiver,
                currentNonce,
                expireAt,
                policyHash
            )
        );

        bytes memory payload = abi.encode(
            WarpHXMsgRequest({
                targetChainID: targetChainID,
                targetDomainID: targetDomainID,
                targetObject: targetObject,
                functionSelector: functionSelector,
                callDataHash: callDataHash,
                businessPayloadHash: businessPayloadHash,
                receiver: receiver,
                nonce: currentNonce,
                expireAt: expireAt,
                policyHash: policyHash,
                callData: callData
            })
        );

        warpMessageID = WARP_MESSENGER.sendWarpMessage(payload);
        requestToWarpMessage[requestID] = warpMessageID;

        emit AvalancheHXMsgWarpRequested(
            requestID,
            warpMessageID,
            msg.sender,
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            currentNonce,
            expireAt,
            policyHash
        );
    }

    function getAvalancheBlockchainID() external view returns (bytes32) {
        return WARP_MESSENGER.getBlockchainID();
    }
}
