# h-xmsg / h-FSV 链上 Gas 开销分析与优化方案

## 1. 背景

当前项目的核心目标是异构区块链之间的消息交互。Fabric -> EVM 路径已经实现：

```text
Fabric chaincode state
        |
        v
h-xmsg builder
        |
        v
TEE h-FSV verification
        |
        v
HXMsgGateway on EVM
        |
        v
TargetContract.execute()
```

最新正向测试中，单条 Fabric -> EVM 消息的 EVM gas 大约为：

```text
445k - 586k gas
```

这对于“消息交互”型系统偏高。需要明确的是，h-FSV 的 Fabric peer endorsement、MSP 验证、Fabric 交易存在性验证等大部分复杂逻辑都在 TEE 链下完成；当前高 gas 主要来自 EVM 侧提交与目标合约执行。

截至 2026-05-18，项目已按本文路线实现到阶段 3：

```text
轻量 TargetContract
payload hash-first
HXMsgMinimal 压缩上链提交
TEE deliveryDigest 签名
```

最新 8 条 Fabric -> EVM 正向测试全部通过，EVM gas 降至：

```text
94,224 - 145,501 gas
```

其中第一条消息包含轻量目标合约首次状态初始化成本；后续稳定区间约为：

```text
94,224 - 95,661 gas
```

## 2. 当前 gas 开销来源

### 2.1 TargetContract 存储过重

当前 `contracts/TargetContract.sol` 是为了测试可观测性设计的业务合约，不是低 gas 消息交互合约。

它在每次执行时做了大量链上存储：

1. 解码多个动态字符串。
2. 写入 `lastOp`。
3. 写入 `lastRecordId`。
4. 写入 `lastActor`。
5. 写入 `lastAmount`。
6. 写入 `lastPayloadHash`。
7. 写入 `lastMetadataHash`。
8. 向 `executionHistory` push 完整记录。
9. `ExecutionRecord` 中包含多个 string。
10. 写入 `requestIndexPlusOne`。
11. 写入 `requestIDsByOpHash`。
12. 写入 `requestIDsByRecordIdHash`。
13. 写入 `requestIDsByActorHash`。
14. 事件中输出多个 string。

动态字符串写入 storage 非常昂贵。尤其是新 storage slot 从 `0` 写为非零值时，每个 slot 约消耗 20,000 gas。

因此，当前 gas 的最大来源不是 TEE 证明验证，而是目标业务合约把消息内容当作链上数据库存储。

### 2.2 h-xmsg 链上结构较长

当前 `HXMsgOnChain` 包含：

```text
header
source endpoint
target endpoint
sourceRef hash
targetAction
verification
policyRef
payloadBinding
feedback
nonce / createdAt / expireAt
```

字段较多会带来：

1. calldata 增大。
2. ABI 解码成本增加。
3. `hashHXMsg()` 中多次 `abi.encode` 和 `keccak256`。
4. TEE certification 也需要提交 `requestID / hmsgDigest / teeAddress / verifiedAt / signature`。

不过与目标合约的大量 storage 写入相比，这部分通常不是最大头。

### 2.3 防重放状态写入是必要成本

`HXMsgGateway` 当前维护：

```solidity
mapping(bytes32 => bool) public processed;
```

每条新消息都会执行：

```solidity
processed[hxmsg.requestID] = true;
```

这会产生一次新 storage 写入。该成本无法完全去掉，因为目标链必须防止同一 `requestID` 被重复执行。

### 2.4 TEE 签名验证和 Registry 查询

当前 `HXMsgGateway` 会执行：

```solidity
ecrecover(...)
teeRegistry.trustedTEE(...)
```

这部分包括：

1. `ecrecover` 预编译调用。
2. 外部合约读取 `TEERegistry`。
3. 冷访问账户和 storage 的成本。

该部分有优化空间，但不是当前最主要的 gas 来源。

### 2.5 业务 payload 使用 ABI 动态字符串

当前目标合约接收的业务 payload 是：

```text
(string op, string recordId, string actor, string amount, string metadata, bool requireAck)
```

这对调试和展示友好，但对 gas 不友好。对于消息交互系统，链上通常只需要验证摘要、记录执行状态，不需要长期保存业务明文。

## 3. 优化目标

本项目更适合采用以下链上目标：

