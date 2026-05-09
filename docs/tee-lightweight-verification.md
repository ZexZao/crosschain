# TEE 轻量化源链验证方案

## 1. 问题定义

当前 TEE 验证模型无法抵御"真区块配假交易"攻击：

```
攻击: 攻击者取真实区块 N（含交易 A），配上伪造 XMsg（声明 txId = B）
      → 区块号匹配、链连续 → TEE 仅验区块有效，不验 txId 在区块中 → 通过 ❌
```

需实现的防护：TEE 必须证明**该 txId 对应的交易确实包含在该区块中**。

但在不连接全节点的情况下做这个证明，EVM 和 Fabric 需要完全不同的轻量化方案。

## 2. EVM 路径：轻客户端（SPV）

### 2.1 方案

采用以太坊标准的 Merkle Patricia 回执证明：

```
TEE 持有: 信任锚（创世块哈希 或 最新 checkpoint）
TEE 收到: XMsg(txHash, blockNumber) + BlockHeader + Receipt + MerklePatriciaProof

TEE 验证链路:
  ① 验 blockHeader.parentHash == TEE本地tipHash（链连续）
  ② 验 keccak256(rlp(blockHeader)) == blockHeader.hash（哈希自洽）
  ③ 验 receipt.blockNumber == expectedBlockNumber
  ④ 验 receipt.transactionHash == xmsg.txHash
  ⑤ 验 MerklePatriciaProof:
     - 从 receipt 计算 receiptRoot 的一个叶子
     - 验证 receiptRoot 的 Merkle Patricia proof 指向 blockHeader.receiptsRoot
     - 验证 proof 路径与 key = rlp(receipt.transactionIndex) 一致
  ⑥ 验 N 个确认区块头形成连续链（parentHash 连续）
  ⑦ 更新本地 tipHash → 签名 TEE 报告
```

### 2.2 数据来源

| 数据 | 来源 | 说明 |
|------|------|------|
| BlockHeader | 请求方提供（proof builder / ACK builder） | 从 EVM RPC `getBlock()` 获取 |
| Receipt | 请求方提供 | 从 `getTransactionReceipt()` 获取 |
| MerklePatriciaProof | 请求方提供 | 从 `getProof()` 或自构造 |
| ConfirmingHeaders[] | 请求方提供 | N 个后续区块头用于确认数 |

### 2.3 TEE 本地存储

```json
{
  "evm": {
    "tipHeight": 1234,
    "tipHash": "0x...",
    "trustAnchor": "0x... (genesis hash)",
    "headers": [{ "number": 1234, "hash": "0x...", "parentHash": "0x..." }, ...]
  }
}
```

### 2.4 开销

| 项目 | 数据量 |
|------|--------|
| BlockHeader (RLP) | ~500 bytes |
| Receipt (RLP) | ~300 bytes |
| Merkle Patricia Proof | ~2-5 KB（取决于交易数量） |
| N=6 个确认区块头 | ~6 × 500 = 3KB |
| **总计** | **~5-8KB/次** |

对比当前 EVM 降级路径：零额外数据，但有 RPC 网络请求（不可信主机）。
对比当前 EVM 本地路径：零额外数据，但不验证 txId。

### 2.5 安全性

| 攻击 | 防御 |
|------|------|
| 伪造 receipt | Merkle Patricia proof 验证失败（receiptsRoot 不匹配） |
| 伪造 blockHeader | 哈希自洽检查失败 |
| 重放旧区块 | parentHash 不连续 |
| 用真 receipt 配假 txHash | receipt.transactionHash 不匹配 |

### 2.6 实现依赖

- `ethers` 自带 RLP 解码（`ethers.decodeRlp`）可用
- Merkle Patricia Trie 验证可用 `@ethersproject/trie` 或 `merkle-patricia-tree` npm 包
- 或手动实现 MPT 验证（~100 行代码）

## 3. Fabric 路径：轻量化证明（待解决）

### 3.1 为什么 Fabric 没有现成的轻客户端方案

| 特性 | Ethereum | Fabric |
|------|----------|--------|
| 交易定位 | Merkle Patricia Trie（receipt trie） | 线性遍历 block.data.data[] |
| 交易包含证明 | receiptRoot → Merkle path | **无标准轻量证明** |
| 区块签名 | PoS 验证者 BLS 聚合 | orderer ECDSA 签名（嵌在 metadata 中） |
| 轻客户端标准 | LES (Light Ethereum Subprotocol) | **不存在** |

### 3.2 当前唯一可行的方案：QSCC 降级

```
Fabric 当前路径（降级）:
  TEE → Gateway.connect() → QSCC.GetBlockByTxID(txId) → 返回区块 protobuf 字节
  → TEE 解码 protobuf → 验区块号 → 验链连续 → [需新增] 遍历 block.data 找到 txId

为什么只有这个方案可行:
  - Fabric 没有"交易回执 Merkle 树"
  - Fabric 没有"交易到区块的 SPV 证明"
  - GetBlockByTxID 是 Fabric QSCC 提供的系统级接口，peer 内部已有索引
  - 返回的是完整区块（含 orderer 签名），不是单条交易
```

