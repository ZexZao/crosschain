// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BusinessServiceContracts.sol";

contract TargetContract {
    struct BusinessRecord {
        bytes32 requestID;
        string op;
        string recordId;
        string actor;
        string amount;
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
    event BusinessActionApplied(
        bytes32 indexed requestID,
        bytes32 indexed recordKey,
        bytes32 indexed opKey,
        string op,
        string recordId,
        string actor,
        string amount,
        bytes32 status
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
    mapping(bytes32 => BusinessRecord) private businessRecords;
    mapping(bytes32 => bytes32) public recordKeyToRequestID;
    mapping(bytes32 => uint256) public opExecutionCount;
    mapping(bytes32 => uint256) public assetAmountByRequest;
    mapping(bytes32 => address) public assetRecipientByRequest;

    constructor(address gateway_) {
        gateway = gateway_;
        assetService = new CrossChainAssetService(address(this));
        receivableService = new ReceivableRegistryService(address(this));
        logisticsService = new LogisticsTrackerService(address(this));
        consentService = new ConsentRegistryService(address(this));
        oracleService = new OracleFeedService(address(this));
        approvalService = new ApprovalWorkflowService(address(this));
        token = assetService.token();
    }

    function execute(bytes32 requestID, bytes calldata payload) external returns (bool) {
        require(msg.sender == gateway, "only gateway");
        bytes32 payloadHash = keccak256(payload);

        lastRequestID = requestID;
        lastPayloadHash = payloadHash;
        executionCount += 1;
        _applyBusinessAction(requestID, payload);
        emit MessageExecuted(requestID, msg.sender, payloadHash, executionCount);
        return true;
    }

    function getBusinessRecord(bytes32 requestID) external view returns (BusinessRecord memory) {
        return businessRecords[requestID];
    }

    function getBusinessRecordByKey(string calldata op, string calldata recordId) external view returns (BusinessRecord memory) {
        return businessRecords[recordKeyToRequestID[_recordKey(op, recordId)]];
    }

    function _applyBusinessAction(bytes32 requestID, bytes calldata payload) internal {
        (
            string memory op,
            string memory recordId,
            string memory actor,
            string memory amount,
            string memory metadata,
            bool requireAck
        ) = abi.decode(payload, (string, string, string, string, string, bool));

        bytes32 opKey = keccak256(bytes(op));
        bytes32 recordKey = _recordKey(op, recordId);
        bytes32 metadataHash = keccak256(bytes(metadata));
        (address service, bytes32 status) = _dispatchBusinessService(
            requestID,
            opKey,
            recordId,
            actor,
            amount,
            metadataHash
        );

        businessRecords[requestID] = BusinessRecord({
            requestID: requestID,
            op: op,
            recordId: recordId,
            actor: actor,
            amount: amount,
            metadataHash: metadataHash,
            requireAck: requireAck,
            service: service,
            status: status,
            updatedAt: uint64(block.timestamp)
        });
        recordKeyToRequestID[recordKey] = requestID;
        opExecutionCount[opKey] += 1;

        emit BusinessActionApplied(requestID, recordKey, opKey, op, recordId, actor, amount, status);
    }

    function _dispatchBusinessService(
        bytes32 requestID,
        bytes32 opKey,
        string memory recordId,
        string memory actor,
        string memory amount,
        bytes32 metadataHash
    ) internal returns (address service, bytes32 status) {
        if (
            opKey == keccak256(bytes("asset_lock")) ||
            opKey == keccak256(bytes("mint_confirm")) ||
            opKey == keccak256(bytes("token_transfer")) ||
            opKey == keccak256(bytes("subsidy_confirm"))
        ) {
            (bool ok, address recipient) = _parseAddress(actor);
            require(ok, "asset recipient must be evm address");
            uint256 units = _parseAmount4(amount);
            status = assetService.mintSettlement(requestID, recordId, recipient, units, metadataHash);
            assetAmountByRequest[requestID] = units;
            assetRecipientByRequest[requestID] = recipient;
            return (address(assetService), status);
        }
        if (opKey == keccak256(bytes("receivable_attest"))) {
            status = receivableService.attestReceivable(requestID, recordId, actor, _parseAmount4(amount), metadataHash);
            return (address(receivableService), status);
        }
        if (opKey == keccak256(bytes("logistics_sync"))) {
            status = logisticsService.syncLogistics(requestID, recordId, actor, _parseSignedAmount4(amount), metadataHash);
            return (address(logisticsService), status);
        }
        if (opKey == keccak256(bytes("medical_consent"))) {
            status = consentService.grantConsent(requestID, recordId, actor, _parseUint(amount), metadataHash);
            return (address(consentService), status);
        }
        if (opKey == keccak256(bytes("oracle_update"))) {
            status = oracleService.updateFeed(requestID, recordId, actor, _parseAmount4(amount), metadataHash);
            return (address(oracleService), status);
        }
        if (opKey == keccak256(bytes("approval_commit"))) {
            status = approvalService.commitApproval(requestID, recordId, actor, _parseUint(amount), metadataHash);
            return (address(approvalService), status);
        }
        revert("unsupported business op");
    }

    function _recordKey(string memory op, string memory recordId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(op, ":", recordId));
    }

    function _parseUint(string memory text) internal pure returns (uint256) {
        bytes memory data = bytes(text);
        require(data.length > 0, "bad uint");
        uint256 value = 0;
        for (uint256 i = 0; i < data.length; i += 1) {
            bytes1 ch = data[i];
            require(ch >= "0" && ch <= "9", "bad uint");
            value = value * 10 + (uint8(ch) - 48);
        }
        return value;
    }

    function _parseSignedAmount4(string memory text) internal pure returns (int256) {
        bytes memory data = bytes(text);
        require(data.length > 0, "bad signed amount");
        if (data[0] == "-") {
            bytes memory unsigned = new bytes(data.length - 1);
            for (uint256 i = 1; i < data.length; i += 1) {
                unsigned[i - 1] = data[i];
            }
            return -int256(_parseAmount4(string(unsigned)));
        }
        return int256(_parseAmount4(text));
    }

    function _parseAmount4(string memory text) internal pure returns (uint256) {
        bytes memory data = bytes(text);
        uint256 whole = 0;
        uint256 frac = 0;
        uint256 fracDigits = 0;
        bool afterDot = false;
        for (uint256 i = 0; i < data.length; i += 1) {
            bytes1 ch = data[i];
            if (ch == ".") {
                require(!afterDot, "bad amount");
                afterDot = true;
                continue;
            }
            require(ch >= "0" && ch <= "9", "bad amount");
            uint256 digit = uint8(ch) - 48;
            if (afterDot) {
                if (fracDigits < 4) {
                    frac = frac * 10 + digit;
                    fracDigits += 1;
                } else {
                    require(digit == 0, "too many decimals");
                }
            } else {
                whole = whole * 10 + digit;
            }
        }
        while (fracDigits < 4) {
            frac *= 10;
            fracDigits += 1;
        }
        return whole * 10000 + frac;
    }

    function _parseAddress(string memory text) internal pure returns (bool, address) {
        bytes memory data = bytes(text);
        if (data.length != 42 || data[0] != "0" || (data[1] != "x" && data[1] != "X")) {
            return (false, address(0));
        }
        uint160 value = 0;
        for (uint256 i = 2; i < 42; i += 1) {
            uint8 v;
            uint8 c = uint8(data[i]);
            if (c >= 48 && c <= 57) v = c - 48;
            else if (c >= 65 && c <= 70) v = c - 55;
            else if (c >= 97 && c <= 102) v = c - 87;
            else return (false, address(0));
            value = value * 16 + uint160(v);
        }
        return (true, address(value));
    }
}
