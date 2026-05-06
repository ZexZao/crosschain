# 多签 + TEE 混合跨链桥设计方案

## 1. 当前系统的冗余分析

### 1.1 当前验证链路

```
源链事件
  ↓
4×Validator 各自查peer确认 → ECDSA签名(×4)
  ↓
Aggregator 收集≥3个ECDSA签名 → consensusProof(含全部N个sig)
  ↓
TEE 逐条恢复4个ECDSA签名 → 重算validatorSetHash → 验阈值
  → 验eventProof → 验finalityInfo → 全部通过后TEE重新ECDSA签名
  ↓
VerifierContract 只验TEE的1个签名 → 执行
```

### 1.2 冗余点

| # | 位置 | 问题 |
|---|------|------|
| 1 | TEE内 `verifyConsensusProof` | 逐条恢复N个ECDSA签名，通过后又用TEE密钥重签。验证工作量O(N)，但聚合证明刚在同一台机器生成 |
| 2 | 链上 `VerifierContract` | 只信任TEE单签名，共识证明(N个validator签名)完全不触达链上——TEE成了**唯一信任根** |
| 3 | `validator-set.js` | 4个签名地址以明文JSON传递，TEE逐个比对；validator公钥集合未上链，TEE无法知道自己拿到的validator-set是否被篡改 |
| 4 | 模拟TEE | `tee-verifier/server.js` 是软件进程，`ethers.Wallet.createRandom()` 生成密钥——没有硬件级隔离，TEE签名和validator签名在**同一信任域** |

### 1.3 根因

> **共识证明与TEE背书是串行叠加，而非并行制约。** TEE验证了共识 → 链上只信TEE → 共识证明失去了独立安全价值。

---

## 2. 设计目标

### 2.1 核心原则

```
混合桥的安全公式:
  链上合约 = 多签共识证明 ⊕ TEE结构证明

⊕ = 两者都必须验证通过，任一不可绕过
```

- **多签共识证明**：证明"≥阈值个源链验证者独立确认了该事件存在"
- **TEE结构证明**：证明"跨链消息的eventProof、payloadHash、finalityInfo在结构上自洽"
- **链上合约同时验证两者**，任一失败则整条消息拒收

### 2.2 改进清单

| 当前问题 | 改进方案 |
|----------|----------|
| ECDSA逐个签名 O(N) 验证 | **BLS聚合签名**，N个签名聚合为1个96字节，验证O(1) |
| TEE重签后链上只信TEE | **链上同时验BLS聚合 + TEE签名**，双重约束 |
| Validator集合不在链上 | **Validator公钥集合锚定到链上合约**，TEE也从链上读取 |
| 软件TEE无硬件隔离 | 架构预留**远程证明(RA)**接口，当前用软件模拟，接口不变 |
| proofType字段自由文本 | 定义**结构化证明类型枚举**，消除字符串匹配 |

---

## 3. 新架构总览

### 3.1 组件关系

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           源链 (Fabric / EVM)                           │
│   chaincode 发射事件 ──→ Listener 捕获 (txId, blockHeader, payload)     │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Proof Builder (proof-builder/)                      │
│   构造 XMsg + eventProof(含Merkle) + finalityInfo                        │
│   ⚠ 此时没有共识证明 — 共识与证明构造解耦                                 │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                              ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────┐
│    共识聚合器 (重构)          │  │        TEE验证器 (重构)               │
│                              │  │                                      │
│  BLS validator 集合          │  │  ① 从链上读取 validator 公钥集合      │
│  (每个validator持BLS私钥)    │  │  ② 验证 eventProof (Merkle)          │
│  对 (eventRoot,payloadHash)  │  │  ③ 验证 finalityInfo                 │
│  签名并用BLS聚合为1个sig     │  │  ④ 验证 BLS聚合签名                   │
│                              │  │  ⑤ 生成结构验证报告并TEE签名          │
│  输出: blsAggregateProof     │  │  输出: teeAttestation                │
└──────────────┬───────────────┘  └─────────────────┬────────────────────┘
               │                                    │
               │    ┌───────────────────────────────┘
               │    │
               ▼    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Relayer (relayer/)                               │
