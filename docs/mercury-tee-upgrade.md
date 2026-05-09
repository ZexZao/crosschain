# Mercury 论文思路指导下的 TEE 升级方案

## 1. 问题诊断

### 当前 TEE 的安全缺陷

当前 `tee-verifier/server.js` 的 `/attest` 端点通过主机 OS 网络栈连接 Fabric peer / EVM RPC 查询交易。主机操作者控制网络栈，可以：

1. 拦截 TEE 发出的网络请求
2. 返回伪造的数据（声称不存在的交易存在）
3. 重定向连接到攻击者控制的节点
4. 在 TEE 接收数据前篡改内容

**根因**: TEE 信任主机提供的网络路径，没有独立验证"收到的数据确实来自源链"的能力。

## 2. Mercury 的核心思想

Mercury 将 TEE（Intel SGX enclave）用作：

1. **密钥保管者** — 私钥在 enclave 内部生成和存储
2. **SPV 轻客户端** — enclave 内部维护区块链头链，独立验证区块有效性
3. **共识执行者** — 共识逻辑在 enclave 内运行，主机无法干预

对我们的关键启示：

> **TEE 不应该通过主机网络去"查询"数据，而应该独立验证数据本身携带的密码学证明。**

## 3. 修改方案

### 3.1 核心思想

无论 Fabric 还是 EVM，TEE 的验证逻辑统一为：

> **"请给我数据 + 这条数据自带的密码学证明，我自己验证，不替你上网查。"**

但两种链的"密码学证明"形式不同，需要分别处理。

### 3.2 Fabric 侧：Orderer 签名验证

**Fabric 的密码学基础**：每个区块由排序节点（orderer）签名后广播。通道 MSP 定义了哪些 orderer 签名有效。

```
TEE 启动时:
  加载通道 MSP 配置（orderer x509 证书公钥）
  将证书哈希存入 TEE 不可变状态

TEE 验证时（/attest，Fabric路径）:
  输入: XMsg{txId, blockNumber} + SignedBlock

  步骤1: 验 orderer 签名
    从 SignedBlock.metadata 提取 orderer 签名
    用本地持有的 MSP 公钥验证
    → 签名无效 → 拒绝（主机伪造的数据）

  步骤2: 验区块头链连续
    提取 block.header.previous_hash
    与 TEE 本地缓存的 tipHash 比对
    → 不连续 → 拒绝（主机重放旧区块）

  步骤3: 验交易包含性
    遍历 block.data.data，对每个 transaction envelope:
      提取 txId，与 XMsg.txId 比对
    → 找不到 → 拒绝

  步骤4: 验区块号匹配
    block.header.number == xmsg.srcHeight

  步骤5: 更新本地 header chain
    将新区块头追加到缓存

  全部通过 → 签名 TEE 报告
```

**信任根**: orderer 的 x509 MSP 证书 → 伪造签名需要 orderer 私钥。

### 3.3 EVM 侧：区块头哈希链 + 确认数验证

**EVM 的密码学基础**：区块头包含 `parentHash`，形成 SHA256 哈希链。Hardhat 本地节点不签名区块，但哈希链本身是不可伪造的（需要找到 SHA256 碰撞）。对于生产以太坊 PoS，还需验证验证者 BLS 聚合签名。

```
TEE 启动时:
  设置信任锚: Hardhat 创世块哈希（从启动参数读入）
  初始化 state: { evmTipHeight: 0, evmTipHash: genesisHash }

TEE 验证时（/attest，EVM路径）:
  输入: XMsg{txHash, blockNumber} + BlockHeader + Receipt + ConfirmingHeaders[]

  步骤1: 验区块哈希链连续
    对请求中附带的每个区块头:
      require(block.parentHash == previousBlock.hash)
      require(keccak256(rlp.encode(block)) == block.hash)
    第一个区块头必须连接到本地 tipHash
    → 链断裂 → 拒绝

  步骤2: 验交易回执
    require(receipt.blockHash == block.hash)
    require(receipt.blockNumber == blockNumber)
    require(receipt.status == 1)

  步骤3: 验确认数
    require(ConfirmingHeaders.length >= requiredConfirmations)
    （如 6 个块 = 近似 12 秒安全窗口）

  步骤4: 更新本地 tip
    将最新确认区块头更新为 tipHeight/tipHash

  全部通过 → 签名 TEE 报告
```

**信任根**: 创世块哈希 → 后面的每个块必须通过 SHA256 哈希链追溯到创世块。

**生产以太坊 PoS 扩展**: TEE 需持有当前验证者公钥集合，额外验证每个区块的 BLS 聚合签名。

### 3.4 两条链的验证对比

