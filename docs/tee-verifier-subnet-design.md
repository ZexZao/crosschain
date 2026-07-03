# TEE Verifier Subnet 与授权绑定设计

## 背景

随着项目接入 Ethereum、Fabric、Avalanche 等多种异构区块链，单一 TEE 集群加载所有链的 verifier adapter 会遇到资源和工程边界问题。

不同链需要维护的状态和验证逻辑不同：

| 源链 | TEE 需要维护或验证的内容 |
|---|---|
| Ethereum / EVM | sync committee state、finalized header、receipt MPT proof、header window |
| Fabric | MSP、endorsement policy、h-FSV view、block/rwset 验证 |
| Avalanche | Warp/ICM message、validator set、P-Chain checkpoint、BLS aggregate signature |

真实 TEE 内存、可信计算基大小和部署复杂度都有限，因此建议采用多个 TEE verifier subnet。

## 设计目标

TEE 子网设计目标：

1. 每个 TEE subnet 只负责一类源链证明。
2. 每个 subnet 内部独立运行 Raft。
3. 每个 subnet 独立形成 TEE quorum certification。
4. 目标链通过 registry 判断哪个 subnet 有权验证哪类源链事实。
5. 新增链时只新增对应 subnet，不修改已有链 verifier。

## 基本结构

建议初始划分：

```text
TEE Subnet A: Ethereum verifier subnet
  - EVM receipt MPT proof
  - sync committee/finality
  - header window

TEE Subnet B: Fabric verifier subnet
  - h-FSV view
  - MSP/endorsement
  - Fabric block/rwset

TEE Subnet C: Avalanche verifier subnet
  - Avalanche Warp/ICM message
  - validator set
  - signer weight
  - aggregate signature
```

每个 subnet 内部仍使用当前项目已有的 Raft-backed quorum 思路：

```text
source proof
    -> subnet TEE nodes independently verify
    -> subnet Raft commits same verified digest
    -> subnet emits quorum certificate
    -> target chain verifies certificate
```

## 为什么分子网不是错误设计

分子网本身不是安全错误。它适合异构链验证场景，因为每类链的证明状态和 verifier 逻辑差异很大。

错误设计是：

```text
任意 TEE subnet 的签名都能执行任意 h-xmsg
```

正确设计是：

```text
sourceChainType + sourceChainID + verificationMethod + verifierProfileHash
    -> authorizedSubnetID
```

目标链必须检查 TEE certificate 来自被授权的 subnet。

## 授权绑定

需要新增 TEE subnet registry / routing policy。

建议 route key：

```text
routeKey = hash(
  sourceChainType,
  sourceChainID,
  verificationMethod,
  verifierProfileHash
)
```

registry 记录：

```json
{
  "routeKey": "0x...",
  "subnetID": "0x...",
  "epoch": 1,
  "threshold": 3,
  "memberRoot": "0x...",
  "members": ["0xTEE1", "0xTEE2", "..."],
  "active": true
}
```

目标链验证时：

```text
1. 从 h-xmsg 读取 source 和 verification。
2. 计算 routeKey。
3. 从 registry 查询 authorized subnet。
4. 检查 cert.subnetID == registry.subnetID。
5. 检查 cert.epoch == registry.epoch。
6. 检查 cert.threshold 与 registry 一致。
7. 验证 cert 中签名者属于该 subnet 成员集合。
8. 验证 signingDigest 绑定 hmsgDigest/deliveryDigest/batchDigest。
```

## Certificate 需要绑定的字段

TEE quorum certificate 应显式绑定：

```text
subnetID
subnetEpoch
sourceChainType
sourceChainID
verificationMethod
verifierProfileHash
signingDigest
signatureDigestType
threshold
signerBitmap
selectedSignerHash/memberRoot
```

其中 `signingDigest` 仍可沿用当前项目：

| 场景 | signingDigest |
---|---|
| 单条 EVM/Fabric 目标投递 | `hmsgDigest` 或 `deliveryDigest` |
| 批处理 | `batchSigningDigest` |
| RESPONSE | `responseDigest` |

但 certificate 必须说明它属于哪个 subnet，目标链不能只看签名数量。

## h-xmsg 是否需要新增字段

不建议大改 h-xmsg 主结构。

可以优先利用已有字段：

```text
source.chainType
source.chainID
verification.verificationMethod
verification.verifierProfileHash
verification.policyRef.policyHash
```

目标链根据这些字段计算 routeKey。

如果需要更明确，也可以在 TEE certificate 中加入：

```text
subnetID
verifierRouteKey
```