│   组装: XMsg + blsAggregateProof + teeAttestation                        │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  目标链 VerifierContract (重构)                           │
│                                                                         │
│  ① 验 BLS聚合签名 (证明≥阈值validator确认)                                │
│  ② 验 TEE签名 (证明eventProof结构自洽)                                    │
│  ③ 验 payloadHash                                                       │
│  ④ 验 防重放 (consumed + ctr + continuity)                               │
│  ⑤ 全部通过 → 调用 TargetContract                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 关键变化：共识与TEE不再是串行

```
旧: Validator → Aggregator → TEE(重验全部) → Chain(只信TEE)
                               ↑
                         共识证明在TEE内被"消费"掉，
                         链上完全看不到

新: Validator → Aggregator ──→ Chain(直接验BLS聚合)
                TEE ──────────→ Chain(验TEE结构证明)
                          ↑
                    两者并行提交到链上，合约同时验证
                    任一失败则拒收
```

---

## 4. 核心组件详细设计

### 4.1 BLS 签名方案选择

| 参数 | 选择 | 理由 |
|------|------|------|
| 曲线 | **BLS12-381** | 安全性128-bit，标准成熟，`@noble/curves` 纯JS支持 |
| 聚合方式 | **基本聚合** (同一消息) | 所有validator对同一个 `consensusMessage` 签名 |
| 密钥派生 | 延用当前确定性派生 `keccak256("crosschain-validator:"+label)`，但映射到BLS域 | 保持与现有ECDSA身份一致 |
| DKG | **不做** | 原型阶段用独立密钥聚合，不引入分布式密钥生成 |

**签名消息定义**（替代当前 `computeConsensusMessage`）：

```
consensusMessage = keccak256(
    abi.encode(
        ["string","uint64","bytes32","bytes32","bytes32","bytes32","string"],
        [channelName, blockNumber, blockHash, eventRoot,
         requestID, payloadHash, validatorSetId]
    )
)
```

**Node.js 侧实现** (`shared/bls.js`):

```javascript
const { bls12_381: bls } = require('@noble/curves/bls12-381');

// 从确定性种子派生BLS密钥
function deriveBlsKey(seedLabel) {
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`crosschain-validator:${seedLabel}`)
  );
  return bls.getPublicKey(seed);  // 32字节私钥seed → 48字节公钥
}

// 签名
function blsSign(seedLabel, messageHash) {
  const seed = ethers.keccak256(
    ethers.toUtf8Bytes(`crosschain-validator:${seedLabel}`)
  );
  return bls.sign(messageHash, seed);
}

// 聚合签名 (N个 → 1个)
function blsAggregate(signatures) {
  return bls.aggregateSignatures(signatures);
}

// 验证聚合签名 (1次配对操作)
function blsVerifyAggregate(pubkeys, messageHash, aggregateSig) {
  return bls.verify(aggregateSig, messageHash, pubkeys);
}
```

### 4.2 共识聚合器重构 (`consensus-aggregator/index.js`)

**变化**：不再返回ECDSA签名数组，而是返回单一BLS聚合签名。

```javascript
async function buildBlsConsensusAggregate({
    channelName, blockNumber, blockHash, eventRoot,
    requestID, payloadHash
}) {
    const validatorSet = getTrustedValidatorSet(channelName);
    const validatorSetId = validatorSet.validatorSetId;

    const consensusMessage = computeConsensusMessage({
        channelName, blockNumber, blockHash, eventRoot,
        requestID, payloadHash: ethers.keccak256(payloadHex),
        validatorSetId
    });

    // 请求各validator签名
    const sigResults = await Promise.allSettled(
        validatorSet.validators.map(v =>
            requestValidatorBlsSignature(v, {
                validatorSetId, ...common, consensusMessage
            })
        )
    );

    const sigs = sigResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value.blsSignature);

    if (sigs.length < validatorSet.threshold) {
        throw new Error(
            `BLS threshold not met: ${sigs.length}/${validatorSet.threshold}`
        );
    }

    // BLS聚合：N个sig → 1个96字节
    const aggregateSig = blsAggregate(sigs);

    return {
        validatorSetId,
        threshold: validatorSet.threshold,
        aggregateSig,                          // 单一聚合签名 (96 bytes hex)
        validatorPubkeys: validatorSet.validators.map(v => v.blsPubkey),
        consensusMessage                       // 被签名的消息
    };
}
```

### 4.3 Validator节点变化

每个validator在原有ECDSA签名基础上，新增BLS签名端点：

```
POST /bls-sign
Body: { consensusMessage, txId, ... }
Response: { blsSignature, blsPubkey }
```

