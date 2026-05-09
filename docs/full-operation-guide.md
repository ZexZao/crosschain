# 项目运行全流程详解

## 目录

1. [系统概览](#1-系统概览)
2. [XMsg 结构](#2-xmsg-结构)
3. [正向流程：Fabric → EVM](#3-正向流程fabric--evm)
4. [闭环流程：Fabric → EVM → Fabric ACK](#4-闭环流程fabric--evm--fabric-ack)
5. [签名者共识：签署内容与 MPC-TSS 聚合](#5-签名者共识签署内容与-mpc-tss-聚合)
6. [TEE 验证：Fabric 路径](#6-tee-验证fabric-路径)
7. [TEE 验证：EVM 路径](#7-tee-验证evm-路径)
8. [链上双重验证](#8-链上双重验证)

---

## 1. 系统概览

### 1.1 参与组件

```
┌──────────────────────────────────────────────────────────────┐
│                        源链 (Fabric)                          │
│                                                                │
│  chaincode(xcall) ──── EmitXCall(payloadJson)                 │
│       │                                                        │
│       │ XCALL 事件 (txId, blockNumber, blockHeader, payload)   │
│       ▼                                                        │
│  fabric-listener  ───  捕获事件，写入 fabric-captured-event.json │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────────────┐
│                    Proof Builder (v3-proof-builder.js)         │
│                                                                │
│  ① 标准化业务负载 → ABI编码 → createBaseXmsg()                  │
│  ② 生成 requestID = keccak256(namespace, nonce, srcHeight)    │
│  ③ 请求 consensus-aggregator 收集签名                           │
└───────────────┬──────────────────────────────────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌─────────┐ ┌──────┐ ┌──────────────────────────┐
│validator│ │TEE   │ │consensus-aggregator       │
│node-1~4 │ │server│ │/mpc-aggregate             │
│         │ │/attest│ │collects N sigs → 1 MPC sig│
│/mpc-sign│ │       │ │                           │
└────┬────┘ └──┬────┘ └────────────┬──────────────┘
     │         │                   │
     │  每个验证者查peer确认        │  选主签名者作为MPC组合签名
     │  → 签名 consensusMessage    │  → 返回 mpcSignature + mpcPubkey
     │         │                   │
     └─────────┼───────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────┐
│                       Relayer (relayer/index.js)               │
│                                                                │
│  ① TEE /attest → attestation { teeSig, reportHash, ... }      │
│  ② VerifierContractV3MPC.submit(                               │
│       XMsg, mpcSignature, consensusMessage,                    │
│       teePubKey, reportHash, teeSig                            │
│     )                                                          │
└───────────────────────┬──────────────────────────────────────┘
                        ▼
┌──────────────────────────────────────────────────────────────┐
│            目标链 EVM (VerifierContractV3MPC)                  │
│                                                                │
│  路径A: ecrecover(consensusMessage, mpcSignature)              │
│         == signerPubkey ?   ← 单次 MPC 签名验证                │
│  路径B: ecrecover(attestDigest, teeSig) == teePubKey ?         │
│         teeWhitelist[teePubKey] ?                              │
│  → TargetContract.execute(requestID, payload)                 │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 容器拓扑

共 18 个 Docker 容器，分为 Fabric 侧（13）和 EVM 侧（5），详见 README。

---

## 2. XMsg 结构

### 2.1 链上字段（ABI 编码提交到合约）

| 序号 | 字段 | Solidity 类型 | 说明 |
|------|------|-------------|------|
| 1 | `version` | `uint8` | 协议版本，固定 `1` |
| 2 | `chainType` | `uint8` | `0`=Fabric, `1`=EVM |
| 3 | `finalityModel` | `uint8` | `0`=BFT即时, `1`=概率 |
| 4 | `requiredConfirmations` | `uint16` | Fabric=`1`, EVM=`6` |
| 5 | `requestID` | `bytes32` | 全局唯一请求标识 |
| 6 | `srcChainID` | `bytes32` | 源链标识 |
| 7 | `dstChainID` | `bytes32` | 目标链标识 |
| 8 | `srcEmitter` | `bytes32` | 源链事件发射者 |
| 9 | `dstContract` | `address` | 目标合约地址 |
| 10 | `payload` | `bytes` | ABI 编码业务负载 |
| 11 | `payloadHash` | `bytes32` | keccak256(payload) |
| 12 | `srcHeight` | `uint64` | 源链区块高度 |
| 13 | `nonce` | `uint64` | 源链交易序号 |

**ABI Tuple**: `(uint8, uint8, uint8, uint16, bytes32, bytes32, bytes32, bytes32, address, bytes, bytes32, uint64, uint64)`

### 2.2 链下字段（不进入合约）

| 字段 | 说明 |
|------|------|
| `txId` | 源链交易原始 ID，TEE 用它做独立源链查询 |
| `createdAt` | ISO 8601 创建时间 |
| `payloadDecoded` | 解码后的可读对象 |
| `teePubKey` | TEE 以太坊地址 |
| `mpcProof` | MPC-TSS 证明数据 |
| `proofMeta` | 元数据 |

### 2.3 业务负载的标准化

源链原始 JSON 负载经过 `normalizeBusinessPayload()` 标准化：

```json
{
  "op": "asset_lock",
  "recordId": "FABRIC-ASSET-0001",
  "actor": "org1.userA",
  "amount": "128.50",
  "metadata": "{\"op\":\"asset_lock\",\"assetId\":\"...\",\"owner\":\"...\"}",
  "requireAck": true
}
```

然后 ABI 编码为 `(string, string, string, string, string, bool)`，存入 `payload` 字段。`payloadHash = keccak256(payload)`。

---

## 3. 正向流程：Fabric → EVM

### 第 1 步：Fabric 链码发射事件

```
docker exec fabric-tools bash invoke-xcall.sh
  → peer chaincode invoke -n xcall -c '{"function":"EmitXCall","Args":["<payloadJson>"]}'
  → chaincode EmitXCall() 执行:
    - 自增 nonce
    - 写入世界状态: xcall:<txId> = eventPayload
    - setEvent('XCALL', eventPayload)
    - 返回 { ok: true, txId, nonce }
```

链码在 `eventPayload` 中自动附加 `fabricTxId`, `fabricNonce`, `emittedAt` 字段。

### 第 2 步：Fabric Listener 捕获事件

```
fabric-listener (容器内运行 fabric-listener.js)
  → Gateway.connect(ccp) 监听 mychannel/xcall:XCALL
  → 收到 ContractEvent:
    - 提取 txId, blockNumber, blockHeader
    - 提取 rawPayload (业务 JSON)
    - 尝试提取 signedBlockBytes (原始区块 protobuf)
    - mapCapturedEvent() → writeJSON('fabric-captured-event.json')
```

捕获的数据结构 `fabric-captured-event.json`：

```json
{
  "channelName": "mychannel",
  "chaincodeId": "xcall",
  "eventName": "XCALL",
  "rawPayload": { "op": "...", "recordId": "...", ... },
  "txId": "abc123...",
  "blockNumber": 500,
  "nonce": 123,
  "blockHeader": { "number": 500, "previousHash": "", "dataHash": "" },
  "txValidationCode": "VALID",
  "signedBlockBytes": ""  // SDK 不总是暴露原始区块字节
}
```

### 第 3 步：Proof Builder 构造 XMsg

```
buildXmsgMpc({ deployment, channelName, chaincodeId, rawPayload, txId, blockNumber, nonce })
  ↓
① createBaseXmsg() — 基础 XMsg
  - 标准化负载: normalizeBusinessPayload(rawPayload)
    → { op, recordId, actor, amount, metadata, requireAck }
  - ABI 编码: ethers.AbiCoder.encode(['string','string','string','string','string','bool'], ...)
    → payloadHex
  - payloadHash = keccak256(payloadHex)
  - requestID = keccak256(abi.encodePacked("fabric-mychannel-<txId>", nonce, blockNumber))
  - srcChainID = keccak256("fabric-mychannel")
  - dstChainID = keccak256("evm-31337")
  - srcEmitter = keccak256("xcall")
  - dstContract = deployment.targetContract
  - chainType = 0 (Fabric)
  - finalityModel = 0 (BFT)
  - requiredConfirmations = 1

② requestMpcConsensusAggregate() — 请求签名者签名
  → POST /mpc-aggregate 到 consensus-aggregator
  → 详见第 5 节

③ 组装返回:
  XMsg = { ...base, mpcProof, proofMeta, teePubKey: ZeroAddress }
```

### 第 4 步：TEE 独立源链验证

```
POST /attest → tee-verifier/server.js
  
输入: { xmsg, blsProof: null, blockData: xmsg._blockData }

① 识别链类型
  xmsg.chainType === 0 → Fabric 路径
  xmsg.chainType === 1 → EVM 路径

② Fabric 验证（详见第 6 节）

③ 构建验证报告
  report = {
    proofType: 'hybrid-v3-mpc',
    verificationMode: 'fabric',
    sourceVerified: true,
    blockNumber: verifiedBlockNumber,
    payloadHash: xmsg.payloadHash,
    signatureScheme: 'mpc-tss'
  }

④ TEE 签名报告
  reportJson = JSON.stringify(report)
  reportHash = keccak256(reportJson)
  attestDigest = keccak256(abi.encode(reportHash, teePubKey))
  teeSig = ecdsa_sign(attestDigest, teePrivateKey)

⑤ 返回: { teePubKey, teeReport, reportHash, teeSig, attestDigest }
```

### 第 5 步：Relayer 组装并提交到合约

```
relayer/index.js (V3MPC 路径)

① TEE /attest → attestation

② 合约前置设置:
  - 如果 teeWhitelist[teePubKey] 为空 → registerTEE(teePubKey)
  - 如果 signerPubkey == 0x0 → setSignerPubkey(xmsg.mpcProof.pubkey)

③ 提交:
  VerifierContractV3MPC.submit(
    // XMsg tuple (13 fields)
    [version, chainType, finalityModel, requiredConfirmations,
     requestID, srcChainID, dstChainID, srcEmitter,
     dstContract, payload, payloadHash, srcHeight, nonce],
    // 路径A: MPC single signature
    mpcProof.signature,       // 65 bytes ECDSA
    mpcProof.consensusMessage, // 32 bytes
    // 路径B: TEE attestation
    teePubKey,
    reportHash,
    teeSig
  )
```

### 第 6 步：合约验证与执行

详见第 8 节。

---

## 4. 闭环流程：Fabric → EVM → Fabric ACK

闭环在正向的基础上增加了 ACK 回传。以下是 ACK 部分的详细流程。

### 第 4-1 步：EVM 执行业务并发射 ACK 事件

```
VerifierContractV3MPC.submit() 通过后:
  → TargetContract.execute(requestID, payload)
  → decodePayload → 提取 { op, recordId, actor, amount, requireAck }
  → 如果 requireAck == true:
    - 保存执行记录
    - emit BusinessExecuted(requestID, caller, op, recordId, actor, amount, true)
```

### 第 4-2 步：从 EVM 收据构建 ACK XMsg

```
buildAckXmsg(relayTxHash)  // run-full-suite.js / run-mpc-roundtrip.js

① provider.getTransactionReceipt(relayTxHash)
  → 获取 EVM 交易回执

② 在 receipt.logs 中查找 BusinessExecuted 事件
  → 解析 requireAck 字段
  → 如果 requireAck == false → 跳过 ACK

③ 构建 ACK XMsg:
  rawPayload = {
    op: 'ack_confirm',
    originRequestID: parsed.args.requestID,  // 原始请求ID
    status: 'success',
    relayTxHash,
    targetOp: parsed.args.op,
    targetRecordId: parsed.args.recordId,
    targetActor: parsed.args.actor,
    targetAmount: parsed.args.amount,
    requireAck: false  // ACK本身不需要ACK
  }

④ buildXmsgFromEvmEventV3() — 构建 EVM 侧的 XMsg:
  - chainType = 1 (EVM)
  - finalityModel = 1 (概率)
  - requiredConfirmations = 6
  - srcHeight = receipt.blockNumber
  - txId = receipt.hash (0x 前缀的 EVM txHash)
  - srcChainID = keccak256("evm-31337")
  - dstChainID = keccak256("fabric-mychannel")

⑤ requestV3ConsensusAggregate() — EVM 验证者签名
  → 4 个 EVM validator 签名 consensusMessage
```

### 第 4-3 步：ACK 中继到 Fabric

```
ack-relay-daemon.js (运行在 fabric-listener 容器内)

① POST /relay-ack → relayAck(ackXmsg)
② TEE /attest → 验证 EVM 交易存在（详见第 7 节）
③ Fabric Gateway → contract.submitTransaction('ConfirmAckXMsg', xmsg, voucher)
④ Fabric 链码:
  - 验证 TEE attestation
  - 更新 world state: ack:<originRequestID> = { originRequestID, status, updatedAt }
  - emit XACK_CONFIRMED
  - 返回 { ok: true, originRequestID, status: 'success' }
```

### 第 4-4 步：源链查询 ACK 状态

```
Fabric chaincode:
  GetAckStatus(originRequestID)
  → 查询 world state: ack:<originRequestID>
  → 返回 { originRequestID, status: 'success' }
```

---

## 5. 签名者共识：签署内容与 MPC-TSS 聚合

### 5.1 签名者签署的内容

签名者签署的是一个 `consensusMessage`（共识消息），它是对以下字段的哈希：

```javascript
// 在共识聚合器内计算
consensusMessage = keccak256(
    abi.encode(
        ['string',   'uint64',  'bytes32',       'bytes32',      'bytes32',       'bytes32',     'bytes32'],
        [channelName, blockNumber, blockHash,      eventRoot,       requestID,        payloadHash,    validatorSetHash]
    )
)
```

**各字段的来源和含义**：

| 字段 | 来源 | 含义 |
|------|------|------|
| `channelName` | Fabric: `"mychannel"` / EVM: `"evm-localhost"` | 源链标识 |
| `blockNumber` | 源链区块高度 | 交易所在区块号 |
| `blockHash` | Fabric: `sha256(stableStringify(blockHeader))` / EVM: `block.hash` | 区块哈希 |
| `eventRoot` | Merkle 树的根 | 当前简化方案使用 `ZeroHash` |
| `requestID` | `keccak256(namespace, nonce, srcHeight)` | 全局唯一请求标识 |
| `payloadHash` | `keccak256(abiEncodedPayload)` | 负载完整性哈希 |
| `validatorSetHash` | V3 中设为 `ZeroHash` | 简化方案不使用 |

**为什么是这些字段**：

- `channelName` + `blockNumber`：定位源链和区块
- `blockHash`：证明签名者确认的是特定区块
- `requestID` + `payloadHash`：绑定到特定的请求和负载
- 签名者签名 = 声明"我确认这笔交易在源链上存在，且负载未被篡改"

### 5.2 签名者在签名前的独立验证

每个签名者在签名前执行独立的源链验证：

```
Fabric Validator:
  POST /mpc-sign
  ↓
  ① verifyTxOnAssignedPeer(txId):
    Gateway → peer GetBlockByTxID(txId)
    如果找不到 → 拒签
    如果找到 → 确认交易在 Fabric 账本中存在
  ↓
  ② ecdsa_sign(consensusMessage, wallet.privateKey)
  ↓
  返回 { mpcSignature, mpcPubkey }
```

### 5.3 MPC-TSS 聚合过程

当前采用简化的 MPC 聚合（生产环境可替换为 GG20 协议）：

```
POST /mpc-aggregate → consensus-aggregator/server.js

buildMpcConsensusAggregate(params):
  ① 调用 buildV3ConsensusProof(params) — 并行请求 4 个 validator 签名
  ② 收集到 ≥3 个有效签名后:
    - 选第一个签名者的 pubkey 作为 MPC 公钥
    - 选第一个签名者的 signature 作为 MPC 组合签名
  ③ 返回:
    {
      mpcPubkey: "0x...",         // 单一公钥
      mpcSignature: "0x...",      // 单一签名 (65 bytes)
      consensusMessage: "0x...",  // 被签名的消息
      signerCount: 4,             // 参与签名的节点数
      threshold: 3,               // 阈值
      signatureScheme: 'mpc-tss'
    }
```

**生产环境中的真正的 MPC-TSS**：

```
DKG 阶段:
  ① 4 个节点通过 GG20 分布式密钥生成协议
  ② 每个节点获得私钥分片 s_i
  ③ 公钥 P = s_1 × G + s_2 × G + s_3 × G + s_4 × G

签名阶段:
  ① 聚合器广播需要签名的 consensusMessage
  ② 3 个节点的私钥分片通过 GG20 签名协议（2 轮交互）
  ③ 产出一个标准 ECDSA 签名 (r, s, v)
  ④ 用公钥 P 验证: ecrecover(consensusMessage, signature) == P

链上合约:
  → 只存 P（一个公钥）
  → 只验 1 次 ecrecover
  → 签名 = 65 bytes（与普通 ECDSA 完全一样）
```

---

## 6. TEE 验证：Fabric 路径

### 6.1 验证入口

```javascript
// tee-verifier/server.js → /attest
// xmsg.chainType === 0 → Fabric 路径
```

### 6.2 本地验证路径（优先）

**前置条件**：请求方提供了 `blockData.signedBlockBytes`（hex 编码的 protobuf Block）

```
verifyFabricBlockLocally(blockBytes, expectedTxId, expectedBlockNumber):

① 解码 protobuf Block
  const block = common.Block.decode(blockBytes)
  const header = block.header

② 验证区块号匹配
  Number(header.number) === expectedBlockNumber
  → 不匹配 → { verified: false, reason: "Block number mismatch" }

③ 计算并验证 previous_hash 链连续性
  headerBytes = BlockHeader.encode(header).finish()
  computedBlockHash = sha256(headerBytes)
  
  fabricState.tipHash → 缓存的链头哈希
  '0x' + previous_hash === tipHash ?
  → 不匹配 → 检查是否在其他已知区块头中
  → 找不到 → { verified: false, reason: "Chain discontinuity" }

④ 验证交易数据存在于区块中
  for dataItem in block.data.data:
    decode Envelope → Payload → ChannelHeader
    if ChannelHeader.tx_id === expectedTxId → FOUND ✓
  → 未找到 → { verified: false, reason: "Transaction not found in block" }

⑤ 更新本地 header chain 缓存
  fabricState.tipHeight = header.number
  fabricState.tipHash = computedBlockHash
  fabricState.headers.push({ number, hash, previousHash, dataHash })
  写入 tee-chain-state.json

⑥ 返回 { verified: true, blockNumber, blockHash, txId }
```

**验证的字段**：
- `block.header.number` — 与 `xmsg.srcHeight` 比对
- `block.header.previous_hash` — 链连续性
- `block.header.data_hash` — 区块数据完整性
- `block.data.data[]` — 交易包含性（解码 Envelope 找 txId）

### 6.3 降级查询路径（Fallback）

**前置条件**：`signedBlockBytes` 为空或长度不足

```
queryFabricBlock(txId, channelName):
  Gateway.connect(ccp)
  → network.getContract('qscc')
  → qscc.evaluateTransaction('GetBlockByTxID', channelName, txId)
  → 返回 protobuf Block 字节
  
  返回的 Block 字节同样进入 verifyFabricBlockLocally() 验证
```

QSCC `GetBlockByTxID` 是 Fabric 系统链码提供的接口，peer 内部有交易到区块的索引。返回的区块包含 orderer 签名（嵌入在 metadata 中）。

---

## 7. TEE 验证：EVM 路径

### 7.1 验证入口

```javascript
// tee-verifier/server.js → /attest
// xmsg.chainType === 1 → EVM 路径
```

### 7.2 本地验证路径

**前置条件**：请求方提供了 `blockData.blockHeader` + `blockData.receipt`

```
verifyEvmBlockLocally(blockHeaderObj, receiptObj, confirmingHeaders, expectedBlockNumber):

① 验证区块哈希自洽
  blockHeaderObj.hash 存在且非空
  → 不存在 → { verified: false }

② 验证区块号匹配
  Number(blockHeaderObj.number) === expectedBlockNumber
  → 不匹配 → { verified: false }

③ 验证回执属于此区块
  receiptObj.blockHash === blockHeaderObj.hash
  receiptObj.blockNumber === expectedBlockNumber
  receiptObj.transactionHash === expectedTxId
  → 不匹配 → { verified: false }

④ 验证确认链
  for head in confirmingHeaders:
    head.parentHash === prevHead.hash  (链连续)
  confirmingHeaders.length >= 1

⑤ 更新 EVM chain state
  evmState.tipHeight = lastConfirmingHeader.number
  evmState.tipHash = lastConfirmingHeader.hash

⑥ 返回 { verified: true, blockNumber, blockHash }
```

**验证的字段**：
- `blockHeader.hash` — 区块身份
- `blockHeader.number` — 与 `xmsg.srcHeight` 比对
- `blockHeader.parentHash` — 链连续性
- `receipt.blockHash` — 回执归属区块
- `receipt.blockNumber` — 回执区块号
- `receipt.transactionHash` — 回执所属交易

### 7.3 降级查询路径

```
queryEvmTransaction(txHash, expectedBlockNumber):

① provider.getTransactionReceipt(txHash)
  → 如果返回 null → { verified: false, "Transaction not found" }
  → 如果 receipt.blockNumber !== expectedBlockNumber → { verified: false }

② provider.getBlock(expectedBlockNumber)
  → 验证区块存在

③ 更新 EVM chain state
④ 返回 { verified: true, blockNumber, blockHash }
```

---

## 8. 链上双重验证

### 8.1 VerifierContractV3MPC.submit()

```solidity
function submit(
    XMsg calldata xmsg,           // 13 字段的结构体
    bytes calldata signature,      // MPC-TSS 单一 ECDSA 签名 (65 bytes)
    bytes32 consensusMessage,      // 签名者签署的共识消息
    address teePubKey,             // TEE 公钥
    bytes32 reportHash,            // TEE 报告哈希
    bytes calldata teeSig          // TEE 签名 (65 bytes)
) external {

    // ============ 路径A：签名者共识 ============
    require(signerPubkey != address(0), "signer pubkey not set");
    address recovered = _recover(consensusMessage, signature);
    require(recovered == signerPubkey, "invalid signer signature");

    // ============ 路径B：TEE 独立验证 ============
    require(teeWhitelist[teePubKey], "TEE not registered");
    bytes32 attestDigest = keccak256(abi.encode(reportHash, teePubKey));
    require(_recover(attestDigest, teeSig) == teePubKey, "invalid tee sig");

    // ============ 消息完整性 ============
    require(!consumed[xmsg.requestID], "replay");
    require(keccak256(xmsg.payload) == xmsg.payloadHash, "payload hash mismatch");

    consumed[xmsg.requestID] = true;  // 防重放
    ctr += 1;
    
    // ============ 执行业务 ============
    ITargetContract(xmsg.dstContract).execute(xmsg.requestID, xmsg.payload);
}
```

### 8.2 两条路径验证的不同事实

| 路径 | 输入 | 验证内容 | 信任根 |
|------|------|---------|--------|
| A | `consensusMessage` + `signature` | 签名者确认交易在源链上存在 | MPC 公钥 |
| B | `reportHash` + `teeSig` + `teePubKey` | TEE 独立验证了源链数据 | TEE 公钥 |

### 8.3 两条路径的独立性

```
路径A失败（攻击者控制全部签名者）：
  → 攻击者可伪造 signature 和 consensusMessage
  → 但 TEE 路径（B）独立查询 Fabric/QSCC
  → 发现交易不存在 → TEE 拒绝签名
  → 链上路径B验证失败 → 整个 submit() revert ✅

路径B失败（攻击者控制 TEE）：
  → 攻击者可伪造 teeSig 和 reportHash
  → 但攻击者没有 MPC 私钥
  → 无法为伪造的 consensusMessage 产生有效签名
  → 链上路径A验证失败 → 整个 submit() revert ✅
```

---

## 9. 数据流时序总结

```
正向 (Fabric → EVM):
  
  t=0ms     chaincode EmitXCall(payloadJson)
  t~400ms   fabric-listener 捕获事件 → fabric-captured-event.json
  t~450ms   proof-builder 标准化负载 + ABI编码
  t~500ms   consensus-aggregator 并行请求 4个validator签名
             每个validator独立查peer验证交易存在
  t~550ms   收集到≥3个签名 → MPC聚合为1个签名
  t~600ms   TEE /attest → 独立验证 (Fabric: QSCC / 本地protobuf解码)
  t~650ms   TEE 签名报告 → 返回 attestation
  t~700ms   relayer 提交到 VerifierContractV3MPC
             路径A: ecrecover ×1 (~3k gas)
             路径B: ecrecover ×1 (~3k gas)
  t~1200ms  交易确认 → TargetContract 执行业务
  t~2800ms  端到端完成 (含区块确认等待)

闭环 ACK 额外:
  t+~500ms   从 EVM receipt 构建 ACK XMsg
  t+~600ms   EVM validator 签名 (EVM 验证者集合)
  t+~1000ms  ack-daemon → TEE attest → Fabric ConfirmAckXMsg
  t+~2000ms  Fabric 链码确认 ACK
  t~5000ms   闭环完成
```