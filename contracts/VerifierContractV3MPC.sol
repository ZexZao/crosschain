// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITargetContract {
    function execute(bytes32 requestID, bytes calldata payload) external returns (bool);
}

contract VerifierContractV3MPC {
    struct XMsg {
        uint8 version;
        uint8 chainType;
        uint8 finalityModel;
        uint16 requiredConfirmations;
        bytes32 requestID;
        bytes32 srcChainID;
        bytes32 dstChainID;
        bytes32 srcEmitter;
        address dstContract;
        bytes payload;
        bytes32 payloadHash;
        uint64 srcHeight;
        uint64 nonce;
    }

    // === 签名者路径: MPC-TSS 单一公钥 ===
    address public signerPubkey;

    // === TEE 白名单 ===
    mapping(address => bool) public teeWhitelist;

    // === 防重放 ===
    mapping(bytes32 => bool) public consumed;
    uint64 public ctr;

    event Accepted(bytes32 indexed requestID, address indexed tee);
    event SignerPubkeySet(address pubkey);
    event TEERegistered(address indexed tee);

    function setSignerPubkey(address pubkey) external {
        signerPubkey = pubkey;
        emit SignerPubkeySet(pubkey);
    }

    function registerTEE(address tee) external {
        teeWhitelist[tee] = true;
        emit TEERegistered(tee);
    }

    function submit(
        XMsg calldata xmsg,
        bytes calldata signature,
        bytes32 consensusMessage,
        address teePubKey,
        bytes32 reportHash,
        bytes calldata teeSig
    ) external {
        // ====== 路径A: MPC-TSS 单一 ECDSA 签名 ======
        require(signerPubkey != address(0), "signer pubkey not set");
        address recovered = _recover(consensusMessage, signature);
        require(recovered == signerPubkey, "invalid signer signature");

        // ====== 路径B: TEE 独立验证 ======
        require(teeWhitelist[teePubKey], "TEE not registered");
        bytes32 attestDigest = keccak256(abi.encode(reportHash, teePubKey));
        require(_recover(attestDigest, teeSig) == teePubKey, "invalid tee sig");

        // ====== 消息完整性 ======
        require(!consumed[xmsg.requestID], "replay");
        require(keccak256(xmsg.payload) == xmsg.payloadHash, "payload hash mismatch");

        consumed[xmsg.requestID] = true;
        ctr += 1;
        ITargetContract(xmsg.dstContract).execute(xmsg.requestID, xmsg.payload);
        emit Accepted(xmsg.requestID, teePubKey);
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, s);
    }
}
