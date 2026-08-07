# 跨链 Gas 优化实现说明

## 1. 文档目的

本文汇总项目当前采用的 gas 优化方法、实际降低成本的原因、安全边界和实验统计口径。

优化目标不是删除源链事实证明、TEE 验证或真实业务执行，而是减少以下重复成本：

- 完整 h-xmsg 的目标链 calldata；
- 动态字符串和通用业务 ABI；
- 每条消息重复验证 TEE quorum；
- 每条消息重复支付交易基础成本；
- 普通单向消息不需要的链上生命周期存储；
- 可由链上事件恢复的重复业务审计 storage；
- 低效防重放 storage；
- 批次中逐消息 Merkle proof；
- TEE Registry 对空 signer 位的无效扫描。

## 2. 优化前后的总体路径

### 2.1 优化前

```text
完整 h-xmsg/动态业务数据
-> 每条消息单独提交目标链
-> 每条消息验证一次 3/5 TEE quorum
-> 每条消息写入防重放和通用业务记录
-> 每条消息单独执行目标业务
```

### 2.2 优化后

```text
canonical h-xmsg 在链下传输并由 TEE 验证
-> 目标链只接收 HXMsgMinimal + CompactCall
-> TEE 对 batchRoot 签名一次
-> 目标链验证一次 quorum certificate
-> 逐条验证 delivery 绑定和防重放
-> 纯资产批次进入真实资产批量路径
```

## 3. 完整 h-xmsg 链下传输，目标链使用 HXMsgMinimal

完整 canonical h-xmsg 保留在链下，用于：

- 表达完整源链、目标链和验证策略；
- 绑定 feedback 和 atomicity；
- 携带源链事实引用；
- 交给 TEE adapter 独立验证。

TEE 验证通过后，目标链只接收执行所需的 `HXMsgMinimal`。该结构仍绑定：

- `requestID`；
- `hmsgDigest`；
- 目标链类型和 chain ID；
- 目标对象与 selector；
- `callDataHash`；
- receiver 和目标执行哈希；
- feedback 策略；
- expireAt；
- replayScope 和 sourceNonce。

减少的是目标链 calldata 和 ABI 解码成本，不是 canonical h-xmsg 的协议语义。

## 4. CompactCall 替代动态业务数据

旧路径需要提交 JSON、字符串或动态 `bytes`。优化后使用固定宽度结构：

```solidity
struct CompactCall {
    uint16 opCode;
    bytes32 recordIdHash;
    bytes32 assetIdHash;
    address actorAddress;
    int256 amount;
    bytes32 metadataHash;
    bool requireAck;
}
```

该优化减少：

- 动态字符串 calldata；
- ABI offset 和 length；
- 链上动态数据复制；
- 重复字符串哈希；
- EVM memory expansion。

`CompactCall` 的全部字段仍由 canonical h-xmsg 中的 `callDataHash` 绑定。Relayer 修改金额、接收者、操作类型或业务记录标识后，目标链哈希检查会失败。

## 5. Mercury-style TEE 批量签名

### 5.1 旧方式

N 条消息分别执行：

```text
N 次目标链交易
+ N 次 quorum certificate 解码
+ 3N 次 ECDSA recover
+ N 次 Registry 查询
+ N 次交易基础成本
```

### 5.2 当前方式

TEE 对一批验证通过的消息构造 Merkle root：

```text
batchID
batchRoot
batchSize
targetChainID
```

上述字段形成 `batchSigningDigest`，5 个 TEE 节点通过 Raft 提交后，由至少 3 个 TEE 签名。目标链只验证一次 batch certificate，再执行 N 条消息。

该优化摊薄：

- 每笔 EVM 交易的基础 gas；
- TEE quorum 验签；
- certificate ABI 解码；
- TEE Registry 状态读取；
- batch 固定处理成本。

批处理没有把 N 条源链交易变成一条源链交易。每条消息仍有独立 requestID、hmsgDigest、sourceNonce、业务参数和防重放状态。

## 6. 删除批次中的逐消息 Merkle proof

兼容入口要求提交：

```text
bytes32[][] merkleProofs
```

最新 compact batch 入口直接根据有序的 `HXMsgMinimal[]` 在链上重算 batch root：

```text
computeRoot(hxmsgs) == signed batchRoot
```

因此可以省去 N 份 `O(log N)` proof 的 calldata 和逐 proof 哈希。目标链仍验证 TEE 签名的 batch root，没有取消 batch 成员绑定。

当前部分旧测试脚本和部分 Sepolia 单条路径仍保留带 `bytes32[][]` 的兼容调用。论文中最低 gas 的本地批量结果来自无逐消息 proof 的优化入口，不应与兼容入口混用统计。

