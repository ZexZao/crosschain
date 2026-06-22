// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./HXMsgLib.sol";
import "./TEERegistry.sol";

interface TargetContractExecuteCompactSelector {
    struct CompactCall {
        uint16 opCode;
        bytes32 recordIdHash;
        bytes32 actorHash;
        address actorAddress;
        int256 amount;
        bytes32 metadataHash;
        bool requireAck;
    }

    function executeCompact(bytes32 requestID, CompactCall calldata compact) external returns (bool);
}

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
    bytes32 public constant BATCH_DOMAIN = keccak256("HXMSG_BATCH_V1");

    struct CompactCall {
        uint16 opCode;
        bytes32 recordIdHash;
        bytes32 actorHash;
        address actorAddress;
        int256 amount;
        bytes32 metadataHash;
        bool requireAck;
    }

    struct FabricEVMCompactDelivery {
        bytes32 requestID;
        bytes32 hmsgDigest;
        bytes32 callDataHash;
        uint64 expireAt;
    }

    event HXMsgAccepted(bytes32 indexed requestID, address indexed tee, address indexed target);
    event HXMsgBatchAccepted(bytes32 indexed batchID, bytes32 indexed batchRoot, uint256 size);
    event HXMsgRejected(bytes32 indexed requestID, string reason);

    constructor(address registry) {
        teeRegistry = TEERegistry(registry);
    }

    function executeHXMsgMinimalCluster(
        HXMsgLib.HXMsgMinimal calldata hxmsg,
        address target,
        bytes calldata callData,
        HXMsgLib.TEECertification[] calldata certs
    ) external {
        bytes32 deliveryDigest = hxmsg.hashDelivery();
        _validateMinimal(hxmsg, target, callData);
        _verifyCerts(hxmsg.requestID, hxmsg.hmsgDigest, deliveryDigest, certs);

        _executeTarget(hxmsg, target, callData);
        emit HXMsgAccepted(hxmsg.requestID, certs[0].teeAddress, target);
    }

    function executeHXMsgMinimalBatchCluster(
        HXMsgLib.HXMsgMinimal[] calldata hxmsgs,
        address target,
        bytes[] calldata callDatas,
        bytes32 batchID,
        bytes32 batchRoot,
        bytes32[][] calldata merkleProofs,
        HXMsgLib.TEECertification[] calldata batchCerts
    ) external {
        require(hxmsgs.length > 0, "empty batch");
        require(hxmsgs.length == callDatas.length, "bad calldata count");
        require(hxmsgs.length == merkleProofs.length, "bad proof count");

        bytes32 batchDigest = hashBatchSigningDigest(batchID, batchRoot, uint64(hxmsgs.length), bytes32(uint256(block.chainid)));
        _verifyCerts(batchID, batchDigest, batchDigest, batchCerts);

        for (uint256 i = 0; i < hxmsgs.length; i += 1) {
            _validateMinimal(hxmsgs[i], target, callDatas[i]);
            bytes32 leaf = hashBatchLeaf(hxmsgs[i]);
            require(_verifyMerkleProof(leaf, merkleProofs[i], batchRoot), "bad batch proof");
            _executeTarget(hxmsgs[i], target, callDatas[i]);
            emit HXMsgAccepted(hxmsgs[i].requestID, batchCerts[0].teeAddress, target);
        }
        emit HXMsgBatchAccepted(batchID, batchRoot, hxmsgs.length);
    }

    function executeHXMsgMinimalCompactBatchCluster(
        HXMsgLib.HXMsgMinimal[] calldata hxmsgs,
        address target,
        CompactCall[] calldata calls,
        bytes32 batchID,
        bytes32 batchRoot,
        bytes32[][] calldata merkleProofs,
        HXMsgLib.TEECertification[] calldata batchCerts
    ) external {
        require(hxmsgs.length > 0, "empty batch");
        require(hxmsgs.length == calls.length, "bad call count");
        require(hxmsgs.length == merkleProofs.length, "bad proof count");

        bytes32 batchDigest = hashBatchSigningDigest(batchID, batchRoot, uint64(hxmsgs.length), bytes32(uint256(block.chainid)));
        _verifyCerts(batchID, batchDigest, batchDigest, batchCerts);

        for (uint256 i = 0; i < hxmsgs.length; i += 1) {
            _validateMinimalCompact(hxmsgs[i], target, calls[i]);
            bytes32 leaf = hashBatchLeaf(hxmsgs[i]);
            require(_verifyMerkleProof(leaf, merkleProofs[i], batchRoot), "bad batch proof");
            _executeCompactTarget(hxmsgs[i], target, calls[i]);
            emit HXMsgAccepted(hxmsgs[i].requestID, batchCerts[0].teeAddress, target);
        }
        emit HXMsgBatchAccepted(batchID, batchRoot, hxmsgs.length);
    }

    function executeFabricEVMCompactBatchCluster(
        FabricEVMCompactDelivery[] calldata deliveries,
        address target,
        CompactCall[] calldata calls,
        bytes32 batchID,
        bytes32 batchRoot,
        bytes32[][] calldata merkleProofs,
        HXMsgLib.TEECertification[] calldata batchCerts
    ) external {
        require(deliveries.length > 0, "empty batch");
        require(deliveries.length == calls.length, "bad call count");
        require(deliveries.length == merkleProofs.length, "bad proof count");

        bytes32 batchDigest = hashBatchSigningDigest(batchID, batchRoot, uint64(deliveries.length), bytes32(uint256(block.chainid)));
        _verifyCerts(batchID, batchDigest, batchDigest, batchCerts);

        for (uint256 i = 0; i < deliveries.length; i += 1) {
            _validateFabricEVMCompact(deliveries[i], target, calls[i]);
            bytes32 leaf = hashFabricEVMCompactBatchLeaf(deliveries[i], target);
            require(_verifyMerkleProof(leaf, merkleProofs[i], batchRoot), "bad batch proof");
            _executeCompactDelivery(deliveries[i], target, calls[i]);
            emit HXMsgAccepted(deliveries[i].requestID, batchCerts[0].teeAddress, target);
        }
        emit HXMsgBatchAccepted(batchID, batchRoot, deliveries.length);
    }

    function executeFabricEVMCompactBatchCluster(
        FabricEVMCompactDelivery[] calldata deliveries,
        address target,
        CompactCall[] calldata calls,
        bytes32 batchID,
        bytes32 batchRoot,
        HXMsgLib.TEECertification[] calldata batchCerts
    ) external {
        require(deliveries.length > 0, "empty batch");
        require(deliveries.length == calls.length, "bad call count");

        bytes32 recomputedRoot = _computeFabricEVMCompactBatchRoot(deliveries, target);
        require(recomputedRoot == batchRoot, "bad batch root");
        bytes32 batchDigest = hashBatchSigningDigest(batchID, batchRoot, uint64(deliveries.length), bytes32(uint256(block.chainid)));
        _verifyCerts(batchID, batchDigest, batchDigest, batchCerts);

        for (uint256 i = 0; i < deliveries.length; i += 1) {
            _validateFabricEVMCompact(deliveries[i], target, calls[i]);
            _executeCompactDelivery(deliveries[i], target, calls[i]);
            emit HXMsgAccepted(deliveries[i].requestID, batchCerts[0].teeAddress, target);
        }
        emit HXMsgBatchAccepted(batchID, batchRoot, deliveries.length);
    }

    function hashBatchLeaf(HXMsgLib.HXMsgMinimal calldata hxmsg) public pure returns (bytes32) {
        return keccak256(abi.encode(hxmsg.requestID, hxmsg.hmsgDigest, hxmsg.hashDelivery()));
    }

    function hashBatchSigningDigest(bytes32 batchID, bytes32 batchRoot, uint64 batchSize, bytes32 targetChainID)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(BATCH_DOMAIN, batchID, batchRoot, batchSize, targetChainID));
    }

    function hashFabricEVMCompactBatchLeaf(FabricEVMCompactDelivery calldata delivery, address target)
        public
        view
        returns (bytes32)
    {
        bytes32 deliveryDigest = _hashFabricEVMCompactDelivery(delivery, target);
        return keccak256(abi.encode(delivery.requestID, delivery.hmsgDigest, deliveryDigest));
    }

    function _validateMinimal(HXMsgLib.HXMsgMinimal calldata hxmsg, address target, bytes calldata callData) internal view {
        require(!processed[hxmsg.requestID], "already processed");
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
    }

    function _validateMinimalCompact(HXMsgLib.HXMsgMinimal calldata hxmsg, address target, CompactCall calldata call)
        internal
        view
    {
        require(!processed[hxmsg.requestID], "already processed");
        require(hxmsg.expireAt >= block.timestamp, "expired");
        require(hxmsg.targetChainType == CHAIN_TYPE_EVM, "target not evm");
        require(hxmsg.targetChainID == bytes32(uint256(block.chainid)), "wrong target chain");
        require(hxmsg.actionType == ACTION_CONTRACT_CALL, "bad action");
        require(hxmsg.targetObject == bytes32(uint256(uint160(target))), "target mismatch");
        require(hashCompactCall(call) == hxmsg.callDataHash, "bad compact call hash");
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
    }

    function hashCompactCall(CompactCall calldata call) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                call.opCode,
                call.recordIdHash,
                call.actorHash,
                call.actorAddress,
                call.amount,
                call.metadataHash,
                call.requireAck
            )
        );
    }

    function _validateFabricEVMCompact(
        FabricEVMCompactDelivery calldata delivery,
        address target,
        CompactCall calldata call
    ) internal view {
        require(!processed[delivery.requestID], "already processed");
        require(delivery.expireAt >= block.timestamp, "expired");
        require(hashCompactCall(call) == delivery.callDataHash, "bad compact call hash");
        require(target != address(0), "bad target");
    }

    function _hashFabricEVMCompactDelivery(FabricEVMCompactDelivery calldata delivery, address target)
        internal
        view
        returns (bytes32)
    {
        bytes32 targetObject = bytes32(uint256(uint160(target)));
        bytes32 targetChainID = bytes32(uint256(block.chainid));
        bytes32 targetExecutionHash = keccak256(
            abi.encode(
                delivery.requestID,
                targetChainID,
                targetObject,
                TargetContractExecuteCompactSelector.executeCompact.selector,
                delivery.callDataHash,
                targetObject
            )
        );
        bytes32 chainHash = keccak256(
            abi.encode(delivery.requestID, delivery.hmsgDigest, CHAIN_TYPE_EVM, targetChainID, ACTION_CONTRACT_CALL)
        );
        bytes32 actionHash = keccak256(
            abi.encode(
                targetObject,
                TargetContractExecuteCompactSelector.executeCompact.selector,
                delivery.callDataHash,
                targetObject,
                targetExecutionHash
            )
        );
        bytes32 feedbackHash = keccak256(abi.encode(false, uint8(0), uint64(0), bytes32(0), delivery.expireAt));
        return keccak256(abi.encode(chainHash, actionHash, feedbackHash));
    }

    function _verifyCerts(
        bytes32 expectedRequestID,
        bytes32 expectedDigest,
        bytes32 signingDigest,
        HXMsgLib.TEECertification[] calldata certs
    ) internal view {
        uint256 threshold = teeRegistry.quorumThreshold();
        require(threshold > 0, "bad threshold");
        require(certs.length >= threshold, "not enough certs");
        uint256 validCount = 0;
        for (uint256 i = 0; i < certs.length; i += 1) {
            require(certs[i].requestID == expectedRequestID, "cert request mismatch");
            require(certs[i].hmsgDigest == expectedDigest, "cert digest mismatch");
            address signer = _recover(signingDigest, certs[i].signature);
            require(signer == certs[i].teeAddress, "bad tee signature");
            require(teeRegistry.trustedTEE(signer), "untrusted tee");
            for (uint256 j = 0; j < i; j += 1) {
                require(certs[j].teeAddress != signer, "duplicate tee");
            }
            validCount += 1;
        }
        require(validCount >= threshold, "tee quorum not reached");
    }

    function _executeTarget(HXMsgLib.HXMsgMinimal calldata hxmsg, address target, bytes calldata callData) internal {
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
    }

    function _executeCompactTarget(HXMsgLib.HXMsgMinimal calldata hxmsg, address target, CompactCall calldata call)
        internal
    {
        processed[hxmsg.requestID] = true;
        (bool ok, bytes memory ret) = target.call(
            abi.encodeWithSelector(hxmsg.functionSelector, hxmsg.requestID, call)
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("target call failed");
        }
    }

    function _executeCompactDelivery(
        FabricEVMCompactDelivery calldata delivery,
        address target,
        CompactCall calldata call
    ) internal {
        processed[delivery.requestID] = true;
        (bool ok, bytes memory ret) = target.call(
            abi.encodeWithSelector(TargetContractExecuteCompactSelector.executeCompact.selector, delivery.requestID, call)
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("target call failed");
        }
    }

    function _verifyMerkleProof(bytes32 leaf, bytes32[] calldata proof, bytes32 expectedRoot) internal pure returns (bool) {
        bytes32 value = leaf;
        for (uint256 i = 0; i < proof.length; i += 1) {
            value = _hashPair(value, proof[i]);
        }
        return value == expectedRoot;
    }

    function _computeFabricEVMCompactBatchRoot(
        FabricEVMCompactDelivery[] calldata deliveries,
        address target
    ) internal view returns (bytes32) {
        bytes32[] memory level = new bytes32[](deliveries.length);
        for (uint256 i = 0; i < deliveries.length; i += 1) {
            level[i] = hashFabricEVMCompactBatchLeaf(deliveries[i], target);
        }
        uint256 size = level.length;
        while (size > 1) {
            uint256 nextSize = (size + 1) / 2;
            for (uint256 i = 0; i < nextSize; i += 1) {
                uint256 leftIndex = i * 2;
                uint256 rightIndex = leftIndex + 1;
                bytes32 right = rightIndex < size ? level[rightIndex] : level[leftIndex];
                level[i] = _hashPair(level[leftIndex], right);
            }
            size = nextSize;
        }
        return level[0];
    }

    function _hashPair(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return left <= right ? keccak256(abi.encode(left, right)) : keccak256(abi.encode(right, left));
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
