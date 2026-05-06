// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITargetContract {
    function execute(bytes32 requestID, bytes calldata payload) external returns (bool);
}

contract VerifierContractV2 {
    struct XMsg {
        uint8 version;
        bytes32 requestID;
        bytes32 srcChainID;
        bytes32 dstChainID;
        bytes32 srcEmitter;
        address dstContract;
        bytes payload;
        bytes32 payloadHash;
        uint64 srcHeight;
        bytes eventProof;
        bytes finalityInfo;
        uint64 nonce;
    }

    struct ValidatorSet {
        bytes32 setId;
        uint16 threshold;
        bytes32 blsPubkeysHash;
        bool active;
    }

    mapping(bytes32 => bool) public consumed;
    uint64 public ctr;
    bytes32 public lastDigest;

    mapping(address => bool) public teeWhitelist;
    mapping(bytes32 => ValidatorSet) public validatorSets;
    bytes32[] public validatorSetIds;
    mapping(bytes32 => bool) public validatorSetExists;

    event Accepted(bytes32 indexed requestID, address indexed tee, uint64 ctr, bytes32 validatorSetId);
    event TEERegistered(address indexed tee);
    event TEERemoved(address indexed tee);
    event ValidatorSetRegistered(bytes32 indexed setId, uint16 threshold, uint256 pubkeyCount);
    event ValidatorSetDeactivated(bytes32 indexed setId);

    function registerTEE(address tee) external {
        teeWhitelist[tee] = true;
        emit TEERegistered(tee);
    }

    function removeTEE(address tee) external {
        teeWhitelist[tee] = false;
        emit TEERemoved(tee);
    }

    function registerValidatorSet(
        bytes32 setId,
        uint16 threshold,
        bytes[] calldata blsPubkeys
    ) external {
        require(!validatorSetExists[setId], "set already registered");
        require(threshold > 0 && threshold <= blsPubkeys.length, "invalid threshold");
        require(blsPubkeys.length > 0, "empty pubkeys");

        bytes32 pubkeysHash = _hashBlsPubkeys(blsPubkeys);

        validatorSets[setId] = ValidatorSet({
            setId: setId,
            threshold: threshold,
            blsPubkeysHash: pubkeysHash,
            active: true
        });
        validatorSetIds.push(setId);

        emit ValidatorSetRegistered(setId, threshold, blsPubkeys.length);
    }

    function deactivateValidatorSet(bytes32 setId) external {
        require(validatorSets[setId].active, "set not active");
        validatorSets[setId].active = false;
        emit ValidatorSetDeactivated(setId);
    }

    function getValidatorSet(bytes32 setId) external view returns (ValidatorSet memory) {
        return validatorSets[setId];
    }

    function getValidatorSetCount() external view returns (uint256) {
        return validatorSetIds.length;
    }

    function submit(
        XMsg calldata xmsg,
        bytes32 reportHash,
        bytes calldata teeSig,
        address teePubKey,
        bytes32 validatorSetId
    ) external {
        // 1. TEE identity
        require(teeWhitelist[teePubKey], "TEE not registered");

        // 2. Verify TEE signature over attestDigest = keccak256(abi.encode(reportHash, teePubKey))
        bytes32 attestDigest = keccak256(abi.encode(reportHash, teePubKey));
        address signer = _recover(attestDigest, teeSig);
        require(signer == teePubKey, "invalid tee signature");

        // 3. Validator set must be active on-chain
        ValidatorSet storage vset = validatorSets[validatorSetId];
        require(vset.active, "unknown or inactive validator set");

        // 4. Anti-replay
        require(!consumed[xmsg.requestID], "replay requestID");

        // 5. Payload integrity
        require(keccak256(xmsg.payload) == xmsg.payloadHash, "payload hash mismatch");

        // 6. State update
        ctr += 1;
        lastDigest = attestDigest;
        consumed[xmsg.requestID] = true;

        // 7. Execute
        ITargetContract(xmsg.dstContract).execute(xmsg.requestID, xmsg.payload);

        emit Accepted(xmsg.requestID, teePubKey, ctr, validatorSetId);
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

    function _hashBlsPubkeys(bytes[] calldata pubkeys) internal pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](pubkeys.length);
        for (uint256 i = 0; i < pubkeys.length; i++) {
            hashes[i] = keccak256(pubkeys[i]);
        }
        _sortBytes32(hashes);
        return keccak256(abi.encode(hashes));
    }

    function _sortBytes32(bytes32[] memory values) internal pure {
        for (uint256 i = 0; i < values.length; i++) {
            for (uint256 j = i + 1; j < values.length; j++) {
                if (values[i] > values[j]) {
                    (values[i], values[j]) = (values[j], values[i]);
                }
            }
        }
    }
}
