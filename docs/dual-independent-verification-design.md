# 双重独立验证混合桥设计方案

## 1. 设计目标

构造一个跨链桥验证系统，满足以下安全命题：

> **签名者路径和 TEE 路径在链上独立验证，任一路径被完全攻破，另一路径仍能阻止攻击。**

具体而言：
- 若全部 4 个签名者被攻破（但 TEE 未被攻破）→ 攻击被 TEE 路径阻止
- 若 TEE 被攻破（但签名者未被攻破）→ 攻击被签名者路径阻止
- 只有签名者和 TEE **同时**被攻破，攻击才可能成功

这与当前实现的关键区别：**两条路径在链上合约中各自独立验证，互不依赖。**

## 2. 当前实现的问题

当前 `VerifierContractV2.submit()` 的验证逻辑：

```
当前:
  ① 验 TEE 签名 (ecrecover attestDigest)
  ② 验 TEE 在白名单中
  ③ 验 ValidatorSet 在链上标记为 active
  ④ 验 payloadHash
  ⑤ 验防重放

问题: ③ 只检查了 ValidatorSet 的 active 标志位，从未在链上验证 BLS 签名本身。
      BLS 验证完全在 TEE 内部完成。如果 TEE 被攻破，攻击者可以:
      1. 伪造一个 eventProof
      2. 让被攻破的 TEE 对其签名
      3. 提交到链上 — 合约只验 TEE 签名，放行
```

```
攻击路径（TEE 被攻破时）:
  攻击者 → 伪造 XMsg → 被攻破的TEE签名 → VerifierContractV2（验TEE签名通过）→ 攻击成功
                                   ↑
                          BLS验证虽在TEE内，但TEE已被控，可以返回 blsValid=true
                          链上合约完全看不到BLS验证结果
```

## 3. 新架构：链上双重独立验证

### 3.1 核心思想

```
链上合约 = 签名者共识路径(ECDSA) ⊕ TEE结构路径(ECDSA)

两条路径:
  - 使用不同的密钥集合（签名者密钥 ≠ TEE 密钥）
  - 验证不同的事实（签名者验证交易存在，TEE 验证证明结构）
  - 在链上合约中独立执行，任一失败则整笔交易拒收
  - 不存在"TEE替签名者验证"的代理关系
```

### 3.2 为什么用 ECDSA 而非 BLS

| 因素 | BLS12-381 | ECDSA (secp256k1) |
|------|-----------|-------------------|
| EVM 原生预编译 | ❌ 不存在 | ✅ `ecrecover` (gas ~3000) |
| 链上聚合验证 | 需 Solidity 库，>1M gas | N/A（逐条验证） |
| 链上逐条验证 | 同上 | 4 条签名 ~12000 gas |
| 聚合签名体积 | 48 bytes (G1) | N × 65 bytes = 260 bytes (N=4) |
| 结论 | BLS 适用于链下聚合，**链上验证不可行** | ECDSA 适用于链上逐条验证，**gas 可接受** |

**策略：链下 BLS 聚合 + 链上 ECDSA 阈值。** Validator 同时持有 BLS 和 ECDSA 两种密钥——BLS 用于 TEE 内高效聚合验证（O(1)），ECDSA 用于链上独立验证（O(N), N=4, ~12k gas）。

### 3.3 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        源链 (Fabric / EVM)                              │
│   chaincode 发射事件 → Listener 捕获 (txId, blockHeader, payload)       │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Proof Builder                                        │
│   构造 XMsg + eventProof(Merkle) + finalityInfo                          │
│   构造 consensusMessage = keccak256(channel, blockNumber, blockHash,     │
│                              eventRoot, requestID, payloadHash)          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          ▼                      ▼                      ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
│ Signer Path      │  │ TEE Path         │  │                          │
│ (ECDSA threshold)│  │ (独立验证+签名)   │  │                          │
│                  │  │                  │  │                          │
│ 4×Validator      │  │ TEE 独立连接     │  │  Relayer                 │
│ 各自查peer确认   │  │ Fabric peer      │  │  组装两份证明:            │
│ → ECDSA签名 ×4  │  │ 验证交易存在     │  │  · signatures[] (×N)     │
│                  │  │ 验证eventProof   │  │  · teeReport + teeSig    │
│ 输出:            │  │ 验证finalityInfo │  │                          │
│ signatures[]     │  │ → ECDSA签名报告  │  │  提交到 VerifierContract │
│ (N个65字节)      │  │                  │  │                          │
│                  │  │ 输出:            │  │                          │
│                  │  │ teeReport+teeSig │  │                          │
└────────┬─────────┘  └────────┬─────────┘  └──────────────────────────┘
         │                      │
         │    ┌─────────────────┘
         │    │
         ▼    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              目标链 VerifierContractV3 (双重独立验证)                     │