BLS签名前**仍然做peer查询**确认交易存在（保留peer-binding安全机制）。

### 4.4 TEE验证器重构 (`tee-verifier/server.js`)

**核心变化**：
- 不再逐个恢复N个ECDSA签名
- 改为一次性验证BLS聚合签名
- 不再维护独自的state连续性（移到链上合约）

```javascript
app.post('/attest', async (req, res) => {
    // 输入: XMsg + blsAggregateProof
    const { xmsg, blsProof } = req.body;

    // 1. 验证 eventProof 结构完整性
    const eventStatus = validateEventProof(xmsg);
    //    - requestID / payloadHash / srcHeight 一致性
    //    - eventLeaf 重算 → Merkle 验证
    //    - txValidationCode === 'VALID'

    // 2. 验证 finalityInfo
    const finalityStatus = validateFinalityInfo(xmsg);
    //    - blockHash 有效性
    //    - eventProof.blockHash === finalityInfo.blockHash

    // 3. 验证 BLS 聚合签名 (O(1) 配对操作)
    const blsValid = blsVerifyAggregate(
        blsProof.validatorPubkeys,
        blsProof.consensusMessage,
        blsProof.aggregateSig
    );

    if (!blsValid) {
        throw new Error('BLS aggregate signature invalid');
    }

    // 4. 生成结构验证报告
    const report = {
        proofType: 'hybrid-v1',
        eventValid: eventStatus,
        finalityValid: finalityStatus,
        blsValid: true,
        validatorSetId: blsProof.validatorSetId,
        threshold: blsProof.threshold,
        timestamp: Date.now()
    };

    // 5. TEE对报告签名
    const reportHash = keccak256(JSON.stringify(report));
    const teeSig = teeWallet.signingKey.sign(reportHash).serialized;

    res.json({
        teePubKey: teeWallet.address,
        teeReport: report,
        teeSig
    });
});
```

**关键变化**：TEE不再签名跨链消息本身，而是签名**验证报告**（report）。这使TEE的角色从"消息背书者"变为"证明结构验证者"。

### 4.5 链上合约重构 (`VerifierContract.sol`)

**核心变化**：合约同时验证BLS聚合签名-TEE报告，双重约束。

```solidity
contract VerifierContractV2 {
    // --- BLS Validator Set (锚定在链上) ---
    struct ValidatorSet {
        bytes32 setId;
        uint16 threshold;
        bytes[] blsPubkeys;  // BLS12-381 公钥 (48 bytes each)
    }

    mapping(bytes32 => ValidatorSet) public validatorSets;
    mapping(address => bool) public teeWhitelist;

    // --- 防重放 ---
    mapping(bytes32 => bool) public consumed;

    // --- 连续性 (原TEE state移到链上) ---
    uint64 public ctr;
    bytes32 public lastDigest;

    event Accepted(bytes32 indexed requestID, address tee, uint64 ctr);

    // --- 验证入口 ---
    function submit(
        XMsg calldata xmsg,
        BlsProof calldata blsProof,      // 新增: BLS聚合证明
        TEEAttestation calldata att        // 重构: TEE验证报告而非简单签名
    ) external {
        // ======== 第一重: TEE结构验证 ========
        require(teeWhitelist[att.teePubKey], "TEE not registered");
        require(
            keccak256(abi.encode(att.report)) == att.reportHash,
            "bad tee report"
        );
        address teeSigner = ecrecover(att.digest, att.teeSig);
        require(teeSigner == att.teePubKey, "invalid tee sig");

        // ======== 第二重: BLS共识验证 ========
        // 在链上验证BLS聚合签名 (需要bn254 precompile)
        // 或在使用bn254的L2上验证
        bool blsValid = verifyBlsAggregate(
            blsProof.validatorPubkeys,
            blsProof.consensusMessage,
            blsProof.aggregateSig
        );
        require(blsValid, "BLS aggregate invalid");

        // 验validatorSetId匹配
        require(
            blsProof.validatorSetId == att.report.validatorSetId,
            "validator set mismatch"
        );

        // ======== 第三重: 消息完整性 ========
        require(!consumed[xmsg.requestID], "replay");
        require(
            keccak256(xmsg.payload) == xmsg.payloadHash,
            "payload hash mismatch"
        );

        // ======== 第四重: 连续性 ========
        require(att.report.proofType == "hybrid-v1", "bad proof type");
        require(att.report.eventValid, "event proof invalid");
        require(att.report.finalityValid, "finality invalid");

        // --- 状态更新 ---
        consumed[xmsg.requestID] = true;
        ctr += 1;
        lastDigest = att.digest;

        // --- 执行 ---
        ITargetContract(xmsg.dstContract).execute(
            xmsg.requestID, xmsg.payload
        );
        emit Accepted(xmsg.requestID, att.teePubKey, ctr);
    }
}
```