## 7. EVM 源链按策略分层存储

普通单向消息没有 RESPONSE、challenge 或 compensation 状态迁移，因此源链只发出 `CrossChainCallRequested` 事件，不再把事件中已有字段重复写入 storage：

```solidity
if (!policy.feedbackRequired) return;
```

需要 RESPONSE 或原子性的请求仍保存紧凑生命周期记录，包括：

- targetExecutionHash；
- failureActionHash；
- feedbackTimeout；
- challengeWindow 和 challengeDeadline；
- commitmentType；
- lifecycle status；
- responseDigest；
- token escrow 状态。

普通 Ethereum 源请求由约 `291,000-294,000 gas/message` 降至约 `38,000-42,000 gas/message`，下降约 86%。

该优化不会削弱普通消息真实性。TEE 仍使用可信区块头、receipt MPT proof 和 receipt log 验证源链事件，并检查事件字段与 h-xmsg 一致。

## 8. Replay bitmap 压缩防重放 storage

目标链使用以下标识确定消息顺序：

```text
replayScope = H(sourceChainType, sourceChainID, sourceDomainID, nonceScope)
sourceNonce = header.nonce
```

防重放状态按 256-bit bitmap 保存，一个 storage word 最多记录 256 个 nonce。Fabric 为降低相邻 nonce 的 world-state 写冲突，还按低 4 bit 分散到 16 个 lane。

相较于每个 requestID 独占一个布尔 storage slot，该方式具有以下优势：

- 多条消息共享一个 storage word；
- 第一次写入后，后续 bit 通常属于非零到非零更新；
- 降低长期防重放 storage 增长；
- 降低 Fabric 相邻 nonce 的并发写冲突。

防重放没有删除。`replayScope` 和 `sourceNonce` 同时包含在 TEE delivery digest 中，Relayer不能替换命名空间后绕过 bitmap。

## 9. 纯资产批量真实执行路径

纯资产批次不再逐条进入通用业务记录路径，而是一次调用：

```solidity
TargetContract.executeAssetBatch(requestIDs, calls)
```

其中：

- `token_transfer` 调用真实 ERC20 `transfer`，从目标资产服务 reserve 扣款并增加接收账户余额；
- `asset_lock`、`mint_confirm`、`subsidy_confirm` 根据业务语义执行真实 mint；
- 每条消息仍执行 callDataHash、过期时间、目标链、目标对象和防重放检查。

资产快速路径不再重复写入：

- CompactBusinessRecord；
- 通用业务索引；
- 每条消息的辅助 mapping；
- 可由事件恢复的重复审计字段；
- 每条消息独立的 TargetContract 外部调用。

保留的成本包括：

- replay bitmap；
- ERC20 余额真实 SSTORE；
- reserve 和 recipient 余额变化；
- Transfer 事件；
- batch 与逐消息执行事件；
- TEE quorum 验证。

因此该路径不是空壳状态更新。实验会在执行前后检查 reserve 和所有接收账户的真实 token 余额。

## 10. TEE Registry signer bitmap 优化

TEE Registry 原本可能扫描完整 256-bit signer 空间。当前实现只遍历 `signerBitmap` 的有效长度：

```solidity
while (remainingBitmap != 0) {
    ...
    remainingBitmap >>= 1;
}
```

仍然逐一检查：

- signer index 是否已注册；
- TEE 是否有效；
- ECDSA recover 结果；
- enclave public key hash；
- selectedSignerHash；
- participantCount 和 threshold。

减少的是空 signer 位循环，不是签名安全检查。

## 11. Lifecycle Checkpoint 控制长期存储

终态请求经过源链重算和 TEE quorum 认证后，可以通过 lifecycle checkpoint 批量清理：

- Completed；
- Compensated；
- Failed；
- Cancelled；
- 已 Settled 或 Refunded 的 escrow 状态。

Checkpoint 主要控制长期 storage 和 Fabric world state 增长。它不一定降低当前消息的即时 gas，但可以避免协议状态无限积累。

不会清理：

- 目标链真实业务结果；
- token 余额；
- EVM/Avalanche 事件日志；
- Fabric 账本历史；
- 累计 checkpoint root 和 epoch。

## 12. 实测结果

以下数据来自现有本地实验，均按稳定态口径排除一次性 TEE 注册 gas。

### 12.1 纯资产批量路径

