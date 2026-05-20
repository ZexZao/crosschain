// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract EvmSourceContract {
    enum RequestStatus {
        None,
        Pending,
        Completed,
        Challenged,
        Refunded,
        Cancelled
    }

    struct RequestRecord {
        address sender;
        bytes32 targetChainID;
        bytes32 targetDomainID;
        bytes32 targetObject;
        bytes4 functionSelector;
        bytes32 callDataHash;
        bytes32 businessPayloadHash;
        uint64 nonce;
        uint64 expireAt;
        RequestStatus status;
    }

    uint64 public nonce;
    mapping(bytes32 => RequestRecord) public requests;

    event CrossChainCallRequested(
        bytes32 indexed requestID,
        address indexed sender,
        bytes32 indexed targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 nonce,
        uint64 expireAt
    );

    event RequestStatusChanged(bytes32 indexed requestID, RequestStatus status);

    function submitRequest(
        bytes32 targetChainID,
        bytes32 targetDomainID,
        bytes32 targetObject,
        bytes4 functionSelector,
        bytes32 callDataHash,
        bytes32 businessPayloadHash,
        bytes32 receiver,
        uint64 expireAt
    ) external returns (bytes32) {
        require(expireAt > block.timestamp, "expired request");
        nonce += 1;
        bytes32 requestID = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                nonce,
                targetChainID,
                targetDomainID,
                targetObject,
                functionSelector,
                callDataHash
            )
        );
        require(requests[requestID].status == RequestStatus.None, "duplicate request");

        requests[requestID] = RequestRecord({
            sender: msg.sender,
            targetChainID: targetChainID,
            targetDomainID: targetDomainID,
            targetObject: targetObject,
            functionSelector: functionSelector,
            callDataHash: callDataHash,
            businessPayloadHash: businessPayloadHash,
            nonce: nonce,
            expireAt: expireAt,
            status: RequestStatus.Pending
        });

        emit CrossChainCallRequested(
            requestID,
            msg.sender,
            targetChainID,
            targetDomainID,
            targetObject,
            functionSelector,
            callDataHash,
            businessPayloadHash,
            receiver,
            nonce,
            expireAt
        );
        return requestID;
    }

    function startChallenge(bytes32 requestID) external {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Pending, "not pending");
        require(record.sender == msg.sender, "not sender");
        record.status = RequestStatus.Challenged;
        emit RequestStatusChanged(requestID, RequestStatus.Challenged);
    }

    function markCompleted(bytes32 requestID) external {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Pending || record.status == RequestStatus.Challenged, "bad status");
        record.status = RequestStatus.Completed;
        emit RequestStatusChanged(requestID, RequestStatus.Completed);
    }

    function refund(bytes32 requestID) external {
        RequestRecord storage record = requests[requestID];
        require(record.status == RequestStatus.Challenged, "not challenged");
        require(record.sender == msg.sender, "not sender");
        record.status = RequestStatus.Refunded;
        emit RequestStatusChanged(requestID, RequestStatus.Refunded);
    }

}