### 4.6 数据结构定义

```javascript
// shared/types.js - 统一类型定义

const ProofType = {
    HYBRID_V1: 'hybrid-v1',     // BLS聚合 + TEE结构证明
    SIMULATED: 'simulated-v1',   // 纯模拟 (向后兼容)
};

// BLS聚合证明
// {
//   validatorSetId: "fabric-mychannel-v1",
//   threshold: 3,
//   aggregateSig: "0x..." (96 bytes),
//   validatorPubkeys: ["0x...", "0x...", "0x...", "0x..."],
//   consensusMessage: "0x..." (32 bytes)
// }

// TEE证明报告
// {
//   teePubKey: "0x...",
//   report: {
//     proofType: "hybrid-v1",
//     eventValid: true,
//     finalityValid: true,
//     blsValid: true,
//     validatorSetId: "fabric-mychannel-v1",
//     threshold: 3,
//     timestamp: 1715000000000
//   },
//   reportHash: "0x...",
//   teeSig: "0x...",
//   digest: "0x..."
// }
```

---

## 5. 完整验证时序

```
┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────┐  ┌───────────┐
│Fabric   │  │Validator │  │Aggregator │  │TEE  │  │Verifier   │
│Peer     │  │Node (×4) │  │           │  │     │  │Contract   │
└────┬────┘  └────┬─────┘  └─────┬─────┘  └──┬──┘  └─────┬─────┘
     │            │               │            │            │
     │ XCALL evt  │               │            │            │
     │───────────→│               │            │            │
     │            │               │            │            │
     │            │ ①查peer确认tx │            │            │
     │←──────────│               │            │            │
     │            │               │            │            │
     │            │ ②BLS签名请求  │            │            │
     │            │──────────────→│            │            │
     │            │               │            │            │
     │            │               │ ③BLS聚合   │            │
     │            │               │ (N→1 sig)  │            │
     │            │               │            │            │
     │            │               │  ④blsProof │            │
     │            │               │──────────────────────→│
     │            │               │            │  TEE attest│
     │            │               │            │←───────────│
     │            │               │            │            │
     │            │               │  ⑤XMsg + blsProof      │
     │            │               │     + teeReport + teeSig│
     │            │               │────────────────────────→│
     │            │               │            │            │
     │            │               │            │  ⑥链上双重验证:
     │            │               │            │  · 验BLS聚合
     │            │               │            │  · 验TEE签名
     │            │               │            │  · 验report内容
     │            │               │            │  · 验防重放
     │            │               │            │            │
     │            │               │            │  ⑦execute →│
     │            │               │            │            │
```

---

## 6. 安全分析

### 6.1 威胁模型

| 攻击场景 | 纯多签桥 | 纯TEE桥 | **混合桥(本设计)** |
|----------|----------|---------|-------------------|
| 攻击者控制 <阈值 个validator | ✅安全 | N/A | ✅安全 (BLS签名不足) |
| 攻击者控制 ≥阈值 个validator | ❌伪造消息 | N/A | ✅ **TEE仍拒签** (eventProof结构不会自动有效) |
| TEE软件被攻破 | N/A | ❌全桥崩溃 | ✅ **BLS共识仍有效** (链上直接验聚合签名) |
| 攻击者重放旧消息 | 依赖nonce | 依赖nonce | ✅ consumed mapping + ctr |
| 攻击者伪造eventProof | 多签不覆盖 | 仅TEE验 | ✅ **TEE验结构 + 链上验TEE报告** |
| 中继节点篡改消息 | 验签名即可 | 验签名即可 | ✅ 双重签名覆盖 |

### 6.2 关键安全命题

**命题1: 多签与TEE互相制约**
> 若validator被攻破(≥threshold) → TEE不通过(结构验证独立于签名数量)
> 若TEE被攻破 → 链上仍验BLS聚合签名(validator未攻破则无法伪造)
> 两者**同时**被攻破才能伪造消息

