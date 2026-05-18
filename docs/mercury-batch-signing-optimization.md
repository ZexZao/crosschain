# Mercury 批处理签名优化方案

## 1. 背景

当前项目已经实现 Mercury-like 的平等 TEE quorum：

```text
单条 h-xmsg
  -> TEE 独立验证源链事实
  -> TEE quorum append/commit
  -> committed TEE 对 signingDigest 签名
  -> 目标链验证多个 TEE 签名后执行
```

这个设计保证了单个 TEE 不能伪造跨链消息，但在吞吐量较高时会产生重复开销：

1. 每条消息都要发起一次 TEE 共识。
2. 每条消息都要收集 `f+1` 个 TEE 签名。
3. EVM 目标链每条消息都要验证 `f+1` 个 ECDSA 签名。

Mercury 提到可以让 TEE 对一批交易签名来提升效率。对应到本项目，应改造为 **batch h-xmsg certification**：TEE 仍然逐条验证源链事实，但对一批消息的 Merkle root 进行共识和签名。

## 2. 设计目标

批处理优化不能改变项目初衷：

1. 不能只验证区块，必须验证具体交易或事件存在性。
2. 每条 h-xmsg 仍然必须独立绑定源链事实、目标执行和反馈策略。
3. TEE 必须独立验证每条消息后，才能把它放入 batch。
4. TEE 只能在 batch entry committed 后签名。
5. 目标链必须能验证某条 h-xmsg 属于已认证 batch。

批处理只优化“证明提交形式”，不能弱化可信消息传递的语义。

## 3. 核心结构

新增 `HXMsgBatch` 概念：

```text
HXMsgBatch {
  batchID,
  batchRoot,
  messageCount,
  sourceChainType,
  targetChainType,
  createdAt,
  expireAt,
  policyID,
  policyHash
}
```

每条消息生成一个 Merkle leaf：

```text
leaf = keccak256(
  requestID,
  hmsgDigest,
  signingDigest,
  targetExecutionHash,
  callDataHash,
  expireAt
)
```

其中：

| 字段 | 作用 |
|---|---|
| `requestID` | 防止 batch 内和目标链重放 |
| `hmsgDigest` | 绑定完整 h-xmsg |
| `signingDigest` | 绑定目标链实际验签摘要，EVM 为 `deliveryDigest`，Fabric 为 `hmsgDigest` |
| `targetExecutionHash` | 绑定目标链执行语义 |
| `callDataHash` | 绑定实际调用参数 |
| `expireAt` | 保留消息过期约束 |

TEE quorum 最终签名：

```text
batchSigningDigest = keccak256(
  batchID,
  batchRoot,
  messageCount,
  sourceChainType,
  targetChainType,
  policyHash,
  expireAt
)
```

## 4. TEE 侧流程

批处理 TEE 流程：

1. relayer 收集多条待处理 h-xmsg。
2. proposer TEE 对每条 h-xmsg 独立执行 h-FSV 或 MELV-EF 验证。
3. 验证失败的消息不得进入 batch。
4. proposer 为通过验证的消息构造 leaves 和 `batchRoot`。
5. proposer 构造 batch consensus entry。
6. 其他 TEE 收到 append 后，重新独立验证 batch 中每条 h-xmsg。
7. 每个 TEE 重新计算 leaves、Merkle root 和 batch signing digest。
8. 达到阈值 `f+1` 后 commit。
9. 每个 TEE 只在 batch committed 后签名 `batchSigningDigest`。
10. proposer 返回 `teeBatchCertification`。

返回结构可设计为：

```json
{
  "algorithm": "mercury-equal-tee-batch-quorum",
  "batchID": "0x...",
  "batchRoot": "0x...",
  "messageCount": 8,
  "threshold": 3,
  "reached": 3,
  "quorumReached": true,
  "certifications": [
    {
      "batchID": "0x...",
      "batchSigningDigest": "0x...",
      "teeAddress": "0x...",
      "verifiedAt": 1778846812,
      "signature": "0x..."
    }
  ],
  "messageProofs": {
    "requestID": {
      "leaf": "0x...",
      "proof": ["0x...", "0x..."],
      "leafIndex": 0
    }
  }
}
```

## 5. Fabric -> EVM 批处理

当前单条路径：

```text
HXMsgMinimal + f+1 TEE signatures
```

批处理后：

```text
HXMsgMinimal
  + Merkle proof
  + BatchCertification(batchRoot, f+1 TEE signatures)
```

EVM 网关新增接口：

```solidity
function executeHXMsgMinimalFromBatch(
    HXMsgLib.HXMsgMinimal calldata hxmsg,
    address target,
    bytes calldata callData,
    bytes32[] calldata merkleProof,
    uint256 leafIndex,
    BatchCertification calldata batchCert
) external;
```

链上检查：