```text
链上负责：
1. 验证 TEE / TEE cluster 证明；
2. 验证 requestID 防重放；
3. 验证目标链、目标对象和 callDataHash；
4. 记录最小执行状态；
5. 发出可被链下索引器追踪的事件。

链下负责：
1. 保存完整 h-xmsg；
2. 保存完整业务 payload；
3. 保存 Fabric h-FSV / EVM receipt 等证明材料；
4. 做业务字段索引和查询；
5. 做跨链消息审计和可视化。
```

这样更符合“消息交互”的定位，而不是把 EVM 目标链当作完整业务数据库。

## 4. 优化方案

### 4.1 第一优先级：轻量化 TargetContract

当前最值得优化的是 `TargetContract`。

建议将它从“业务数据存储合约”改为“消息执行确认合约”。

保留：

```solidity
mapping(bytes32 => bool) public processed;
bytes32 public lastRequestID;
bytes32 public lastPayloadHash;
uint256 public executionCount;
```

删除或转移到事件 / 链下索引：

```text
lastOp
lastRecordId
lastActor
lastAmount
executionHistory
requestIDsByOpHash
requestIDsByRecordIdHash
requestIDsByActorHash
```

推荐事件：

```solidity
event MessageExecuted(
    bytes32 indexed requestID,
    address indexed caller,
    bytes32 callDataHash,
    bytes32 businessPayloadHash,
    bool requireAck
);
```

如果需要展示业务字段，可以在事件中输出少量字段，但不建议写入 storage。

预期收益：

```text
gas 降幅最大。
单条消息有机会从 450k+ 降到约 150k - 250k 区间。
```

具体数值取决于最终保留多少事件字段和状态字段。

### 4.2 第二优先级：业务 payload hash-first

当前 payload 中包含多个 string。可以改为摘要优先：

```solidity
struct CompactPayload {
    bytes32 opHash;
    bytes32 recordIdHash;
    bytes32 actorHash;
    bytes32 amountHash;
    bytes32 metadataHash;
    bool requireAck;
}
```

或者目标链完全不解码业务 payload，只检查：

```solidity
keccak256(callData) == hxmsg.callDataHash
```

业务明文保存在：

1. Fabric 源链状态；
2. relayer / indexer 数据库；
3. 事件日志；
4. IPFS / 对象存储；
5. 实验结果 JSON。

目标链只处理摘要。

预期收益：

```text
减少 calldata 动态解码成本。
减少动态字符串 storage 写入。
降低目标合约复杂度。
```

### 4.3 第三优先级：压缩 HXMsgOnChain

当前链上重新计算完整 `hmsgDigest`，所以需要提交较多 h-xmsg 字段。

对于消息交互型系统，可以考虑将链上结构压缩为：

```solidity
struct HXMsgMinimal {
    bytes32 requestID;
    bytes32 hmsgDigest;
    bytes32 targetChainID;
    bytes32 targetObject;
    bytes4 functionSelector;
    bytes32 callDataHash;
    bytes32 targetExecutionHash;
    uint64 expireAt;
    Feedback feedback;
}
```

完整 h-xmsg 保存在链下，TEE 先验证完整 h-xmsg 与 h-FSV，再签名 `deliveryDigest`。`deliveryDigest` 由完整 `hmsgDigest` 和目标链最小执行字段共同组成。目标链只验证：

1. `cert.hmsgDigest == HXMsgMinimal.hmsgDigest`；
2. TEE 对 `deliveryDigest` 的签名；
3. 当前链与目标链匹配；
4. 当前目标对象匹配；
5. `keccak256(callData) == callDataHash`；
6. `targetExecutionHash` 正确；
7. `requestID` 未处理；
8. `expireAt` 未过期。

这种方案会减少 calldata 和链上 hash 计算，但会牺牲一部分链上自解释性。完整 h-xmsg、h-FSV view 和业务明文需要由链下 runtime / indexer / 实验结果文件保存。由于 TEE 签名覆盖 `hmsgDigest + target binding`，relay 不能把已认证消息替换成另一个目标调用。

### 4.4 第四优先级：自定义错误替代字符串 require

当前合约中使用：

```solidity
require(condition, "error string");
```

可以改为：

```solidity
error Expired();
error WrongTargetChain();
error BadTEEProof();
```

然后：

```solidity
if (block.timestamp > expireAt) revert Expired();
```

收益：

1. 降低部署字节码大小。
2. 降低失败路径 gas。
3. 成功路径收益有限，但属于标准优化。

### 4.5 第五优先级：优化 TEERegistry

当前 `HXMsgGateway` 每次调用外部 `TEERegistry`：

```solidity
teeRegistry.trustedTEE(cert.teeAddress)
```

可选优化：