│                                                                         │
│  // === 路径A: 签名者共识 (独立，不依赖TEE) ===                           │
│  require(verifySignerThreshold(signatures, consensusMsg) >= 3/4)         │
│  // 对每条签名: ecrecover(consensusMsg, sig) ∈ registeredSigners          │
│  // 去重后计数 uniqueSigners ≥ threshold                                 │
│                                                                         │
│  // === 路径B: TEE结构验证 (独立，不依赖签名者) ===                        │
│  require(teeWhitelist[teePubKey])                                        │
│  attestDigest = keccak256(abi.encode(reportHash, teePubKey))             │
│  require(ecrecover(attestDigest, teeSig) == teePubKey)                   │
│  require(teeReport.eventValid && teeReport.finalityValid)                │
│                                                                         │
│  // === 消息完整性 ===                                                   │
│  require(!consumed[requestID])                                           │
│  require(keccak256(payload) == payloadHash)                              │
│                                                                         │
│  // 两条路径的签名者集合是完全独立的:                                     │
│  //   signer地址集合 ≠ TEE地址                                          │
│  //   攻击者需要同时攻破 ≥3个signer 和 TEE 才能伪造消息                   │
│                                                                         │
│  target.execute(requestID, payload)                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

## 4. 两条路径的独立性分析

### 4.1 签名者路径（路径A）

```
输入: XMsg + consensusMessage + signatures[] (N个ECDSA, 每个65字节)

验证逻辑（链上）:
  signers = new Set()
  for each sig in signatures:
      addr = ecrecover(consensusMessage, sig)
      require(isRegisteredSigner(addr))  // addr必须在链上注册的signer集合中
      signers.add(addr)
  require(signers.size >= threshold)     // 去重后≥3个不同的signer

签名者注册（链上）:
  mapping(address => bool) public registeredSigners;
  // 管理员调用 registerSigner(addr) 添加
  // 与 TEE 的 teeWhitelist 是完全独立的两个 mapping
```

**为什么独立**：
- 签名者地址存储在 `registeredSigners` mapping 中
- TEE 地址存储在 `teeWhitelist` mapping 中
- 两个集合无交集
- 路径A只检查 `registeredSigners`，不检查 `teeWhitelist`
- 即使 TEE 被攻破，攻击者无法向 `registeredSigners` 添加自己的地址（需要管理员权限）

### 4.2 TEE 路径（路径B）

```
输入: XMsg + teeReport + teeSig + teePubKey

TEE 独立验证流程（链下）:
  1. 接收 XMsg（含 txId, blockNumber, eventProof, finalityInfo）
  2. 独立连接 Fabric peer，查询 GetBlockByTxID(txId)
     - 验证交易确实存在且内容匹配
  3. 独立查询 GetBlockByNumber(blockNumber)
     - 验证区块哈希与 finalityInfo.blockHash 一致
  4. 验证 eventProof 结构
     - 重算 eventLeaf → 验证 Merkle 证明 → 验证 eventRoot
     - 验证 payloadHash
  5. 验证 finalityInfo
     - 验证 blockHash 匹配
     - 验证 txValidationCode === 'VALID' (Fabric) 或 commitStatus (EVM)
  6. 生成验证报告 teeReport = { eventValid, finalityValid, blockHash, ... }
  7. 对 attestDigest = keccak256(abi.encode(reportHash, teePubKey)) 签名
  8. 返回 { teePubKey, teeReport, reportHash, teeSig, attestDigest }

验证逻辑（链上）:
  require(teeWhitelist[teePubKey])
  attestDigest = keccak256(abi.encode(reportHash, teePubKey))
  require(ecrecover(attestDigest, teeSig) == teePubKey)
  require(teeReport.eventValid && teeReport.finalityValid)
```