| 方向或实验 | Batch size | 源 gas/message | 目标 gas/message | 说明 |
|---|---:|---:|---:|---|
| Ethereum -> Avalanche | 8 | 约 38,737-40,875 | 约 65,041-69,315 | 真实 reserve transfer |
| Avalanche -> Ethereum | 8 | 约 113,667 | 约 64,916-65,040 | 真实 reserve transfer |
| Avalanche -> Ethereum | 20 | 约 114,528 | 约 60,388 | 目标 batch gas 1,207,753 |

Avalanche -> Ethereum 的 batch=20 资产目标执行由优化前约 `491,407 gas/message` 降至约 `60,388 gas/message`，下降约 87.71%。源链与目标链合计由约 `605,076` 降至约 `174,916 gas/message`，下降约 71.09%。

### 12.2 普通源请求

| 项目 | 优化前 | 优化后 |
|---|---:|---:|
| Ethereum 普通源请求 | 约 291,000-294,000 | 约 38,000-42,000 |
| Avalanche compact 源请求 | 约 127,000 | 约 113,000-116,000 |

### 12.3 通用混合业务

应收账款、物流、授权、Oracle 和审批等业务必须真实写入领域状态，不能使用纯资产快速路径。现有混合业务目标执行约为：

```text
约 370,000-480,000 gas/message
```

因此，约 `60,000-69,000 gas/message` 只能代表纯资产批量快速路径，不能作为任意跨链消息的统一 gas 数值。

## 13. Mercury-style 统计口径

当前稳定态统计通常包括：

```text
源链请求 gas
+ 目标链 batch execution gas
+ RESPONSE complete gas（需要 RESPONSE 时）
+ lifecycle checkpoint gas（实验包含 checkpoint 时）
```

以下成本单独统计或不计入稳定态每消息 gas：

- 合约部署；
- 初始资产 reserve 初始化；
- TEE 首次注册；
- Fabric 操作，因为 Fabric 不采用 gas 计费；
- 链下 receipt/Fabric View/Warp proof 构造；
- TEE 内证明验证；
- TEE Raft 网络通信。

TEE 注册是实际存在的一次性成本，不能声称其不存在。论文应分别报告：

```text
初始化成本
稳定态消息成本
批量摊销成本
RESPONSE/atomicity 附加成本
```

## 14. 安全功能保留情况

当前优化没有删除：

- canonical h-xmsg；
- Ethereum receipt MPT proof；
- 真实 Sync Committee/finality 验证；
- Fabric h-FSV View；
- Avalanche Warp 权重签名证明；
- TEE 独立验证；
- 5 节点 Raft 和 3/5 quorum；
- 目标链 TEE certificate 验证；
- callDataHash 和 hmsgDigest 绑定；
- 逐消息 replay protection；
- feedback/atomicity 状态机；
- token escrow、真实退款和结算；
- 真实 ERC20 转账和领域业务状态变化。

优化的原则是：

```text
删除可从可信事件或 digest 恢复的重复数据，
保留决定消息真实性、执行唯一性和资产安全的状态。
```

## 15. 当前限制与论文使用注意事项

1. 低 gas 资产快速路径依赖消息全部属于受支持的资产操作，混合批次会回退到通用路径。
2. 首个接收账户余额从零变为非零时，ERC20 SSTORE 比稳态非零更新更贵，应分别报告冷启动和稳态结果。
3. 部分旧脚本和 Sepolia 兼容路径仍携带逐消息 Merkle proof，不能直接与无 proof 的最低 gas 结果比较。
4. Batch size 增大虽然降低平均验签成本，但会增加单笔 calldata、执行 gas 和失败回滚范围，需要同时测试 1、8、16、20、32 等规模。
5. Fabric 不应人为换算 gas，应报告吞吐、确认时延、CPU、网络和 world-state 写入。
6. reserve transfer 是跨链流动性/金库结算模型，不等同于目标链任意账户 A 到 B 的授权转账。
7. 论文应同时报告真实余额变化、业务状态变化和失败回滚，不能只报告交易成功状态。

## 16. 相关实现

- `contracts/EvmSourceContract.sol`：源链请求与分层生命周期存储；
- `contracts/ResponseLifecycleBase.sol`：RESPONSE、challenge、escrow 和 checkpoint；
- `contracts/HXMsgGateway.sol`：minimal/compact batch、batch root 和 quorum 验证；
- `contracts/TargetContract.sol`：通用业务与资产批量执行；
- `contracts/BusinessServiceContracts.sol`：真实资产和领域业务动作；
- `contracts/TEERegistry.sol`：TEE 注册和 quorum certificate 验证；
- `shared/hxmsg/delivery.js`：canonical h-xmsg 到 minimal delivery；
- `docs/all-directions-gas-optimization.md`：三链六方向历史实验；
- `docs/mercury-style-asset-batch-implementation.md`：资产批量优化实验。