1. 将 trusted TEE mapping 合并进 Gateway。
2. 将单 TEE 地址设为 immutable。
3. 多 TEE 后改为验证 threshold public key。
4. 将 TEE cluster ID 与 threshold key 绑定。

如果后续采用多 TEE + threshold signature，目标链可以只验证一个 threshold signature 和一个 cluster public key，从而避免多签名逐个验证。

### 4.6 第六优先级：批量消息

如果实验需要提高吞吐量，可以引入 batch：

```text
TEE signs batchRoot
message carries Merkle path
target chain verifies batchRoot + Merkle path + callDataHash
```

适用场景：

1. 多条消息同一批提交。
2. relayer 可接受一定延迟。
3. 需要摊薄 TEE 签名和固定验证成本。

不适用场景：

1. 单条低延迟消息。
2. 每条消息都需要即时执行。

## 5. 推荐分阶段改造路线

### 阶段 1：轻量目标合约

目标：

```text
不改变 h-xmsg / h-FSV / TEE 主流程，只改 TargetContract。
```

改动：

1. 新增 `MessageTargetContract` 或重写 `TargetContract`。
2. 不再保存动态字符串。
3. 不再维护历史数组和多维索引。
4. 只记录 `requestID`、`payloadHash`、`executionCount`。
5. 用事件输出执行结果。

风险：

```text
低。
```

这是最推荐优先执行的优化。

### 阶段 2：payload 摘要化

目标：

```text
减少业务 payload 的动态 string 编码和链上 decode。
```

改动：

1. 调整 `encodeBusinessPayload`。
2. 调整测试用例断言，从读取链上 string 改为读取事件或 hash。
3. 保留链下 JSON 结果用于展示。

风险：

```text
中等。
```

因为会影响测试脚本和业务展示方式。

### 阶段 3：压缩 HXMsgOnChain

目标：

```text
进一步降低 Gateway calldata 和 hash 计算成本。
```

改动：

1. 新增 `HXMsgMinimal`。
2. TEE certification 绑定完整 `hmsgDigest`。
3. Gateway 只验证最小必要字段。
4. 完整 h-xmsg 存链下或事件中只输出 digest。

风险：

```text
中等到较高。
```

需要重新论证链上还能验证哪些字段、哪些字段完全交给 TEE。

当前实现状态：

```text
已实现。
```

实现文件：

| 文件 | 作用 |
|---|---|
| `contracts/HXMsgLib.sol` | 新增 `HXMsgMinimal` 与 `hashDelivery()` |
| `contracts/HXMsgGateway.sol` | 主路径收敛为 `executeHXMsgMinimalCluster()` |
| `shared/hxmsg/hash.js` | 新增 `toMinimalHXMsg()` 与 `computeHXMsgDeliveryDigest()` |
| `tee-verifier/core/certification.js` | TEE 改为签名 `deliveryDigest` |
| `contracts/TargetContract.sol` | 改为轻量执行确认合约 |
| `scripts/run-hxmsg-forward-tests.js` | 测试脚本改为提交 `HXMsgMinimal` 并断言 `requestID/payloadHash` |

### 阶段 4：多 TEE / threshold signature

目标：

```text
减少多 TEE 证明时的链上签名验证成本。
```

改动：

1. TEE cluster 产生 threshold signature。
2. Gateway 验证 cluster public key。
3. TEERegistry 升级为 TEEClusterRegistry。

风险：

```text
较高。
```

但与项目后续多 TEE + Raft 方向一致。

## 6. 推荐最终链上模型

对于消息交互系统，推荐最终链上模型是：

```text
Source-chain full fact proof:
  verified inside TEE

Full h-xmsg:
  stored off-chain / emitted as digest

Target chain:
  verifies compact TEE proof
  verifies replay / expiry / target binding
  records minimal execution state
  emits event for indexer
```

链上不应保存完整业务明文，也不应长期维护复杂查询索引。查询索引更适合交给链下 indexer。

## 7. 结论

当前 gas 偏高的主要原因是：

```text
TargetContract 为测试展示保存了大量动态字符串和索引；
HXMsgGateway 提交结构较长；
每条消息都需要防重放 storage 写入和 TEE 签名验证。
```

最优先的优化不是削弱 h-FSV，也不是把 Fabric 验证放回链上，而是：

```text
保留 TEE 链下验证；
保留目标链轻量安全校验；
将目标业务合约改为最小消息执行记录；
业务明文和查询索引交给链下系统。
```

这样既符合异构链消息交互的项目定位，也能显著降低 EVM 侧 gas。
