// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./TEERegistry.sol";

contract HXMsgGateway {
    using HXMsgLib for HXMsgLib.HXMsgOnChain;
    using HXMsgLib for HXMsgLib.HXMsgMinimal;

    uint8 public constant CHAIN_TYPE_EVM = 1;
    uint8 public constant ACTION_CONTRACT_CALL = 1;
    uint8 public constant MSG_TYPE_RESPONSE = 2;
    uint8 public constant MSG_TYPE_ACK = 3;
    uint8 public constant MSG_TYPE_CHALLENGE = 4;

    TEERegistry public immutable teeRegistry;
    mapping(bytes32 => bool) public processed;

    event HXMsgAccepted(bytes32 indexed requestID, address indexed tee, address indexed target);
    event HXMsgRejected(bytes32 indexed requestID, string reason);

    constructor(address registry) {
        teeRegistry = TEERegistry(registry);
    }

    function executeHXMsgMinimalCluster(
        HXMsgLib.HXMsgMinimal calldata hxmsg,
        address target,
        bytes calldata callData,
        HXMsgLib.TEECertification[] calldata certs,
        uint256 threshold
    ) external {
        require(!processed[hxmsg.requestID], "already processed");
        require(threshold > 0, "bad threshold");
        require(certs.length >= threshold, "not enough certs");
        require(hxmsg.expireAt >= block.timestamp, "expired");
        require(hxmsg.targetChainType == CHAIN_TYPE_EVM, "target not evm");
        require(hxmsg.targetChainID == bytes32(uint256(block.chainid)), "wrong target chain");
        require(hxmsg.actionType == ACTION_CONTRACT_CALL, "bad action");
        require(hxmsg.targetObject == bytes32(uint256(uint160(target))), "target mismatch");
        require(keccak256(callData) == hxmsg.callDataHash, "bad calldata hash");
        if (hxmsg.feedbackRequired) {
            require(
                hxmsg.expectedFeedbackMsgType == MSG_TYPE_RESPONSE ||
                    hxmsg.expectedFeedbackMsgType == MSG_TYPE_ACK ||
                    hxmsg.expectedFeedbackMsgType == MSG_TYPE_CHALLENGE,
                "bad feedback type"
            );
            require(hxmsg.feedbackTimeout == 0 || hxmsg.feedbackTimeout >= block.timestamp, "feedback expired");
        } else {
            require(hxmsg.expectedFeedbackMsgType == 0, "unexpected feedback type");
            require(hxmsg.feedbackTimeout == 0, "unexpected feedback timeout");
            require(hxmsg.callbackRefHash == bytes32(0), "unexpected callback ref");
        }

        bytes32 targetExecutionHash = keccak256(
            abi.encode(
                hxmsg.requestID,
                hxmsg.targetChainID,
                hxmsg.targetObject,
                hxmsg.functionSelector,
                hxmsg.callDataHash,
                hxmsg.receiver
            )
        );
        require(targetExecutionHash == hxmsg.targetExecutionHash, "bad target execution hash");

        bytes32 deliveryDigest = hxmsg.hashDelivery();
        uint256 validCount = 0;
        for (uint256 i = 0; i < certs.length; i += 1) {
            require(certs[i].requestID == hxmsg.requestID, "cert request mismatch");
            require(certs[i].hmsgDigest == hxmsg.hmsgDigest, "cert digest mismatch");
            address signer = _recover(deliveryDigest, certs[i].signature);
            require(signer == certs[i].teeAddress, "bad tee signature");
            require(teeRegistry.trustedTEE(signer), "untrusted tee");
            for (uint256 j = 0; j < i; j += 1) {
                require(certs[j].teeAddress != signer, "duplicate tee");
            }
            validCount += 1;
        }
        require(validCount >= threshold, "tee quorum not reached");

        processed[hxmsg.requestID] = true;
        (bool ok, bytes memory ret) = target.call(
            abi.encodeWithSelector(hxmsg.functionSelector, hxmsg.requestID, callData)
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("target call failed");
        }
        emit HXMsgAccepted(hxmsg.requestID, certs[0].teeAddress, target);
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
