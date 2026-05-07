// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITargetContract {
    function execute(bytes32 requestID, bytes calldata payload) external returns (bool);
}

contract VerifierContractV3 {
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
        uint64 nonce;
    }

    // === 路径A: 签名者集合（独立验证） ===
    mapping(address => bool) public registeredSigners;
    address[] public signerList;
    uint16 public signerThreshold;

    // === 路径B: TEE 白名单（独立验证） ===
    mapping(address => bool) public teeWhitelist;

    // === 防重放 ===
    mapping(bytes32 => bool) public consumed;
    uint64 public ctr;

    event Accepted(bytes32 indexed requestID, address indexed tee);
    event SignerRegistered(address indexed signer);
    event SignerRemoved(address indexed signer);
    event TEERegistered(address indexed tee);
    event TEERemoved(address indexed tee);
    event ThresholdSet(uint16 threshold);

    // ============ 管理员函数 ============

    function registerSigner(address signer) external {
        require(!registeredSigners[signer], "already registered");
        registeredSigners[signer] = true;
        signerList.push(signer);
        emit SignerRegistered(signer);
    }

    function removeSigner(address signer) external {
        require(registeredSigners[signer], "not registered");
        registeredSigners[signer] = false;
        emit SignerRemoved(signer);
    }

    function setThreshold(uint16 t) external {
        require(t > 0, "threshold must be > 0");
        signerThreshold = t;
        emit ThresholdSet(t);
    }

    function registerSignersBatch(address[] calldata signers, uint16 threshold) external {
        for (uint256 i = 0; i < signers.length; i++) {
            if (!registeredSigners[signers[i]]) {
                registeredSigners[signers[i]] = true;
                signerList.push(signers[i]);
                emit SignerRegistered(signers[i]);
            }
        }
        if (threshold > 0) {
            signerThreshold = threshold;
            emit ThresholdSet(threshold);
        }
    }

    function registerTEE(address tee) external {
        teeWhitelist[tee] = true;
        emit TEERegistered(tee);
    }

    function removeTEE(address tee) external {
        teeWhitelist[tee] = false;
        emit TEERemoved(tee);
    }

    function getSignerCount() external view returns (uint256) {
        return signerList.length;
    }

    // ============ 验证入口 ============

    function submit(
        XMsg calldata xmsg,
        bytes[] calldata signatures,
        bytes32 consensusMessage,
        address teePubKey,
        bytes32 reportHash,
        bytes calldata teeSig
    ) external {
        // ==========================================
        // 路径A: 签名者共识验证（独立于TEE）
        // ==========================================
        uint256 uniqueSigners = _verifySignerThreshold(consensusMessage, signatures);
        require(uniqueSigners >= signerThreshold, "signer threshold not met");

        // ==========================================
        // 路径B: TEE 结构验证（独立于签名者）
        // ==========================================
        require(teeWhitelist[teePubKey], "TEE not registered");
        bytes32 attestDigest = keccak256(abi.encode(reportHash, teePubKey));
        address recovered = _recover(attestDigest, teeSig);
        require(recovered == teePubKey, "invalid TEE signature");

        // ==========================================
        // 消息完整性
        // ==========================================
        require(!consumed[xmsg.requestID], "replay requestID");
        require(keccak256(xmsg.payload) == xmsg.payloadHash, "payload hash mismatch");

        // ==========================================
        // 执行
        // ==========================================
        consumed[xmsg.requestID] = true;
        ctr += 1;
        ITargetContract(xmsg.dstContract).execute(xmsg.requestID, xmsg.payload);
        emit Accepted(xmsg.requestID, teePubKey);
    }

    // ============ 内部函数 ============

    function _verifySignerThreshold(
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view returns (uint256) {
        uint256 count;
        address lastSigner;

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(digest, signatures[i]);
            require(registeredSigners[signer], "unknown signer");
            // 去重：签名者地址必须严格递增
            require(signer > lastSigner, "duplicate or unsorted signer");
            lastSigner = signer;
            count++;
        }

        return count;
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
}
