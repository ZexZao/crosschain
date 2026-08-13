// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BusinessServiceContracts.sol";

contract TargetContract {
    struct CompactCall {
        uint16 opCode;
        bytes32 recordIdHash;
        bytes32 actorHash;
        address actorAddress;
        int256 amount;
        bytes32 metadataHash;
        bool requireAck;
    }

    struct CompactBusinessRecord {
        bytes32 requestID;
        uint16 opCode;
        bytes32 recordIdHash;
        bytes32 actorHash;
        address actorAddress;
        int256 amount;
        bytes32 metadataHash;
        bool requireAck;
        address service;
        bytes32 status;
        uint64 updatedAt;
    }

    event MessageExecuted(
        bytes32 indexed requestID,
        address indexed gateway,
        bytes32 payloadHash,
        uint256 executionCount
    );
    address public immutable gateway;
    CrossChainAssetService public immutable assetService;
    ReceivableRegistryService public immutable receivableService;
    LogisticsTrackerService public immutable logisticsService;
    ConsentRegistryService public immutable consentService;
    OracleFeedService public immutable oracleService;
    ApprovalWorkflowService public immutable approvalService;
    CrossChainToken public immutable token;
    bytes32 public lastRequestID;
    bytes32 public lastPayloadHash;
    uint256 public executionCount;
    mapping(bytes32 => CompactBusinessRecord) private compactBusinessRecords;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;
    mapping(bytes32 => uint256) public opExecutionCount;
    mapping(bytes32 => uint256) public assetAmountByRequest;
    mapping(bytes32 => address) public assetRecipientByRequest;

    event AssetBatchExecuted(bytes32 indexed batchExecutionHash, uint256 size);

    constructor(address gateway_, uint256 initialAssetReserveUnits) {
        gateway = gateway_;
        assetService = new CrossChainAssetService(address(this), initialAssetReserveUnits);
        receivableService = new ReceivableRegistryService(address(this));
        logisticsService = new LogisticsTrackerService(address(this));
        consentService = new ConsentRegistryService(address(this));
        oracleService = new OracleFeedService(address(this));
        approvalService = new ApprovalWorkflowService(address(this));
        token = assetService.token();
    }

    function executeCompact(bytes32 requestID, CompactCall calldata compact) external returns (bool) {
        require(msg.sender == gateway, "only gateway");
        bytes32 payloadHash = hashCompactCall(compact);

        lastRequestID = requestID;
        lastPayloadHash = payloadHash;
        executionCount += 1;
        _applyCompactBusinessAction(requestID, compact);
        emit MessageExecuted(requestID, msg.sender, payloadHash, executionCount);
        return true;
    }

    /// @notice 资产专用批量路径。Gateway 已逐条完成 h-xmsg、callDataHash、过期时间和防重放校验。
    /// @dev 只保留真实 token 状态变化与事件，不写通用 CompactBusinessRecord 和辅助索引。
    function executeAssetBatch(bytes32[] calldata requestIDs, CompactCall[] calldata calls) external returns (bool) {
        require(msg.sender == gateway, "only gateway");
        require(requestIDs.length > 0 && requestIDs.length == calls.length, "bad asset batch");
        bytes32 rollingHash;
        for (uint256 i = 0; i < calls.length; i += 1) {
            CompactCall calldata compact = calls[i];
            require(_isAssetOp(compact.opCode), "non-asset op");
            require(compact.actorAddress != address(0), "asset recipient must be evm address");
            require(compact.amount > 0, "bad asset amount");
            if (compact.opCode == 9) {
                assetService.transferSettlementCompact(
                    requestIDs[i],
                    compact.recordIdHash,
                    compact.actorAddress,
                    uint256(compact.amount)
                );
            } else {
                assetService.mintSettlementBatchItem(
                    requestIDs[i],
                    compact.recordIdHash,
                    compact.actorAddress,
                    uint256(compact.amount)
                );
            }
            rollingHash = keccak256(abi.encode(rollingHash, requestIDs[i], hashCompactCall(compact)));
        }
        executionCount += calls.length;
        emit AssetBatchExecuted(rollingHash, calls.length);
        return true;
    }

    function getCompactBusinessRecord(bytes32 requestID) external view returns (CompactBusinessRecord memory) {
        return compactBusinessRecords[requestID];
    }

    function hashCompactCall(CompactCall calldata compact) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                compact.opCode,
                compact.recordIdHash,
                compact.actorHash,
                compact.actorAddress,
                compact.amount,
                compact.metadataHash,
                compact.requireAck
            )
        );
    }

    function _applyCompactBusinessAction(bytes32 requestID, CompactCall calldata compact) internal {
        bytes32 opKey = bytes32(uint256(compact.opCode));
        bytes32 recordKey = _compactRecordKey(compact.opCode, compact.recordIdHash);
        (address service, bytes32 status) = _dispatchCompactBusinessService(requestID, compact);

        compactBusinessRecords[requestID] = CompactBusinessRecord({
            requestID: requestID,
            opCode: compact.opCode,
            recordIdHash: compact.recordIdHash,
            actorHash: compact.actorHash,
            actorAddress: compact.actorAddress,
            amount: compact.amount,
            metadataHash: compact.metadataHash,
            requireAck: compact.requireAck,
            service: service,
            status: status,
            updatedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[recordKey] = requestID;
        opExecutionCount[opKey] += 1;
    }

    function _dispatchCompactBusinessService(bytes32 requestID, CompactCall calldata compact)
        internal
        returns (address service, bytes32 status)
    {
        if (compact.opCode == 1 || compact.opCode == 2 || compact.opCode == 8) {
            require(compact.actorAddress != address(0), "asset recipient must be evm address");
            require(compact.amount > 0, "bad asset amount");
            status = assetService.mintSettlementCompact(
                requestID,
                compact.recordIdHash,
                compact.actorAddress,
                uint256(compact.amount),
                compact.metadataHash
            );
            assetAmountByRequest[requestID] = uint256(compact.amount);
            assetRecipientByRequest[requestID] = compact.actorAddress;
            return (address(assetService), status);
        }
        if (compact.opCode == 9) {
            require(compact.actorAddress != address(0), "asset recipient must be evm address");
            require(compact.amount > 0, "bad asset amount");
            status = assetService.transferSettlementCompact(
                requestID,
                compact.recordIdHash,
                compact.actorAddress,
                uint256(compact.amount)
            );
            return (address(assetService), status);
        }
        if (compact.opCode == 3) {
            require(compact.amount > 0, "zero amount");
            status = receivableService.attestReceivableCompact(
                requestID,
                compact.recordIdHash,
                compact.actorHash,
                uint256(compact.amount),
                compact.metadataHash
            );
            return (address(receivableService), status);
        }
        if (compact.opCode == 4) {
            status = logisticsService.syncLogisticsCompact(
                requestID,
                compact.recordIdHash,
                compact.actorHash,
                compact.amount,
                compact.metadataHash
            );
            return (address(logisticsService), status);
        }
        if (compact.opCode == 5) {
            require(compact.amount > 0, "zero duration");
            status = consentService.grantConsentCompact(
                requestID,
                compact.recordIdHash,
                compact.actorHash,
                uint256(compact.amount),
                compact.metadataHash
            );
            return (address(consentService), status);
        }
        if (compact.opCode == 6) {
            require(compact.amount >= 0, "bad oracle amount");
            status = oracleService.updateFeedCompact(
                requestID,
                compact.recordIdHash,
                compact.actorHash,
                uint256(compact.amount),
                compact.metadataHash
            );
            return (address(oracleService), status);
        }
        if (compact.opCode == 7) {
            require(compact.amount > 0, "zero threshold");
            status = approvalService.commitApprovalCompact(
                requestID,
                compact.recordIdHash,
                compact.actorHash,
                uint256(compact.amount),
                compact.metadataHash
            );
            return (address(approvalService), status);
        }
        revert("unsupported compact op");
    }

    function _isAssetOp(uint16 opCode) internal pure returns (bool) {
        return opCode == 1 || opCode == 2 || opCode == 8 || opCode == 9;
    }

    function _compactRecordKey(uint16 opCode, bytes32 recordIdHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(opCode, recordIdHash));
    }

}