1. 检查 `requestID` 未处理。
2. 检查 h-xmsg 最小执行字段。
3. 重新计算当前消息 leaf。
4. 用 `merkleProof` 验证 leaf 属于 `batchRoot`。
5. 验证 `f+1` 个 TEE 对 `batchSigningDigest` 的签名。
6. 检查 TEE 已注册且签名地址不重复。
7. 调用目标合约。

这样一批消息共用一组 TEE quorum 签名。若一批中有 8 条消息，EVM 不需要为每条消息都验证 3 个 TEE 签名。

## 6. EVM -> Fabric 批处理

Fabric 目标链新增接口：

```text
ExecuteHXMsgFromBatch(hxmsgJson, callDataHex, proofJson, batchCertJson)
```

链码检查：

1. 重新计算 h-xmsg digest。
2. 重新计算 leaf。
3. 验证 Merkle proof。
4. 验证 TEE quorum 对 `batchSigningDigest` 的签名。
5. 检查 requestID 未消费。
6. 检查目标 Fabric chain/domain/chaincode。
7. 检查 `callDataHash` 和 `targetExecutionHash`。
8. 执行业务写入。

Fabric 链码执行 ECDSA 验签成本不是 gas 成本，但批处理仍可以减少 TEE 证明体积和链码重复验签次数。

## 7. 对 gas 和时间的影响

假设当前阈值为 `f+1 = 3`，每条消息单独提交：

```text
每条消息验证 3 个 TEE 签名
8 条消息验证 24 个 TEE 签名
```

批处理后：

```text
一批 8 条消息共用 3 个 TEE 签名
每条消息额外验证一个 Merkle proof
```

因此 EVM gas 从“签名验证数量随消息数线性增长”变为：

```text
batch 固定签名成本 + 每条消息的 Merkle proof 成本 + 每条消息目标执行成本
```

在 batch size 较大时，收益明显。单条消息场景收益不明显，甚至可能因为 Merkle proof 增加少量成本。

时间开销也会下降：

```text
单条共识: N 条消息发起 N 次 append/commit
批处理共识: N 条消息发起 1 次 append/commit
```

但 TEE 对每条消息的源链事实验证不能省略。

## 8. 可维护性设计

建议新增独立模块，避免污染现有单条 h-xmsg 路径：

| 模块 | 作用 |
|---|---|
| `shared/hxmsg/batch.js` | leaf、Merkle root、batch digest 计算 |
| `tee-verifier/core/batch-consensus.js` | batch append/commit 流程 |
| `tee-verifier/core/batch-certification.js` | batch 签名生成 |
| `contracts/HXMsgBatchLib.sol` | Solidity leaf 和 batch digest 计算 |
| `contracts/HXMsgGateway.sol` | 新增 EVM batch 执行入口 |
| `fabric-chaincode/xcall/index.js` | 新增 Fabric batch 执行入口 |
| `scripts/run-hxmsg-batch-forward-tests.js` | Fabric -> EVM batch 测试 |
| `scripts/run-evm-fabric-batch-tests.js` | EVM -> Fabric batch 测试 |

现有单条路径保留，用于：

1. 低频消息。
2. 延迟敏感消息。
3. batch 组不满但需要立即提交的消息。
4. batch 功能故障时的回退路径。

## 9. 实施阶段建议

### 阶段 A：链下 batch 结构

实现 `shared/hxmsg/batch.js`，完成：

1. leaf 计算。
2. Merkle tree 构造。
3. proof 生成。
4. batchSigningDigest 计算。
5. 单元测试。

### 阶段 B：TEE batch quorum

新增 `/attest-batch`：

1. proposer 验证 batch 中每条 h-xmsg。
2. follower 独立验证 batch。
3. quorum append/commit。
4. committed TEE 签名 batch digest。

### 阶段 C：EVM batch 执行

新增 `executeHXMsgMinimalFromBatch()`：

1. 验证 Merkle proof。
2. 验证 batch TEE quorum。
3. 执行目标合约。
4. 对比单条路径 gas。

### 阶段 D：Fabric batch 执行

新增 `ExecuteHXMsgFromBatch()`，并补充 EVM -> Fabric batch 测试。

### 阶段 E：策略优化

加入 batch 策略：

```text
maxBatchSize
maxBatchDelayMs
sourceChainType
targetChainType
priority
expireAt lower bound
```

低延迟消息走单条路径，高吞吐消息走 batch 路径。

## 10. 当前边界

批处理方案不会解决所有开销：

1. TEE 仍必须逐条验证源链事实。
2. 每条目标链执行仍有自身 gas。
3. Merkle proof 会带来少量额外 calldata 和 hash 成本。
4. 若 batch 很小，收益有限。
5. 若目标合约本身 gas 很高，batch 只能减少证明验证部分，不能减少业务执行 gas。

该方案最适合消息交互频繁、单条业务执行较轻、证明验证成本占比较高的场景。