### 3.3 QSCC 降级路径的信任模型

```
Trust Model:
  TEE → [TLS + gRPC] → Fabric peer → QSCC → 返回区块
  
  Peer 是 Fabric 网络的一部分，不是主机控制的进程。
  Peer 返回的数据由 Fabric 共识保证（orderer 签名 + 多 peer 背书）。
  主机无法伪造 peer 的 TLS 证书（私钥在 Docker 挂载的运行时目录中）。
  
  攻击面: 主机可以:
    ① 重定向 DNS → 连接假 peer → TLS 握手失败（假 peer 无有效证书）
    ② 拦截 gRPC → 解密/篡改 → gRPC 使用 TLS 加密
    ③ 替换 CA 证书 → TEE 可验 CA cert hash（启动时缓存）
  
实际可行的攻击: 主机操作者也是 Docker 管理员，可访问 Fabric 运行时文件（含 CA 私钥）。
如果主机用 CA 私钥签发假 peer 证书 → 可 MITM → 可返回假数据。

这个攻击需要: 主机操作者 = Fabric 管理员，这是当前实验环境本身的限制。
```

### 3.4 强化的 QSCC 路径

在当前约束下，QSCC 路径可以通过以下方式强化：

```
① TEE 启动时加载 orderer MSP 公钥（从本地证书文件）
② QSCC 返回的区块 protobuf 中包含 orderer 签名
③ TEE 验证 orderer 签名后才接受区块
④ TEE 遍历 block.data 找到 txId 后才确认交易包含

为什么 ③ 有效:
  - orderer 签名密钥不在主机上（它属于 Fabric 排序节点进程）
  - 即使主机伪造了 TLS 连接也无法伪造 orderer 签名
  - 前提: orderer 签名确实嵌入在 QSCC 返回的区块数据中（大部分 SDK 版本包含）
```

### 3.5 QC 降级路径的数据流

```
输入: XMsg(txId, blockNumber)
输出: 签名后的 TEE 报告

步骤:
  ① queryFabricBlock(txId) → Gateway.connect() → QSCC.GetBlockByTxID(txId)
     ↓ 返回区块 protobuf 字节（含 orderer 签名 + orderer metadata）
  
  ② 解码 common.Block
     ↓
  
  ③ 验 orderer 签名（从 block.metadata.metadata[SIGNATURE_INDEX] 提取）
     ↓ 用本地 MSP 公钥验证
  
  ④ 验 block.header.number == expectedBlockNumber
     ↓
  
  ⑤ 验 block.header.previous_hash == 本地 tipHash（链连续性）
     ↓
  
  ⑥ decodeTxIdInBlock(blockBytes, expectedTxId)
     - 遍历 block.data.data[]
     - 解码 Envelope → Payload → ChannelHeader.tx_id
     - 找到匹配的 txId → 确认交易包含
     ↓
  
  ⑦ 更新 tipHash → 签名 TEE 报告
```

### 3.6 Fabric 轻量化证明的未来方向

当前 QSCC 降级是唯一可行方案，但未来可以探索：

| 方向 | 思路 | 可行性 |
|------|------|--------|
| 区块头链 + 交易索引 | TEE 维护区块头链 + 验证交易在区块数据中的位置（线性扫描） | 当前 QSCC 已达此效果 |
| Orderer 签名聚合 | 多个 orderer 的签名聚合为单一证明 | Raft orderer 单签名已足够 |
| State-based endorsement | 不验证交易包含，改为验证世界状态变更 | 需要额外链码查询 |
| Fabric SPV 提案 | 类似 ETH LES 的轻客户端协议 | 社区暂无标准 |

## 4. 实施路线

### Phase 1: Fabric 路径强化（紧急）

1. `verifyTxIdInFabricBlock()` — protobuf 解码遍历找 txId
2. 修复 `verifyFabricBlockLocally()` 增加 txId 验证
3. 修复降级路径同样增加 txId 验证
4. 测试：真区块配假交易应被拒绝

### Phase 2: EVM 轻客户端

1. 实现 MPT proof 验证
2. ACK 路径传递 receipt + proof
3. TEE 验证 receiptRoot + txHash 匹配
4. 测试

### Phase 3: Fabric Orderer 签名验证

1. 从区块 metadata 提取 orderer 签名
2. 用本地 MSP 公钥验证
3. 移除对 TLS 的信任依赖

## 5. 设计原则总结

```
EVM 路径:  "请求方给我轻量密码学证明，我自己验"
           → Merkle Patricia root proof
           → TEE 不连任何节点，纯本地验证

Fabric 路径: "我自己连 peer 查询，但我验证查询结果"
            → QSCC.GetBlockByTxID (TLS + gRPC)
            → TEE 验 orderer 签名 + 验 txId 在区块中
            → 主机无法伪造 orderer 签名

两条路径的共同要求:
  - TEE 必须验证 txId 确在区块数据中（当前缺失 ❌）
  - 信任根是源链共识层的密钥（不是主机的网络路径）
