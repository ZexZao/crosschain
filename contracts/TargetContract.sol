// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TargetContract {
    struct BusinessPayload {
        string op;
        string recordId;
        string actor;
        string amount;
        string metadata;
    }

    struct ExecutionRecord {
        bytes32 requestID;
        address caller;
        string op;
        string recordId;
        string actor;
        string amount;
        bytes32 payloadHash;
        bytes32 metadataHash;
        uint256 blockNumber;
    }

    event BusinessExecuted(
        bytes32 indexed requestID,
        address indexed caller,
        string op,
        string recordId,
        string actor,
        string amount
    );

    bytes32 public lastRequestID;
    uint256 public executionCount;

    string public lastOp;
    string public lastRecordId;
    string public lastActor;
    string public lastAmount;
    bytes32 public lastPayloadHash;
    bytes32 public lastMetadataHash;

    ExecutionRecord[] private executionHistory;
    mapping(bytes32 => uint256) private requestIndexPlusOne;
    mapping(bytes32 => bytes32[]) private requestIDsByOpHash;
    mapping(bytes32 => bytes32[]) private requestIDsByRecordIdHash;
    mapping(bytes32 => bytes32[]) private requestIDsByActorHash;

    function decodePayload(bytes calldata payload) public pure returns (BusinessPayload memory) {
        (
            string memory op,
            string memory recordId,
            string memory actor,
            string memory amount,
            string memory metadata
        ) = abi.decode(payload, (string, string, string, string, string));

        return BusinessPayload({
            op: op,
            recordId: recordId,
            actor: actor,
            amount: amount,
            metadata: metadata
        });
    }

    function execute(bytes32 requestID, bytes calldata payload) external returns (bool) {
        require(requestIndexPlusOne[requestID] == 0, "duplicate requestID");

        BusinessPayload memory parsed = decodePayload(payload);
        bytes32 payloadHash = keccak256(payload);
        bytes32 metadataHash = keccak256(bytes(parsed.metadata));

        lastRequestID = requestID;
        executionCount += 1;

        lastOp = parsed.op;
        lastRecordId = parsed.recordId;
        lastActor = parsed.actor;
        lastAmount = parsed.amount;
        lastPayloadHash = payloadHash;
        lastMetadataHash = metadataHash;

        executionHistory.push(
            ExecutionRecord({
                requestID: requestID,
                caller: msg.sender,
                op: parsed.op,
                recordId: parsed.recordId,
                actor: parsed.actor,
                amount: parsed.amount,
                payloadHash: payloadHash,
                metadataHash: metadataHash,
                blockNumber: block.number
            })
        );

        requestIndexPlusOne[requestID] = executionHistory.length;
        requestIDsByOpHash[_key(parsed.op)].push(requestID);
        requestIDsByRecordIdHash[_key(parsed.recordId)].push(requestID);
        requestIDsByActorHash[_key(parsed.actor)].push(requestID);

        emit BusinessExecuted(
            requestID,
            msg.sender,
            parsed.op,
            parsed.recordId,
            parsed.actor,
            parsed.amount
        );
        return true;
    }

    function historyCount() external view returns (uint256) {
        return executionHistory.length;
    }

    function getExecutionByIndex(uint256 index) external view returns (ExecutionRecord memory) {
        require(index < executionHistory.length, "index out of bounds");
        return executionHistory[index];
    }

    function getExecutionByRequestID(bytes32 requestID) external view returns (ExecutionRecord memory) {
        uint256 indexPlusOne = requestIndexPlusOne[requestID];
        require(indexPlusOne != 0, "request not found");
        return executionHistory[indexPlusOne - 1];
    }

    function getRequestIDsByOp(string calldata op) external view returns (bytes32[] memory) {
        return requestIDsByOpHash[_key(op)];
    }

    function getRequestIDsByRecordId(string calldata recordId) external view returns (bytes32[] memory) {
        return requestIDsByRecordIdHash[_key(recordId)];
    }

    function getRequestIDsByActor(string calldata actor) external view returns (bytes32[] memory) {
        return requestIDsByActorHash[_key(actor)];
    }

    function _key(string memory value) internal pure returns (bytes32) {
        return keccak256(bytes(value));
    }
}
