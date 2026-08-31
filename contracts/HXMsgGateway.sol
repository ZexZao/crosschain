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
    function executeAssetBatch(bytes32[] calldata requestIDs, CompactCall[] calldata calls) external returns (bool);
}

contract HXMsgGateway {
    using HXMsgLib for HXMsgLib.HXMsgMinimal;

    uint8 public constant ACTION_CONTRACT_CALL = 1;
    uint8 public constant MSG_TYPE_RESPONSE = 2;
    uint8 public constant MSG_TYPE_ACK = 3;
    uint8 public constant MSG_TYPE_CHALLENGE = 4;

    TEERegistry public immutable teeRegistry;
    uint8 public immutable localChainType;
    mapping(bytes32 => mapping(uint256 => uint256)) private replayBitmap;
    bytes32 public constant BATCH_DOMAIN = keccak256("HXMSG_BATCH_V1");
    bytes32 public constant TARGET_EXECUTION_DOMAIN_V1 = keccak256("HXMSG_TARGET_EXECUTION_DOMAIN_V1");
    bytes32 public constant TARGET_EXECUTION_HASH_V2 = keccak256("HXMSG_TARGET_EXECUTION_V2");
    bytes32 public immutable executionDomainID;

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
        bytes32 replayScope;
        uint64 sourceNonce;
        uint8 sourceChainType;
        bytes32 sourceChainID;
        bytes32 targetDomainID;
    }

    event HXMsgAccepted(
        bytes32 indexed requestID,
        bytes32 indexed clusterID,
        address indexed target,
        bytes32 hmsgDigest,
        bytes32 targetExecutionHash,
        bytes32 resultHash
    );
    event HXMsgBatchAccepted(bytes32 indexed batchID, bytes32 indexed batchRoot, uint256 size);
    event ReplayMarked(bytes32 indexed replayScope, uint64 indexed sourceNonce, bytes32 indexed requestID);

    constructor(address registry, uint8 chainType) {
        require(chainType == 1 || chainType == 3, "unsupported local chain type");
        teeRegistry = TEERegistry(registry);
        localChainType = chainType;
        executionDomainID = keccak256(abi.encode(
            TARGET_EXECUTION_DOMAIN_V1, chainType, bytes32(uint256(block.chainid)), address(this)
        ));
    }

    /// @notice 单条紧凑消息入口。使用强类型 CompactCall，避免把静态 tuple 错误封装为 bytes。
    function executeHXMsgMinimalCompactCluster(
        HXMsgLib.HXMsgMinimal calldata hxmsg,
        address target,
        CompactCall calldata call,
        HXMsgLib.ClusterCertificate calldata cert
    ) external {
        bytes32 deliveryDigest = hxmsg.hashDelivery();
        _validateMinimalCompact(hxmsg, target, call);
        _verifyClusterCert(deliveryDigest, hxmsg.sourceChainType, hxmsg.sourceChainID, cert);
        bytes32 resultHash = _executeCompactTarget(hxmsg, target, call);
        emit HXMsgAccepted(hxmsg.requestID, cert.clusterID, target, hxmsg.hmsgDigest,
            hxmsg.targetExecutionHash, resultHash);
    }

    /// @notice Executes a compact batch after recomputing its Merkle root on-chain.
    /// @dev Omitting per-message Merkle proofs reduces calldata while preserving the signed batch-root binding.
    function executeHXMsgMinimalCompactBatchCluster(
        HXMsgLib.HXMsgMinimal[] calldata hxmsgs,
        address target,
        CompactCall[] calldata calls,
        bytes32 batchID,
        bytes32 batchRoot,
        HXMsgLib.ClusterCertificate calldata batchCert
    ) external {
        require(hxmsgs.length > 0, "empty batch");
        require(hxmsgs.length == calls.length, "bad call count");
        require(_computeMinimalBatchRoot(hxmsgs) == batchRoot, "bad batch root");

        bytes32 batchDigest = hashBatchSigningDigest(batchID, batchRoot, uint64(hxmsgs.length), bytes32(uint256(block.chainid)));
        _verifyClusterCert(batchDigest, hxmsgs[0].sourceChainType, hxmsgs[0].sourceChainID, batchCert);

        for (uint256 i = 0; i < hxmsgs.length; i += 1) {
            require(hxmsgs[i].sourceChainType == hxmsgs[0].sourceChainType
                && hxmsgs[i].sourceChainID == hxmsgs[0].sourceChainID, "mixed source subnet batch");
            _validateMinimalCompact(hxmsgs[i], target, calls[i]);
        }
        if (_allAssetCalls(calls)) {
            bytes32 resultHash = _executeCompactAssetBatch(hxmsgs, target, calls);
            for (uint256 i = 0; i < hxmsgs.length; i += 1) {
                emit HXMsgAccepted(hxmsgs[i].requestID, batchCert.clusterID, target, hxmsgs[i].hmsgDigest,
                    hxmsgs[i].targetExecutionHash, resultHash);
            }
        } else {
            for (uint256 i = 0; i < hxmsgs.length; i += 1) {
                bytes32 resultHash = _executeCompactTarget(hxmsgs[i], target, calls[i]);
                emit HXMsgAccepted(hxmsgs[i].requestID, batchCert.clusterID, target, hxmsgs[i].hmsgDigest,
                    hxmsgs[i].targetExecutionHash, resultHash);
            }
        }
        emit HXMsgBatchAccepted(batchID, batchRoot, hxmsgs.length);
    }

    function executeFabricEVMCompactBatchCluster(
        FabricEVMCompactDelivery[] calldata deliveries,
        address target,
        CompactCall[] calldata calls,
        bytes32 batchID,
        bytes32 batchRoot,
        HXMsgLib.ClusterCertificate calldata batchCert
    ) external {
        require(deliveries.length > 0, "empty batch");
        require(deliveries.length == calls.length, "bad call count");

        bytes32 recomputedRoot = _computeFabricEVMCompactBatchRoot(deliveries, target);
        require(recomputedRoot == batchRoot, "bad batch root");
        bytes32 batchDigest = hashBatchSigningDigest(batchID, batchRoot, uint64(deliveries.length), bytes32(uint256(block.chainid)));
        _verifyClusterCert(batchDigest, deliveries[0].sourceChainType, deliveries[0].sourceChainID, batchCert);

        for (uint256 i = 0; i < deliveries.length; i += 1) {
            require(deliveries[i].sourceChainType == deliveries[0].sourceChainType
                && deliveries[i].sourceChainID == deliveries[0].sourceChainID, "mixed source subnet batch");
            _validateFabricEVMCompact(deliveries[i], target, calls[i]);
        }
        if (_allAssetCalls(calls)) {
            bytes32 resultHash = _executeCompactDeliveryAssetBatch(deliveries, target, calls);
            for (uint256 i = 0; i < deliveries.length; i += 1) {
                bytes32 targetExecutionHash = _targetExecutionHashForFabricDelivery(deliveries[i], target);
                emit HXMsgAccepted(deliveries[i].requestID, batchCert.clusterID, target, deliveries[i].hmsgDigest,
                    targetExecutionHash, resultHash);
            }
        } else {
            for (uint256 i = 0; i < deliveries.length; i += 1) {
                bytes32 resultHash = _executeCompactDelivery(deliveries[i], target, calls[i]);
                bytes32 targetExecutionHash = _targetExecutionHashForFabricDelivery(deliveries[i], target);
                emit HXMsgAccepted(deliveries[i].requestID, batchCert.clusterID, target, deliveries[i].hmsgDigest,
                    targetExecutionHash, resultHash);
            }
        }
        emit HXMsgBatchAccepted(batchID, batchRoot, deliveries.length);
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

    function _validateMinimalCompact(HXMsgLib.HXMsgMinimal calldata hxmsg, address target, CompactCall calldata call)
        internal
        view
    {
        require(hxmsg.sourceChainType != 0 && hxmsg.sourceChainID != bytes32(0), "missing source security domain");
        _requireNotProcessed(hxmsg.replayScope, hxmsg.sourceNonce);
        require(hxmsg.expireAt >= block.timestamp, "expired");
        require(hxmsg.targetChainType == localChainType, "wrong target chain type");
        require(hxmsg.targetChainID == bytes32(uint256(block.chainid)), "wrong target chain");
        require(hxmsg.targetDomainID == executionDomainID, "wrong target execution domain");
        require(hxmsg.actionType == ACTION_CONTRACT_CALL, "bad action");
        require(hxmsg.targetObject == bytes32(uint256(uint160(target))), "target mismatch");
        require(
            hxmsg.functionSelector == TargetContractExecuteCompactSelector.executeCompact.selector,
            "bad compact selector"
        );
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

        bytes32 targetExecutionHash = keccak256(abi.encode(
            TARGET_EXECUTION_HASH_V2,
            hxmsg.requestID,
            hxmsg.targetChainType,
            hxmsg.targetChainID,
            hxmsg.targetDomainID,
            hxmsg.targetObject,
            hxmsg.functionSelector,
            hxmsg.callDataHash,
            hxmsg.receiver
        ));
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
        require(delivery.sourceChainType != 0 && delivery.sourceChainID != bytes32(0), "missing source security domain");
        _requireNotProcessed(delivery.replayScope, delivery.sourceNonce);
        require(delivery.expireAt >= block.timestamp, "expired");
        require(delivery.targetDomainID == executionDomainID, "wrong target execution domain");
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
        bytes32 targetExecutionHash = _targetExecutionHashForFabricDelivery(delivery, target);
        bytes32 chainHash = keccak256(
            abi.encode(delivery.requestID, delivery.hmsgDigest, delivery.sourceChainType, delivery.sourceChainID,
                localChainType, targetChainID, delivery.targetDomainID, ACTION_CONTRACT_CALL)
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
        bytes32 replayHash = keccak256(abi.encode(delivery.replayScope, delivery.sourceNonce));
        return keccak256(abi.encode(chainHash, actionHash, feedbackHash, replayHash));
    }

    function _verifyClusterCert(
        bytes32 signingDigest,
        uint8 sourceChainType,
        bytes32 sourceChainID,
        HXMsgLib.ClusterCertificate calldata cert
    ) internal view {
        require(cert.sourceChainType == sourceChainType, "wrong source TEE subnet");
        require(cert.sourceChainID == sourceChainID, "wrong source chain certificate");
        require(teeRegistry.verifyClusterCertificate(signingDigest, TEERegistry.ClusterCertificate({
            clusterID: cert.clusterID,
            sourceChainType: cert.sourceChainType,
            sourceChainID: cert.sourceChainID,
            epoch: cert.epoch,
            threshold: cert.threshold,
            participantCount: cert.participantCount,
            signerBitmap: cert.signerBitmap,
            selectedSignerHash: cert.selectedSignerHash,
            signatures: cert.signatures,
            signingDigest: cert.signingDigest,
            subjectDigest: cert.subjectDigest,
            committedTerm: cert.committedTerm,
            committedIndex: cert.committedIndex
        })), "bad cluster cert");
    }

    function _targetExecutionHashForFabricDelivery(FabricEVMCompactDelivery calldata delivery, address target)
        internal view returns (bytes32)
    {
        bytes32 targetObject = bytes32(uint256(uint160(target)));
        return keccak256(abi.encode(
            TARGET_EXECUTION_HASH_V2,
            delivery.requestID,
            localChainType,
            bytes32(uint256(block.chainid)),
            delivery.targetDomainID,
            targetObject,
            TargetContractExecuteCompactSelector.executeCompact.selector,
            delivery.callDataHash,
            targetObject
        ));
    }

    function _executeCompactTarget(HXMsgLib.HXMsgMinimal calldata hxmsg, address target, CompactCall calldata call)
        internal returns (bytes32)
    {
        _markProcessed(hxmsg.replayScope, hxmsg.sourceNonce, hxmsg.requestID);
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
        return keccak256(ret);
    }

    function _executeCompactDelivery(
        FabricEVMCompactDelivery calldata delivery,
        address target,
        CompactCall calldata call
    ) internal returns (bytes32) {
        _markProcessed(delivery.replayScope, delivery.sourceNonce, delivery.requestID);
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
        return keccak256(ret);
    }

    function _allAssetCalls(CompactCall[] calldata calls) internal pure returns (bool) {
        for (uint256 i = 0; i < calls.length; i += 1) {
            uint16 opCode = calls[i].opCode;
            if (opCode != 1 && opCode != 2 && opCode != 8 && opCode != 9) return false;
        }
        return true;
    }

    function _executeCompactAssetBatch(
        HXMsgLib.HXMsgMinimal[] calldata hxmsgs,
        address target,
        CompactCall[] calldata calls
    ) internal returns (bytes32) {
        bytes32[] memory requestIDs = new bytes32[](hxmsgs.length);
        for (uint256 i = 0; i < hxmsgs.length; i += 1) {
            _markProcessed(hxmsgs[i].replayScope, hxmsgs[i].sourceNonce, hxmsgs[i].requestID);
            requestIDs[i] = hxmsgs[i].requestID;
        }
        (bool ok, bytes memory ret) = target.call(
            abi.encodeWithSelector(TargetContractExecuteCompactSelector.executeAssetBatch.selector, requestIDs, calls)
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("asset batch target call failed");
        }
        return keccak256(ret);
    }

    function _executeCompactDeliveryAssetBatch(
        FabricEVMCompactDelivery[] calldata deliveries,
        address target,
        CompactCall[] calldata calls
    ) internal returns (bytes32) {
        bytes32[] memory requestIDs = new bytes32[](deliveries.length);
        for (uint256 i = 0; i < deliveries.length; i += 1) {
            _markProcessed(deliveries[i].replayScope, deliveries[i].sourceNonce, deliveries[i].requestID);
            requestIDs[i] = deliveries[i].requestID;
        }
        (bool ok, bytes memory ret) = target.call(
            abi.encodeWithSelector(TargetContractExecuteCompactSelector.executeAssetBatch.selector, requestIDs, calls)
        );
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("asset batch target call failed");
        }
        return keccak256(ret);
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

    function _computeMinimalBatchRoot(HXMsgLib.HXMsgMinimal[] calldata hxmsgs) internal pure returns (bytes32) {
        bytes32[] memory level = new bytes32[](hxmsgs.length);
        for (uint256 i = 0; i < hxmsgs.length; i += 1) {
            level[i] = keccak256(abi.encode(hxmsgs[i].requestID, hxmsgs[i].hmsgDigest, hxmsgs[i].hashDelivery()));
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

    function isProcessed(bytes32 replayScope, uint64 sourceNonce) external view returns (bool) {
        (uint256 wordIndex, uint256 mask) = _replayPosition(sourceNonce);
        return replayBitmap[replayScope][wordIndex] & mask != 0;
    }

    function _requireNotProcessed(bytes32 replayScope, uint64 sourceNonce) internal view {
        require(replayScope != bytes32(0), "bad replay scope");
        require(sourceNonce > 0, "bad source nonce");
        (uint256 wordIndex, uint256 mask) = _replayPosition(sourceNonce);
        require(replayBitmap[replayScope][wordIndex] & mask == 0, "already processed");
    }

    function _markProcessed(bytes32 replayScope, uint64 sourceNonce, bytes32 requestID) internal {
        (uint256 wordIndex, uint256 mask) = _replayPosition(sourceNonce);
        replayBitmap[replayScope][wordIndex] |= mask;
        emit ReplayMarked(replayScope, sourceNonce, requestID);
    }

    function _replayPosition(uint64 sourceNonce) internal pure returns (uint256 wordIndex, uint256 mask) {
        uint256 lane = uint256(sourceNonce) & 15;
        uint256 ordinal = uint256(sourceNonce) >> 4;
        wordIndex = (lane << 60) | (ordinal >> 8);
        mask = uint256(1) << (ordinal & 255);
    }

}