**命题2: 安全不依赖于TEE的硬件性质**
> 即使TEE是软件模拟(当前状态)，BLS共识证明在链上的独立验证
> 仍提供了与纯多签桥同等级别的安全保证。TEE的目的是**降低链上验
> 证成本**和**增加事件结构验证**，而非替代共识证明。

**命题3: Validator集合的链上锚定**
> validator公钥集合存储在VerifierContract中，
> TEE从链上读取(而非从aggregator传入)，
> 防止aggregator被攻破后替换validator集合。

---

## 7. 与当前项目的差异对比

| 维度 | 当前实现 | 新设计 |
|------|----------|--------|
| 签名方案 | ECDSA ×4 (每个64byte) | BLS聚合 ×1 (96byte) |
| TEE重验成本 | O(N) 逐个恢复ECDSA | O(1) 单次BLS配对验证 |
| 链上验什么 | 仅TEE签名 | **BLS聚合 + TEE报告** |
| Validator集合位置 | 硬编码在 `validator-set.js` | **锚定在链上合约** |
| TEE签名的对象 | 整个XMsg | **验证报告** (TEE只证结构，不证共识) |
| 信任模型 | TEE是单一信任根 | **多签+TEE双重约束** |
| TEE state (ctr/lastDigest) | 在TEE本地JSON | **移到链上合约** |
| proofType | `"fabric-v2"` 字符串 | `"hybrid-v1"` 枚举 |

---

## 8. 实现路线图

### Phase 1: BLS基础设施 (不改变现有架构)

1. 安装 `@noble/curves`
2. 新增 `shared/bls.js` — BLS密钥派生、签名、聚合、验证
3. 新增 `consensus-aggregator/bls-client.js` — BLS签名请求
4. 在 `validator-node/server.js` 新增 `POST /bls-sign` 端点
5. 单元测试：4个validator签名 → 聚合 → 验签

**此阶段BLS与ECDSA并存，不影响现有链路。**

### Phase 2: TEE验证器重构

1. 重构 `tee-verifier/server.js`：
   - 新端点 `POST /attest` 验证 BLS聚合 + eventProof + finalityInfo
   - 删除 `verifyConsensusProof` (ECDSA逐个恢复逻辑)
   - 保留 `POST /verify-sign` 向后兼容旧路径
   - TEE state (ctr/lastDigest) 移到链上
2. 新增 `shared/tee-report.js` — TEE报告结构定义与哈希

### Phase 3: 链上合约升级

1. 新增 `contracts/VerifierContractV2.sol`:
   - ValidatorSet管理 (setValidatorSet)
   - BLS聚合验证 (bn254 precompile)
   - TEE whitelist + 报告验证
   - submit() 双重验证入口
2. 部署脚本更新
3. 新旧合约共存，通过deploy选择版本

### Phase 4: 联调与切换

1. Proof builder 更新 — 输出新格式 (blsProof + teeAttestation)
2. Relayer 更新 — 组装新格式提交
3. Fabric test suite 针对 hybrid-v1 路径重跑
4. 旧 `fabric-v2` 路径标记为 deprecated

---

## 9. 关键文件清单 (新增/修改)

| 文件 | 状态 | 说明 |
|------|------|------|
| `shared/bls.js` | **新增** | BLS密钥、签名、聚合、验证 |
| `shared/types.js` | **新增** | 证明类型枚举 |
| `shared/tee-report.js` | **新增** | TEE报告结构 |
| `consensus-aggregator/bls-client.js` | **新增** | BLS签名请求客户端 |
| `consensus-aggregator/index.js` | 修改 | 新增 `buildBlsConsensusAggregate()` |
| `validator-node/server.js` | 修改 | 新增 `POST /bls-sign` |
| `evm-validator-node/server.js` | 修改 | 新增 `POST /bls-sign` |
| `tee-verifier/server.js` | **重构** | 新 `/attest` 端点，删除ECDSA逐个验证 |
| `contracts/VerifierContractV2.sol` | **新增** | 双重验证合约 |
| `contracts/TargetContract.sol` | 不变 | 业务合约无需改动 |
| `relayer/index.js` | 修改 | 组装BLS+TEE双证明 |
| `proof-builder/fabric-proof-builder.js` | 修改 | 解耦共识证明构造 |
| `scripts/deploy.js` | 修改 | 部署V2合约+注册validator集合 |