**关键差异**：TEE 不再信任签名者传入的任何数据。TEE 独立连接 Fabric peer 进行验证。签名者被全部攻破后，签名者可以给任意消息签名——但 TEE 会独立查询 Fabric，发现交易不存在或内容不匹配，拒绝签名。

### 4.3 独立性总结

| 威胁场景 | 路径A (签名者共识) | 路径B (TEE) | 攻击是否成功 |
|----------|-------------------|-------------|-------------|
| 攻击者控制 0 个签名者，TEE 正常 | ✅ 通过 | ✅ 通过 | ❌ 无法攻击（正常流程） |
| 攻击者控制 3/4 签名者，TEE 正常 | ❌ 攻击者可让路径A通过（伪造签名） | ✅ 路径B独立验证Fabric，拒绝 | ❌ **被路径B阻止** |
| 攻击者控制全部签名者，TEE 正常 | ❌ 攻击者可让路径A通过 | ✅ 路径B独立验证Fabric，拒绝 | ❌ **被路径B阻止** |
| 攻击者控制 TEE，签名者正常 | ✅ 路径A验证签名者集合，拒绝（攻击者无签名者私钥） | ❌ 攻击者可让路径B通过（TEE被控） | ❌ **被路径A阻止** |
| 攻击者控制 TEE + 3/4 签名者 | ❌ 可通过 | ❌ 可通过 | ⚠️ **攻击成功**（需同时攻破两方） |

## 5. 合约设计

### 5.1 VerifierContractV3.sol