而不是把 subnetID 放入 h-xmsg 顶层。这样 h-xmsg 仍保持链无关，授权关系由目标链 registry 管理。

## 对当前项目的改造范围

建议改造位置：

```text
shared/tee/quorum-certificate.js
shared/tee/registration.js
contracts/TEERegistry.sol
contracts/HXMsgGateway.sol
fabric-chaincode/xcall/index.js
tee-verifier/server.js
tee-verifier/adapters/index.js
```

主要变化：

1. `TEERegistry` 从单一 TEE 集群扩展为多 subnet registry。
2. Fabric chaincode 从单一 trusted TEE config 扩展为 route-based trusted subnet config。
3. TEE server 增加 `TEE_SUBNET_ID`、`TEE_SUBNET_PROFILE`、`SUPPORTED_SOURCE_CHAINS` 配置。
4. Adapter index 只加载当前 subnet 允许的 adapter。
5. 目标链验证 cert 时检查 route authorization。

## 对开销的影响

授权绑定会带来额外开销，但较小。

EVM 侧主要是：

```text
1-3 次 SLOAD
若干 bytes32 比较
certificate 多携带 subnetID / epoch / routeKey
```

预计是几千到一两万 gas 级别，远小于 TEE 多签验证、业务执行和批处理 calldata 的主要成本。

Fabric 侧主要是：

```text
读取 route config
比较 subnetID/epoch/threshold
检查成员或 memberRoot
```

会增加少量 endorsement 执行时间，但不是主瓶颈。

如果继续使用 batch certificate，route authorization 可以按 batch 共享，平均到每条消息的开销更低。

## 与 Raft 的关系

每个 subnet 内部独立运行 Raft。

```text
Ethereum subnet Raft
Fabric subnet Raft
Avalanche subnet Raft
```

不同 subnet 之间不需要共享 Raft log。跨 subnet 的关系由目标链 registry 授权，而不是由 subnet 之间互相投票。

这能保持共识边界清晰：

```text
某个 subnet 只对自己负责的 source fact 达成共识
目标链只接受被授权 subnet 对该 source fact 的签名
```

## 路由与新增链

新增链时流程：

1. 新增 source builder。
2. 新增 TEE adapter。
3. 部署新的 verifier subnet。
4. 在目标链 registry 注册 route：

```text
newChainID + newVerificationMethod + newVerifierProfileHash
    -> newSubnetID
```

旧链 subnet 不需要加载新链 adapter，也不需要修改旧链验证逻辑。

## 安全风险与防护

### 风险一：子网越权签名

攻击者拿 Fabric subnet 的 cert 去执行 EVM source message。

防护：

```text
目标链根据 routeKey 检查 cert.subnetID 是否被授权。
```

### 风险二：旧 epoch 重放

攻击者提交旧 subnet 成员签出的证书。

防护：

```text
cert.epoch == registry.currentEpoch
已执行 requestID/hmsgDigest 防重放
必要时保留 epoch grace window，但必须显式配置
```

### 风险三：新链接入影响旧链

单一 TEE 集群需要加载新 adapter，可能扩大可信计算基。

防护：

```text
新链使用新 subnet
旧链 registry route 不变
旧链 subnet 不加载新 adapter
```

### 风险四：目标链只验证 TEE 签名数量

如果目标链不检查 subnet 授权，分子网会成为安全漏洞。

防护：

```text
目标链必须验证 source/verification -> subnet 的授权映射。
```

## 推荐实施阶段

| 阶段 | 内容 | 目标 |
|---|---|---|
| Phase 1 | 在证书中加入 `subnetID/epoch/routeKey`，目标链 registry 增加 route config | 建立授权绑定 |
| Phase 2 | 将当前 EVM/Fabric adapter 拆成两个 subnet 配置运行 | 验证分子网可行性 |
| Phase 3 | Avalanche adapter 使用独立 subnet | 降低单 TEE 资源压力 |
| Phase 4 | 支持 subnet epoch 更新、成员轮换、attestation 绑定 | 面向真实 TDX 部署 |

## 结论

TEE verifier subnet 是合理且推荐的扩展设计。

它不会削弱系统安全性，前提是必须补上授权绑定：

```text
sourceChain + verification profile
    -> authorized TEE subnet
```

如果没有这层绑定，任意 subnet 都可能签任意 h-xmsg，分子网设计会变成漏洞。

补上绑定后，该设计可以：

1. 降低单个 TEE 的内存和代码负担。
2. 减少新增链对已有链的影响。
3. 让每类链维护自己的轻客户端或证明缓存。
4. 更清晰地体现项目面向异构区块链互操作的可扩展性。