| 维度 | Fabric | EVM (Hardhat) | EVM (PoS 生产) |
|------|--------|---------------|----------------|
| 信任锚 | orderer x509 证书 | 创世块哈希 | 验证者公钥集合 |
| 密码学证明 | orderer ECDSA 签名 | SHA256 哈希链 | BLS 聚合签名 |
| 链连续性 | previous_hash | parentHash | parentHash + 签名 |
| 交易包含性 | 遍历 block.data | receipt trie proof | receipt trie proof |
| 伪造难度 | orderer 私钥 | SHA256 碰撞 | ≥2/3 验证者私钥 |
| 额外数据量 | ~10KB (Block) | ~2KB (Header+Receipt) | ~2KB + 签名 |

### 3.5 数据流变化

```
当前:
  XMsg{txId, blockNumber}
    → TEE → [网络] → Fabric peer / EVM RPC → 返回数据 → TEE验

新方案:
  XMsg{txId, blockNumber} + 密码学证明
    → TEE → [纯本地计算] → 验签名/哈希链 → 签名报告
               ↑
          零网络请求
```

### 3.6 请求方如何获取证明数据

**Fabric 路径**：Listener 捕获合约事件时通过 `contractEvent.getTransactionEvent().getBlockEvent()` 获取 BlockEvent，其中包含完整的已签名区块数据。

**EVM 路径（正向）**：N/A —— 正向传输源链是 Fabric，EVM 只做 ACK。ACK 路径中，从 `provider.getTransactionReceipt()` 获取回执，从 `provider.getBlock()` 获取区块头和确认区块头。

### 3.7 对现有代码的修改范围

| 文件 | 修改 |
|------|------|
| `tee-verifier/server.js` | 新增 `verifyFabricBlock()` + `verifyEvmBlock()`，删除网络查询 |
| `tee-verifier/chain-state.json` | 新增：TEE 本地双链 header state |
| `tee-verifier/msp-certs/` | 新增：Fabric MSP 证书 |
| `proof-builder/v3-proof-builder.js` | Fabric 附加 SignedBlock，EVM 附加 Block+Receipt |
| `source-chain/fabric-listener.js` | 捕获 BlockEvent 保存区块 |
| `consensus-aggregator/` | 无需修改 |
| `contracts/` | 无需修改 |
| `relayer/` | 无需修改 |
| `scripts/` | 更新 TEE 请求格式 |

## 4. 安全性分析

### 攻击场景：主机操作者试图欺骗 TEE

| 攻击 | Fabric（新方案） | EVM（新方案） |
|------|-----------------|--------------|
| 伪造交易存在 | 需 orderer 私钥签区块 ❌ | 需 SHA256 碰撞打破哈希链 ❌ |
| 重放旧区块 | 区块号+P.H.不匹配 ❌ | 区块号+P.H.不匹配 ❌ |
| MITM 网络连接 | 签名验证不依赖连接安全 ❌ | 哈希链不依赖连接安全 ❌ |
| 替换 MSP 证书 | 启动时从文件加载，运行时不可变 ❌ | N/A |
| 替换创世哈希 | 启动时设置，运行时不可变 ❌ | 启动时设置，运行时不可变 ❌ |

### 信任根对比

```
当前:
  TEE → 主机OS网络 → Docker DNS → Fabric peer TLS / EVM RPC → 响应数据
  攻击面: 每一步都可被主机操作者拦截

新方案 (Fabric):
  TEE 内存中 MSP 证书 → orderer 公钥 → 验区块签名 → 验交易存在
  攻击面: 仅 orderer 私钥持有者（Fabric 排序节点自身）

新方案 (EVM):
  TEE 内存中创世哈希 → SHA256 哈希链验证 → 连续 N 个确认 → 验交易回执
  攻击面: 需要打破 SHA256 哈希链（计算上不可行）
```

## 5. 实施路线

### Phase 1: Fabric 侧（优先级最高）

1. TEE 启动时加载 Fabric MSP 证书，提取 orderer 公钥
2. 实现 `verifyFabricBlock()`：验 orderer 签名 + 链连续 + 交易包含
3. Fabric header chain 缓存（本地 JSON 状态文件）
4. Proof builder 附加 SignedBlock 到 XMsg
5. 端到端测试

### Phase 2: EVM 侧

1. 实现 `verifyEvmBlock()`：哈希链验证 + 确认数验证
2. TEE 维护 EVM tipHash
3. ACK 路径适配：EVM block + receipt + 确认区块头
4. 端到端测试

### Phase 3: 安全测试

1. 注入伪造 Fabric 区块（无有效 orderer 签名）→ 期望 TEE 拒绝
2. 注入断裂的 EVM 哈希链 → 期望 TEE 拒绝
3. 性能对比：TEE 验证延迟、端到端时延

## 6. 性能预期

| 指标 | 当前 | 新方案 (Fabric) | 新方案 (EVM) |
|------|------|-----------------|--------------|
| TEE 验证延迟 | ~10s（网络+gRPC） | <100ms（验签+遍历） | <50ms（哈希链） |
| 网络请求数 | 1次/attest | 0 | 0 |
| 主机欺骗面 | 高 | orderer私钥级 | SHA256碰撞级 |
| 额外数据量 | 0 | ~10KB/次 | ~2KB/次 |
| 端到端时延影响 | +10s | <+0.1s | <+0.05s |
