# Gas 优化第三阶段实施说明

## 1. 本次改动目标

本次改动的目标是把 Fabric -> EVM 主路径优化到 gas 优化方案的第三阶段：

```text
轻量目标合约
payload hash-first
HXMsgMinimal 压缩上链提交
TEE deliveryDigest 签名
```

优化重点不是削弱 h-FSV、TEE 或 h-xmsg 的可信验证，而是减少 EVM 目标链上不必要的 calldata、动态解码、重复哈希和 storage 写入。

## 2. 修改了哪些文件

| 文件 | 改动 |
|---|---|
| `contracts/TargetContract.sol` | 改为轻量执行确认合约，只记录 `lastRequestID`、`lastPayloadHash`、`executionCount` |
| `contracts/HXMsgLib.sol` | 新增 `HXMsgMinimal`、`hashDelivery()`、`hashDeliveryFromFull()` |
| `contracts/HXMsgGateway.sol` | 新增 `executeHXMsgMinimal()` 主路径，验证压缩消息和 TEE delivery 签名 |
| `shared/hxmsg/hash.js` | 新增 `toMinimalHXMsg()`、`computeHXMsgDeliveryDigest()` |
| `tee-verifier/core/certification.js` | TEE 改为签名 `deliveryDigest`，同时保留 `hmsgDigest` |
| `scripts/deploy.js` | 调整部署顺序，先部署 Gateway，再把 Gateway 地址注入 Target |
| `scripts/run-hxmsg-forward-tests.js` | 测试脚本改为提交 `HXMsgMinimal`，并断言 `requestID/payloadHash` |
| `README.md` | 更新第三阶段实现程度和最新 gas 测试结果 |
| `docs/gas-optimization-analysis.md` | 补充第三阶段已实现状态和最新 gas 区间 |

## 3. TargetContract 的变化

优化前，`TargetContract` 更像一个测试用链上数据库。每次执行都会：

1. ABI 解码多个动态字符串。
2. 写入 `lastOp`、`lastRecordId`、`lastActor`、`lastAmount`。
3. 写入 `lastPayloadHash`、`lastMetadataHash`。
4. 向 `executionHistory` 追加完整记录。
5. 维护 `requestIndexPlusOne`。
6. 维护 `requestIDsByOpHash`、`requestIDsByRecordIdHash`、`requestIDsByActorHash`。
7. 在 storage 中保存多份动态字符串。

这些操作会产生大量 storage 写入。尤其是新 storage slot 从 0 写为非 0，每个 slot 通常需要约 20,000 gas。动态字符串还可能占用多个 storage slot，所以 gas 会迅速放大。

优化后，`TargetContract` 只做目标链侧的最小执行确认：

```solidity
address public immutable gateway;
bytes32 public lastRequestID;
bytes32 public lastPayloadHash;
uint256 public executionCount;
```

并且只允许 Gateway 调用：

```solidity
require(msg.sender == gateway, "only gateway");
```

这意味着业务明文、历史查询和复杂索引不再存入目标链合约，而是交给链下 runtime、测试结果文件或后续 indexer。目标链只保留可验证的执行确认。

## 4. HXMsgMinimal 的变化

优化前，EVM 侧提交完整 `HXMsgOnChain`，字段较多：

```text
header
source endpoint
target endpoint
sourceRef
targetAction
verification
policyRef
payloadBinding
feedback
nonce / createdAt / expireAt
```

Gateway 需要在链上重新计算完整 `hmsgDigest`，导致 calldata 和链上 hash 计算都偏重。

优化后，主路径提交 `HXMsgMinimal`：

```solidity
struct HXMsgMinimal {
    bytes32 requestID;
    bytes32 hmsgDigest;
    uint8 targetChainType;
    bytes32 targetChainID;
    uint8 actionType;
    bytes32 targetObject;
    bytes4 functionSelector;
    bytes32 callDataHash;
    bytes32 receiver;
    bytes32 targetExecutionHash;
    bool feedbackRequired;
    uint8 expectedFeedbackMsgType;
    uint64 feedbackTimeout;
    bytes32 callbackRefHash;
    uint64 expireAt;
}
```

完整 h-xmsg 仍然存在，但放在链下。TEE 在链下完整验证 h-xmsg 和 h-FSV，再把完整消息摘要 `hmsgDigest` 带到链上。

## 5. 为什么不能只提交 hmsgDigest

如果链上只提交：

```text
requestID
hmsgDigest
signature
```

那么 EVM 无法直接确认 relayer 提交的 `target/callData/expireAt/feedback` 是否真的属于 TEE 验证过的那条 h-xmsg。

因此本次没有采用这种过度压缩方式，而是引入 `deliveryDigest`：

```text
deliveryDigest = hash(
  chainHash,
  actionHash,
  feedbackHash
)
```

其中：

```text
chainHash = hash(requestID, hmsgDigest, targetChainType, targetChainID, actionType)
actionHash = hash(targetObject, functionSelector, callDataHash, receiver, targetExecutionHash)
feedbackHash = hash(feedbackRequired, expectedFeedbackMsgType, feedbackTimeout, callbackRefHash, expireAt)
```