```solidity
contract VerifierContractV3 {
    // === 签名者集合（路径A） ===
    mapping(address => bool) public registeredSigners;
    uint256 public signerCount;
    uint16 public signerThreshold;  // 3 for 3/4
    
    // === TEE 白名单（路径B） ===
    mapping(address => bool) public teeWhitelist;
    
    // === 防重放 ===
    mapping(bytes32 => bool) public consumed;
    
    // === XMsg 结构 ===
    struct XMsg {
        uint8 version;        // 协议版本
        bytes32 requestID;    // 唯一请求标识
        bytes32 srcChainID;   // 源链标识
        bytes32 dstChainID;   // 目标链标识
        bytes32 srcEmitter;   // 源链事件发射者
        address dstContract;  // 目标业务合约
        bytes payload;        // ABI编码的业务负载
        bytes32 payloadHash;  // keccak256(payload)
        uint64 srcHeight;     // 源链区块高度
        bytes eventProof;     // 事件包含证明JSON
        bytes finalityInfo;   // 最终性信息JSON
        uint64 nonce;         // 源链nonce
    }
    
    struct TEEAttestation {
        address teePubKey;
        bytes32 reportHash;      // keccak256(teeReport)
        bytes teeSig;            // TEE对attestDigest的签名
        bool eventValid;         // TEE验证结果
        bool finalityValid;      // TEE验证结果
    }
    
    event Accepted(bytes32 indexed requestID, address indexed tee);

    // ======== 管理员函数 ========

    function registerSigner(address signer) external {
        require(!registeredSigners[signer], "already registered");
        registeredSigners[signer] = true;
        signerCount++;
    }
    
    function removeSigner(address signer) external {
        require(registeredSigners[signer], "not registered");
        registeredSigners[signer] = false;
        signerCount--;
    }
    
    function setThreshold(uint16 t) external {
        require(t > 0 && t <= signerCount, "invalid threshold");
        signerThreshold = t;
    }
    
    function registerTEE(address tee) external {
        teeWhitelist[tee] = true;
    }
    
    function removeTEE(address tee) external {
        teeWhitelist[tee] = false;
    }

    // ======== 验证入口 ========

    function submit(
        XMsg calldata xmsg,
        bytes[] calldata signatures,      // N个ECDSA签名 (每个65字节)
        bytes32 consensusMessage,          // 被签名的共识消息
        TEEAttestation calldata att        // TEE验证报告
    ) external {
        // ==========================================
        // 路径A: 签名者共识验证（独立）
        // ==========================================
        uint256 uniqueSigners = _verifySignerThreshold(
            consensusMessage,
            signatures
        );
        require(uniqueSigners >= signerThreshold,
            "signer threshold not met");
        
        // ==========================================
        // 路径B: TEE结构验证（独立）
        // ==========================================
        require(teeWhitelist[att.teePubKey],
            "TEE not registered");
        
        bytes32 attestDigest = keccak256(
            abi.encode(att.reportHash, att.teePubKey)
        );
        address teeSigner = _recover(attestDigest, att.teeSig);
        require(teeSigner == att.teePubKey,
            "invalid TEE signature");
        
        require(att.eventValid, "event proof invalid");
        require(att.finalityValid, "finality invalid");
        
        // ==========================================
        // 消息完整性
        // ==========================================
        require(!consumed[xmsg.requestID], "replay");
        require(keccak256(xmsg.payload) == xmsg.payloadHash,
            "payload hash mismatch");
        
        // ==========================================
        // 执行
        // ==========================================
        consumed[xmsg.requestID] = true;
        ITargetContract(xmsg.dstContract).execute(
            xmsg.requestID,
            xmsg.payload
        );
        
        emit Accepted(xmsg.requestID, att.teePubKey);
    }
    
    function _verifySignerThreshold(
        bytes32 digest,
        bytes[] calldata signatures
    ) internal view returns (uint256) {
        uint256 count;
        address lastSigner;
        
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(digest, signatures[i]);
            require(registeredSigners[signer], "unknown signer");
            // 简单去重: 要求签名者地址单调递增
            require(signer > lastSigner, "duplicate or unsorted signer");
            lastSigner = signer;
            count++;
        }
        
        return count;
    }
    
    function _recover(
        bytes32 digest,
        bytes memory signature
    ) internal pure returns (address) {
        require(signature.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        return ecrecover(digest, v, r, s);
    }
}
```

## 6. TEE 独立验证流程

```
TEE /attest 端点 (重构后):

输入: { xmsg, consensusMessage }

TEE 不信任传入的任何签名或证明数据。独立执行:

  1. 解析 xmsg 获取 txId, blockNumber, channelName
  
  2. 独立连接 Fabric peer:
     const gateway = new Gateway();
     await gateway.connect(ccp, { wallet, identity, discovery });
     const network = await gateway.getNetwork(channelName);
     
     // 查询交易是否存在
     const block = await network.getChannel().queryBlock(blockNumber);
     // 验证 block.data 中包含 txId
     
     // 验证 blockHash
     const computedBlockHash = sha256(stableStringify(block.header));
     require(computedBlockHash === eventProof.blockHash);
     
     gateway.disconnect();
  
  3. 验证 eventProof 结构:
     - 重算 eventLeaf = keccak256(channelName, chaincodeId, eventName, 
                                     txId, blockNumber, requestID, payloadHash)
     - Merkle 证明验证: verifyMerkleProof(eventLeaf, eventMerkleProof, eventRoot)
     - payloadHash 一致性
  
  4. 验证 finalityInfo:
     - blockHash 与独立查询结果一致
     - commitStatus === 'VALID' (Fabric) 或 'CONFIRMED' (EVM)
  
  5. 生成报告:
     report = {
       proofType: 'hybrid-v2',
       eventValid: true,
       finalityValid: true,
       blockHash: '0x...',
       blockNumber: N,
       timestamp: Date.now()
     }
     
  6. 签名报告:
     reportHash = keccak256(JSON.stringify(report))
     attestDigest = keccak256(abi.encode(reportHash, teePubKey))
     teeSig = sign(attestDigest)
     
  7. 返回: { teePubKey, report, reportHash, teeSig, attestDigest }
```

