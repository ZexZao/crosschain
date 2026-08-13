// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./CrossChainToken.sol";

/// @notice 目标链业务服务的基础合约。
/// @dev 只有 TargetContract 可以调用这些服务。这样可以把 h-xmsg 网关验证集中在
/// 路由合约中，同时让每个具体业务动作合约保持独立、可测试。
abstract contract RoutedService {
    address public immutable router;

    modifier onlyRouter() {
        require(msg.sender == router, "only router");
        _;
    }

    constructor(address router_) {
        require(router_ != address(0), "bad router");
        router = router_;
    }
}

/// @notice 跨链资产消息的结算服务。
/// @dev 该服务会通过 mint XCST 真实改变接收方的 ERC20 余额。它用于源链事实已被
/// TEE quorum 验证、且目标链网关接受后的资产结算类操作。
contract CrossChainAssetService is RoutedService {
    struct Settlement {
        bytes32 requestID;
        string recordId;
        address recipient;
        uint256 amountUnits;
        bytes32 reasonHash;
        uint64 settledAt;
    }

    CrossChainToken public immutable token;
    mapping(bytes32 => Settlement) public settlements;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event AssetSettled(
        bytes32 indexed requestID,
        bytes32 indexed recordKey,
        address indexed recipient,
        uint256 amountUnits
    );

    event AssetTransferred(
        bytes32 indexed requestID,
        bytes32 indexed recordKey,
        address indexed recipient,
        uint256 amountUnits
    );

    constructor(address router_, uint256 initialReserveUnits) RoutedService(router_) {
        token = new CrossChainToken("CrossChain Settlement Token", "XCST", 4, address(this));
        if (initialReserveUnits > 0) {
            token.mint(address(this), initialReserveUnits);
        }
    }

    /// @notice 紧凑跨链调用版本：链上只接收业务记录哈希，完整业务内容由 TEE 签名的
    /// metadata/business payload 哈希承诺绑定。
    function mintSettlementCompact(
        bytes32 requestID,
        bytes32 recordKey,
        address recipient,
        uint256 amountUnits,
        bytes32 reasonHash
    ) external onlyRouter returns (bytes32) {
        require(recipient != address(0), "bad recipient");
        require(amountUnits > 0, "zero amount");
        settlements[requestID] = Settlement({
            requestID: requestID,
            recordId: "",
            recipient: recipient,
            amountUnits: amountUnits,
            reasonHash: reasonHash,
            settledAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[recordKey] = requestID;
        token.mint(recipient, amountUnits);
        emit AssetSettled(requestID, recordKey, recipient, amountUnits);
        return keccak256(bytes("ASSET_SETTLED"));
    }

    /// @notice 批量快速路径中的真实铸造结算。审计事实由事件保存，不重复写 Settlement 映射。
    function mintSettlementBatchItem(
        bytes32 requestID,
        bytes32 recordKey,
        address recipient,
        uint256 amountUnits
    ) external onlyRouter returns (bytes32) {
        require(recipient != address(0), "bad recipient");
        require(amountUnits > 0, "zero amount");
        token.mint(recipient, amountUnits);
        emit AssetSettled(requestID, recordKey, recipient, amountUnits);
        return keccak256(bytes("ASSET_SETTLED"));
    }

    /// @notice 从目标链流动性储备向接收方真实转账，而不是用 mint 近似 token_transfer。
    function transferSettlementCompact(
        bytes32 requestID,
        bytes32 recordKey,
        address recipient,
        uint256 amountUnits
    ) external onlyRouter returns (bytes32) {
        require(recipient != address(0), "bad recipient");
        require(amountUnits > 0, "zero amount");
        require(token.transfer(recipient, amountUnits), "reserve transfer failed");
        emit AssetTransferred(requestID, recordKey, recipient, amountUnits);
        return keccak256(bytes("TOKEN_TRANSFERRED"));
    }
}

/// @notice 应收账款证明服务。
/// @dev 该动作会真实更新链上登记表：把 receivableId 与供应商、金额、metadataHash
/// 绑定，便于后续合约或审计方通过 requestID 或 recordKey 消费该证明。
contract ReceivableRegistryService is RoutedService {
    struct CompactReceivable {
        bytes32 requestID;
        bytes32 receivableIdHash;
        bytes32 supplierHash;
        uint256 amountUnits;
        bytes32 metadataHash;
        bool attested;
        uint64 attestedAt;
    }

    mapping(bytes32 => CompactReceivable) public compactReceivables;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event CompactReceivableAttested(
        bytes32 indexed requestID,
        bytes32 indexed receivableIdHash,
        bytes32 indexed supplierHash,
        uint256 amountUnits
    );

    constructor(address router_) RoutedService(router_) {}

    /// @notice 使用 h-xmsg 已绑定的哈希字段登记真实的紧凑应收账款状态。
    function attestReceivableCompact(
        bytes32 requestID,
        bytes32 receivableIdHash,
        bytes32 supplierHash,
        uint256 amountUnits,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        require(receivableIdHash != bytes32(0), "bad receivable id");
        require(supplierHash != bytes32(0), "bad supplier");
        require(amountUnits > 0, "zero amount");
        compactReceivables[requestID] = CompactReceivable({
            requestID: requestID,
            receivableIdHash: receivableIdHash,
            supplierHash: supplierHash,
            amountUnits: amountUnits,
            metadataHash: metadataHash,
            attested: true,
            attestedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[receivableIdHash] = requestID;
        emit CompactReceivableAttested(requestID, receivableIdHash, supplierHash, amountUnits);
        return keccak256(bytes("RECEIVABLE_ATTESTED"));
    }
}

/// @notice 物流状态同步服务。
/// @dev 存储跨链同步过来的最新 waybill 读数。负数会在路由器中转换为有符号定点单位。
contract LogisticsTrackerService is RoutedService {
    struct CompactWaybillState {
        bytes32 requestID;
        bytes32 waybillIdHash;
        bytes32 inspectorHash;
        int256 readingUnits;
        bytes32 metadataHash;
        uint64 updatedAt;
    }

    mapping(bytes32 => CompactWaybillState) public compactWaybills;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event CompactLogisticsSynced(
        bytes32 indexed requestID,
        bytes32 indexed waybillIdHash,
        bytes32 indexed inspectorHash,
        int256 readingUnits
    );

    constructor(address router_) RoutedService(router_) {}

    /// @notice 将紧凑物流读数写入领域账本，而不是只返回状态码。
    function syncLogisticsCompact(
        bytes32 requestID,
        bytes32 waybillIdHash,
        bytes32 inspectorHash,
        int256 readingUnits,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        require(waybillIdHash != bytes32(0), "bad waybill id");
        require(inspectorHash != bytes32(0), "bad inspector");
        compactWaybills[requestID] = CompactWaybillState({
            requestID: requestID,
            waybillIdHash: waybillIdHash,
            inspectorHash: inspectorHash,
            readingUnits: readingUnits,
            metadataHash: metadataHash,
            updatedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[waybillIdHash] = requestID;
        emit CompactLogisticsSynced(requestID, waybillIdHash, inspectorHash, readingUnits);
        return keccak256(bytes("LOGISTICS_SYNCED"));
    }
}

/// @notice 授权许可类跨链消息的授权服务。
/// @dev 该动作会创建一条带过期时间的 active consent grant。撤销授权属于补偿路径，
/// 因此有意与该成功执行路径分离。
contract ConsentRegistryService is RoutedService {
    struct CompactConsentGrant {
        bytes32 requestID;
        bytes32 consentIdHash;
        bytes32 granteeHash;
        uint256 durationDays;
        bytes32 scopeHash;
        uint64 grantedAt;
        uint64 expiresAt;
        bool active;
    }

    mapping(bytes32 => CompactConsentGrant) public compactConsents;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event CompactConsentGranted(
        bytes32 indexed requestID,
        bytes32 indexed consentIdHash,
        bytes32 indexed granteeHash,
        uint64 expiresAt
    );

    constructor(address router_) RoutedService(router_) {}

    /// @notice 创建可查询、带失效时间的紧凑授权记录。
    function grantConsentCompact(
        bytes32 requestID,
        bytes32 consentIdHash,
        bytes32 granteeHash,
        uint256 durationDays,
        bytes32 scopeHash
    ) external onlyRouter returns (bytes32) {
        require(consentIdHash != bytes32(0), "bad consent id");
        require(granteeHash != bytes32(0), "bad grantee");
        require(durationDays > 0, "zero duration");
        require(durationDays <= (type(uint64).max - block.timestamp) / 1 days, "duration overflow");
        uint64 grantedAt = uint64(block.timestamp);
        uint64 expiresAt = uint64(block.timestamp + durationDays * 1 days);
        compactConsents[requestID] = CompactConsentGrant({
            requestID: requestID,
            consentIdHash: consentIdHash,
            granteeHash: granteeHash,
            durationDays: durationDays,
            scopeHash: scopeHash,
            grantedAt: grantedAt,
            expiresAt: expiresAt,
            active: true
        });
        recordKeyToRequestID[consentIdHash] = requestID;
        emit CompactConsentGranted(requestID, consentIdHash, granteeHash, expiresAt);
        return keccak256(bytes("CONSENT_GRANTED"));
    }
}

/// @notice Oracle feed 更新服务。
/// @dev 该动作会按 feedId 更新最新价格轮次。价格以定点基础单位保存，而不是显示字符串。
contract OracleFeedService is RoutedService {
    struct CompactFeedRound {
        bytes32 requestID;
        bytes32 feedIdHash;
        bytes32 publisherHash;
        uint256 priceUnits;
        bytes32 metadataHash;
        uint64 updatedAt;
    }

    mapping(bytes32 => CompactFeedRound) public compactLatestRound;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event CompactOracleUpdated(
        bytes32 indexed requestID,
        bytes32 indexed feedIdHash,
        bytes32 indexed publisherHash,
        uint256 priceUnits
    );

    constructor(address router_) RoutedService(router_) {}

    /// @notice 更新紧凑 feed 的最新真实轮次，后续读取按 feedIdHash 获取。
    function updateFeedCompact(
        bytes32 requestID,
        bytes32 feedIdHash,
        bytes32 publisherHash,
        uint256 priceUnits,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        require(feedIdHash != bytes32(0), "bad feed id");
        require(publisherHash != bytes32(0), "bad publisher");
        compactLatestRound[feedIdHash] = CompactFeedRound({
            requestID: requestID,
            feedIdHash: feedIdHash,
            publisherHash: publisherHash,
            priceUnits: priceUnits,
            metadataHash: metadataHash,
            updatedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[feedIdHash] = requestID;
        emit CompactOracleUpdated(requestID, feedIdHash, publisherHash, priceUnits);
        return keccak256(bytes("ORACLE_UPDATED"));
    }
}

/// @notice 多方审批工作流服务。
/// @dev 记录一条已通过的审批结果，包括审批方集合和阈值。该服务与 TargetContract
/// 分离，便于后续扩展审批规则时不修改面向 h-xmsg 网关的路由合约。
contract ApprovalWorkflowService is RoutedService {
    struct CompactApprovalDecision {
        bytes32 requestID;
        bytes32 workflowIdHash;
        bytes32 approversHash;
        uint256 threshold;
        bytes32 metadataHash;
        bool passed;
        uint64 committedAt;
    }

    mapping(bytes32 => CompactApprovalDecision) public compactDecisions;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event CompactApprovalCommitted(
        bytes32 indexed requestID,
        bytes32 indexed workflowIdHash,
        bytes32 indexed approversHash,
        uint256 threshold
    );

    constructor(address router_) RoutedService(router_) {}

    /// @notice 保存紧凑审批决定及阈值，使其成为可消费的领域状态。
    function commitApprovalCompact(
        bytes32 requestID,
        bytes32 workflowIdHash,
        bytes32 approversHash,
        uint256 threshold,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        require(workflowIdHash != bytes32(0), "bad workflow id");
        require(approversHash != bytes32(0), "bad approvers");
        require(threshold > 0, "zero threshold");
        compactDecisions[requestID] = CompactApprovalDecision({
            requestID: requestID,
            workflowIdHash: workflowIdHash,
            approversHash: approversHash,
            threshold: threshold,
            metadataHash: metadataHash,
            passed: true,
            committedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[workflowIdHash] = requestID;
        emit CompactApprovalCommitted(requestID, workflowIdHash, approversHash, threshold);
        return keccak256(bytes("APPROVAL_COMMITTED"));
    }
}