TEE 签名的是 `deliveryDigest`，而不是单独的 `hmsgDigest`。

这样 EVM 侧虽然不再接收完整 h-xmsg，但仍然可以验证：

1. 这条消息绑定了完整 h-xmsg 摘要。
2. 目标链类型必须是 EVM。
3. 目标链 ID 必须是当前链。
4. 动作类型必须是合约调用。
5. 目标合约地址不能被替换。
6. 函数选择器不能被替换。
7. `callData` 不能被替换。
8. `targetExecutionHash` 不能被替换。
9. feedback 策略不能被替换。
10. 过期时间不能被替换。

## 6. 为什么 gas 会明显下降

### 6.1 去掉了动态字符串 storage

原目标合约把业务字段写入 storage，例如：

```text
op
recordId
actor
amount
metadata
```

这些字段是动态字符串，写入成本很高。优化后不再把业务明文写入 storage，只记录 `payloadHash`。

这是 gas 降幅最大的原因。

### 6.2 去掉了历史数组和多维索引

原目标合约每条消息都会追加 `executionHistory`，并维护多个查询索引：

```text
requestIDsByOpHash
requestIDsByRecordIdHash
requestIDsByActorHash
```

这些结构会带来多次 storage 写入。优化后目标链只保留最小执行确认，业务查询交给链下 indexer。

### 6.3 降低了 Gateway calldata

`HXMsgMinimal` 比完整 `HXMsgOnChain` 短，减少了 calldata 体积和 ABI 解码成本。

完整 h-xmsg 不丢失，而是通过 `hmsgDigest` 绑定，并由 TEE 签名的 `deliveryDigest` 保护目标执行字段。

### 6.4 减少了链上完整 h-xmsg 重算

主路径 `executeHXMsgMinimal()` 不再链上重算完整 h-xmsg 的 header、endpoint、verification、binding、feedback 多层摘要。

链上只重算：

1. `targetExecutionHash`。
2. `deliveryDigest`。
3. `keccak256(callData)`。
4. TEE 签名恢复。

### 6.5 仍保留必要的 storage 写入

`processed[requestID] = true` 没有删除，因为这是目标链防重放的必要成本。

`TargetContract` 仍记录 `lastRequestID`、`lastPayloadHash`、`executionCount`，用于证明目标合约确实执行过。第一条消息会因为这些 slot 首次初始化而更贵，后续稳定后 gas 更低。

## 7. 最新测试结果

最新一次测试：

```text
npm run compile: PASS
npm run deploy: PASS
npm run hxmsg:test:forward: 8/8 PASS
```

结果文件：

| 文件 | 说明 |
|---|---|
| `runtime/hxmsg-fabric-evm-results.json` | 8 条测试 JSON 结果 |
| `runtime/hxmsg-test-summary.md` | Markdown 汇总 |

最新 gas：

| 用例 | Gas |
|---|---:|
| FABRIC-001 | 145,501 |
| FABRIC-002 | 95,661 |
| FABRIC-003 | 94,851 |
| FABRIC-004 | 94,647 |
| FABRIC-005 | 94,815 |
| FABRIC-006 | 94,574 |
| FABRIC-007 | 94,224 |
| FABRIC-008 | 94,935 |

第一条消息包含轻量目标合约首次状态初始化成本。后续稳定区间约为：

```text
94,224 - 95,661 gas
```

优化前测试区间约为：

```text
445k - 586k gas
```

因此，本次下降主要来自目标合约 storage 大幅减少，其次来自 `HXMsgMinimal` 降低 calldata 和链上 hash 计算。

## 8. 没有削弱哪些安全边界

本次优化没有删除以下安全边界：

1. Fabric 具体交易存在性验证。
2. Fabric transaction VALID 状态检查。
3. Fabric 写集 `crosschainEvents:{requestID}` 检查。
4. Fabric peer endorsement 签名验证。
5. MSP 根证书和 policyHash 检查。
6. 完整 h-xmsg 的 `hmsgDigest`。
7. TEE 签名验证。
8. TEE 注册表检查。
9. `requestID` 防重放。
10. `expireAt` 过期检查。
11. `targetChainType / targetChainID` 检查。
12. `actionType` 检查。
13. `targetObject` 检查。
14. `callDataHash` 检查。
15. `targetExecutionHash` 检查。
16. feedback 字段规范性检查。

换句话说，减少的是链上业务展示和索引成本，不是可信跨链消息验证成本。

## 9. 取舍

本次优化的主要取舍是：

```text
链上自解释性下降
链下审计材料更重要
```

因为完整 h-xmsg、业务明文、h-FSV view 和详细 Fabric 证明不再完整提交到 EVM。后续如果用于论文或实验展示，应同时保存：

1. 完整 h-xmsg JSON。
2. TEE verificationResult。
3. h-FSV view 摘要。
4. Fabric block / txId / rwset 验证结果。
5. EVM receipt。
6. 目标合约执行事件。

这更符合消息交互系统的定位：EVM 目标链做最小可信执行确认，完整审计材料由链下系统保存。
