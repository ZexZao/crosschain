// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITargetContract {
    function execute(bytes32 requestID, bytes calldata payload) external returns (bool);
}

contract VerifierContract {
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
        address teePubKey;
    }

    mapping(bytes32 => bool) public consumed;
    uint64 public lastCtr;
    bytes32 public lastDigest;
    mapping(address => bool) public teeWhitelist;

    event Accepted(bytes32 indexed requestID, address indexed tee, uint64 ctr, bytes32 digest);
    event TEERegistered(address indexed tee);

    function registerTEE(address tee) external {
        teeWhitelist[tee] = true;
        emit TEERegistered(tee);
    }

    function computeCoreHash(XMsg calldata xmsg) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                xmsg.version,
                xmsg.requestID,
                xmsg.srcChainID,
                xmsg.dstChainID,
                xmsg.srcEmitter,
                xmsg.dstContract,
                keccak256(xmsg.payload),
                xmsg.payloadHash,
                xmsg.srcHeight,
                keccak256(xmsg.eventProof),
                keccak256(xmsg.finalityInfo),
                xmsg.nonce,
                xmsg.teePubKey
            )
        );
    }

    function computeDigest(XMsg calldata xmsg, uint64 ctr, bytes32 prevDigest) public pure returns (bytes32) {
        return keccak256(abi.encode(computeCoreHash(xmsg), ctr, prevDigest));
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

    function submit(
        XMsg calldata xmsg,
        bytes calldata teeReport,
        bytes calldata teeSig,
        uint64 ctr,
        bytes32 prevDigest
    ) external {
        require(teeWhitelist[xmsg.teePubKey], "TEE not registered");
        require(keccak256(teeReport) == keccak256(abi.encodePacked("SIM_TEE_REPORT", xmsg.teePubKey)), "bad tee report");
        require(!consumed[xmsg.requestID], "replay requestID");
        require(keccak256(xmsg.payload) == xmsg.payloadHash, "payload hash mismatch");
        require(ctr > lastCtr, "non-monotonic ctr");
        require(prevDigest == lastDigest, "continuity broken");

        bytes32 digest = computeDigest(xmsg, ctr, prevDigest);
        address signer = _recover(digest, teeSig);
        require(signer == xmsg.teePubKey, "invalid tee signature");

        consumed[xmsg.requestID] = true;
        lastCtr = ctr;
        lastDigest = digest;

        ITargetContract(xmsg.dstContract).execute(xmsg.requestID, xmsg.payload);
        emit Accepted(xmsg.requestID, signer, ctr, digest);
    }
}