## 7. 安全命题证明

### 命题1: 签名者全部被攻破 → 系统仍安全

```
假设: 攻击者控制了全部4个signer的私钥
攻击: 攻击者对任意 consensusMessage 产生4个有效ECDSA签名
      路径A在链上验证通过（ecrecover恢复出4个已注册signer）
防御: 路径B — TEE独立连接Fabric peer查询
      - TEE查询 GetBlockByTxID → 交易不存在或内容不匹配
      - TEE拒绝签名，或签名的报告中 eventValid=false
      - 链上路径B验证: require(teeReport.eventValid) → revert
结论: ✅ 攻击被TEE路径阻止
```

### 命题2: TEE被攻破 → 系统仍安全

```
假设: 攻击者控制了TEE的私钥
攻击: 攻击者对任意 reportHash 产生有效TEE签名
      路径B在链上验证通过（ecrecover恢复出TEE地址在白名单中）
防御: 路径A — 签名者独立签名
      - 每个signer在签名前独立查询Fabric peer确认交易存在
      - 攻击者无法让≥3个signer对伪造的 consensusMessage 签名
      - 链上路径A验证: uniqueSigners < threshold → revert
结论: ✅ 攻击被签名者路径阻止
```

### 命题3: 两条路径无共享信任

```
签名者地址集合 ∩ TEE地址集合 = ∅
registeredSigners[addr] 与 teeWhitelist[addr] 是两个独立的 mapping
攻击者获得TEE私钥 ≠ 获得signer私钥
攻击者获得3个signer私钥 ≠ 获得TEE私钥
需要同时攻破两方才能伪造消息
```

## 8. 与当前实现的差异

| 维度 | 当前 V2 | 新设计 V3 |
|------|---------|----------|
| 签名者路径链上验证 | ❌ 仅检查 ValidatorSet.active 标志位 | ✅ 逐条 ecrecover + 阈值计数 |
| TEE 路径链上验证 | ✅ ecrecover attestDigest | ✅ 同 V2 |
| TEE 独立查询源链 | ❌ 信任传入的 blsProof 数据 | ✅ TEE 独立连接 Fabric peer |
| 签名方案（链下） | BLS12-381 聚合 | BLS12-381 聚合（不变） |
| 签名方案（链上） | 无 | ECDSA secp256k1（ecrecover） |
| Validator 密钥 | 仅 BLS | ECDSA + BLS 双密钥 |
| Gas 成本 | ~500k | ~500k + ~12k (ECDSA验证) |
| 信任模型 | TEE 单点 + ValidatorSet 存在性 | 签名者共识 ⊕ TEE 结构，双重独立 |

## 9. 实现路线图

### Phase 1: Validator ECDSA 密钥
1. 在 `validator-set.js` 中为每个 validator 新增 ECDSA 密钥派生
2. 在 `validator-node/server.js` 新增 `/sign-ecdsa` 端点
3. Validator 同时持有 ECDSA + BLS 两套密钥

### Phase 2: 合约 V3
1. 新增 `VerifierContractV3.sol`
2. 实现 `_verifySignerThreshold()` — 链上 ECDSA 逐条验证 + 去重
3. 分离 `registeredSigners` 和 `teeWhitelist` 两个 mapping
4. 部署 + 注册 4 个 signer + TEE 地址

### Phase 3: TEE 独立验证
1. 重构 `tee-verifier/server.js` 的 `/attest` 端点
2. TEE 内置 Fabric Gateway 客户端，独立连接 peer 查询
3. 移除对传入 blsProof 的信任

### Phase 4: Relayer 适配
1. 收集 N 个 ECDSA 签名（从 aggregator 或逐个请求 validator）
2. 组装 `signatures[]` + `teeAttestation`
3. 提交到 VerifierContractV3

### Phase 5: 测试与迁移
1. 单元测试：单路径被攻破场景
2. 集成测试：双路径正常 + 异常场景
3. 从 V2 迁移到 V3
