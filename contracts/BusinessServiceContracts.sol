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

    constructor(address router_) RoutedService(router_) {
        token = new CrossChainToken("CrossChain Settlement Token", "XCST", 4, address(this));
    }

    /// @notice 通过 mint XCST 结算一条已验证的跨链资产消息。
    /// @param requestID h-xmsg 请求 ID，同时作为唯一结算 ID。
    /// @param recordId 规范化业务 payload 中的业务记录 ID。
    /// @param recipient 接收结算 token 的 EVM 账户。
    /// @param amountUnits token 基础单位数量。XCST 使用 4 位小数。
    /// @param reasonHash 业务 metadata 的哈希，用于审计绑定。
    /// @return statusHash keccak256("ASSET_SETTLED")。
    function mintSettlement(
        bytes32 requestID,
        string calldata recordId,
        address recipient,
        uint256 amountUnits,
        bytes32 reasonHash
    ) external onlyRouter returns (bytes32) {
        require(recipient != address(0), "bad recipient");
        require(amountUnits > 0, "zero amount");
        bytes32 recordKey = keccak256(abi.encodePacked("asset:", recordId));
        settlements[requestID] = Settlement({
            requestID: requestID,
            recordId: recordId,
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
}

/// @notice 应收账款证明服务。
/// @dev 该动作会真实更新链上登记表：把 receivableId 与供应商、金额、metadataHash
/// 绑定，便于后续合约或审计方通过 requestID 或 recordKey 消费该证明。
contract ReceivableRegistryService is RoutedService {
    struct Receivable {
        bytes32 requestID;
        string receivableId;
        string supplier;
        uint256 amountUnits;
        bytes32 metadataHash;
        bool attested;
        uint64 attestedAt;
    }

    mapping(bytes32 => Receivable) public receivables;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event ReceivableAttested(bytes32 indexed requestID, bytes32 indexed recordKey, string supplier, uint256 amountUnits);

    constructor(address router_) RoutedService(router_) {}

    /// @notice 登记一条已验证的应收账款证明。
    /// @return statusHash keccak256("RECEIVABLE_ATTESTED")。
    function attestReceivable(
        bytes32 requestID,
        string calldata receivableId,
        string calldata supplier,
        uint256 amountUnits,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        require(amountUnits > 0, "zero amount");
        bytes32 recordKey = keccak256(abi.encodePacked("receivable:", receivableId));
        receivables[requestID] = Receivable({
            requestID: requestID,
            receivableId: receivableId,
            supplier: supplier,
            amountUnits: amountUnits,
            metadataHash: metadataHash,
            attested: true,
            attestedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[recordKey] = requestID;
        emit ReceivableAttested(requestID, recordKey, supplier, amountUnits);
        return keccak256(bytes("RECEIVABLE_ATTESTED"));
    }
}

/// @notice 物流状态同步服务。
/// @dev 存储跨链同步过来的最新 waybill 读数。负数会在路由器中转换为有符号定点单位。
contract LogisticsTrackerService is RoutedService {
    struct WaybillState {
        bytes32 requestID;
        string waybillId;
        string inspector;
        int256 readingUnits;
        bytes32 metadataHash;
        uint64 updatedAt;
    }

    mapping(bytes32 => WaybillState) public waybills;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event LogisticsSynced(bytes32 indexed requestID, bytes32 indexed recordKey, string inspector, int256 readingUnits);

    constructor(address router_) RoutedService(router_) {}

    /// @notice 应用一条已验证的 waybill 物流更新。
    /// @return statusHash keccak256("LOGISTICS_SYNCED")。
    function syncLogistics(
        bytes32 requestID,
        string calldata waybillId,
        string calldata inspector,
        int256 readingUnits,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        bytes32 recordKey = keccak256(abi.encodePacked("logistics:", waybillId));
        waybills[requestID] = WaybillState({
            requestID: requestID,
            waybillId: waybillId,
            inspector: inspector,
            readingUnits: readingUnits,
            metadataHash: metadataHash,
            updatedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[recordKey] = requestID;
        emit LogisticsSynced(requestID, recordKey, inspector, readingUnits);
        return keccak256(bytes("LOGISTICS_SYNCED"));
    }
}

/// @notice 授权许可类跨链消息的授权服务。
/// @dev 该动作会创建一条带过期时间的 active consent grant。撤销授权属于补偿路径，
/// 因此有意与该成功执行路径分离。
contract ConsentRegistryService is RoutedService {
    struct ConsentGrant {
        bytes32 requestID;
        string consentId;
        string grantee;
        uint256 durationDays;
        bytes32 scopeHash;
        uint64 grantedAt;
        uint64 expiresAt;
        bool active;
    }

    mapping(bytes32 => ConsentGrant) public consents;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event ConsentGranted(bytes32 indexed requestID, bytes32 indexed recordKey, string grantee, uint64 expiresAt);

    constructor(address router_) RoutedService(router_) {}

    /// @notice 在 h-xmsg 验证通过后创建一条 active consent grant。
    /// @return statusHash keccak256("CONSENT_GRANTED")。
    function grantConsent(
        bytes32 requestID,
        string calldata consentId,
        string calldata grantee,
        uint256 durationDays,
        bytes32 scopeHash
    ) external onlyRouter returns (bytes32) {
        require(durationDays > 0, "zero duration");
        bytes32 recordKey = keccak256(abi.encodePacked("consent:", consentId));
        uint64 expiresAt = uint64(block.timestamp + durationDays * 1 days);
        consents[requestID] = ConsentGrant({
            requestID: requestID,
            consentId: consentId,
            grantee: grantee,
            durationDays: durationDays,
            scopeHash: scopeHash,
            grantedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            active: true
        });
        recordKeyToRequestID[recordKey] = requestID;
        emit ConsentGranted(requestID, recordKey, grantee, expiresAt);
        return keccak256(bytes("CONSENT_GRANTED"));
    }
}

/// @notice Oracle feed 更新服务。
/// @dev 该动作会按 feedId 更新最新价格轮次。价格以定点基础单位保存，而不是显示字符串。
contract OracleFeedService is RoutedService {
    struct FeedRound {
        bytes32 requestID;
        string feedId;
        string publisher;
        uint256 priceUnits;
        bytes32 metadataHash;
        uint64 updatedAt;
    }

    mapping(bytes32 => FeedRound) public latestRound;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event OracleUpdated(bytes32 indexed requestID, bytes32 indexed feedKey, string publisher, uint256 priceUnits);

    constructor(address router_) RoutedService(router_) {}

    /// @notice 使用已验证的跨链 oracle 值更新 feed。
    /// @return statusHash keccak256("ORACLE_UPDATED")。
    function updateFeed(
        bytes32 requestID,
        string calldata feedId,
        string calldata publisher,
        uint256 priceUnits,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        bytes32 feedKey = keccak256(bytes(feedId));
        latestRound[feedKey] = FeedRound({
            requestID: requestID,
            feedId: feedId,
            publisher: publisher,
            priceUnits: priceUnits,
            metadataHash: metadataHash,
            updatedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[feedKey] = requestID;
        emit OracleUpdated(requestID, feedKey, publisher, priceUnits);
        return keccak256(bytes("ORACLE_UPDATED"));
    }
}

/// @notice 多方审批工作流服务。
/// @dev 记录一条已通过的审批结果，包括审批方集合和阈值。该服务与 TargetContract
/// 分离，便于后续扩展审批规则时不修改面向 h-xmsg 网关的路由合约。
contract ApprovalWorkflowService is RoutedService {
    struct ApprovalDecision {
        bytes32 requestID;
        string workflowId;
        string approvers;
        uint256 threshold;
        bytes32 metadataHash;
        bool passed;
        uint64 committedAt;
    }

    mapping(bytes32 => ApprovalDecision) public decisions;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;

    event ApprovalCommitted(bytes32 indexed requestID, bytes32 indexed recordKey, string approvers, uint256 threshold);

    constructor(address router_) RoutedService(router_) {}

    /// @notice 提交一条已验证的审批结果。
    /// @return statusHash keccak256("APPROVAL_COMMITTED")。
    function commitApproval(
        bytes32 requestID,
        string calldata workflowId,
        string calldata approvers,
        uint256 threshold,
        bytes32 metadataHash
    ) external onlyRouter returns (bytes32) {
        require(threshold > 0, "zero threshold");
        bytes32 recordKey = keccak256(abi.encodePacked("approval:", workflowId));
        decisions[requestID] = ApprovalDecision({
            requestID: requestID,
            workflowId: workflowId,
            approvers: approvers,
            threshold: threshold,
            metadataHash: metadataHash,
            passed: true,
            committedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[recordKey] = requestID;
        emit ApprovalCommitted(requestID, recordKey, approvers, threshold);
        return keccak256(bytes("APPROVAL_COMMITTED"));
    }
}
