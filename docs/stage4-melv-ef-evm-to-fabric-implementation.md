# 第四阶段：MELV-EF EVM -> Fabric 实施说明

## 1. 目标

本阶段把项目从第三阶段的 Fabric -> EVM 扩展到 EVM -> Fabric。设计参考 Mercury 的核心思路：

```text
TEE 像轻客户端一样维护/检查源链区块头
TEE 独立验证源链交易和事件存在性
目标链只做 TEE 签名、防重放和目标执行摘要验证
```

当前实现仍是模拟 TEE，但代码边界按后续真实 TEE 服务器部署预留。

## 2. 本次新增能力

| 能力 | 当前状态 |
|---|---|
| EVM 标准源事件 | 已实现 `CrossChainCallRequested` |
| EVM -> Fabric h-xmsg builder | 已实现 `hxmsg-builder/evm-to-fabric.js` |
| MELV-EF TEE adapter | 已实现 `tee-verifier/adapters/evm-melv-adapter.js`，要求 receipt MPT proof |
| EVM receipt MPT proof | 已实现 `shared/evm/receipt-proof.js` |
| TEE header window | 已实现，每个 TEE 独立维护有限 EVM header window |
| 4 TEE 集群 / Raft | 已实现 4 个 TEE 节点，支持 leader election、heartbeat、日志复制、commitIndex，阈值默认 3/4 |
| Fabric h-xmsg 入站入口 | 已实现 `ExecuteHXMsg` |
| Fabric TEE registry | 已实现 `RegisterTrustedTEE` / `QueryTrustedTEE` |
| EVM -> Fabric 测试 | 已实现 `npm run hxmsg:test:evm-fabric` |
| Fabric -> EVM 回归 | 已通过 `npm run hxmsg:test:forward` |

## 3. 主要修改文件

| 文件 | 说明 |
|---|---|
| `contracts/EvmSourceContract.sol` | 新增 `submitRequest()`、标准事件、请求状态机和挑战响应接口骨架 |
| `hxmsg-builder/evm-to-fabric.js` | 从 EVM receipt/log 构造完整 h-xmsg |
| `tee-verifier/adapters/evm-melv-adapter.js` | 验证 EVM receipt MPT proof、block header window、log、确认数/finalized checkpoint 和 h-xmsg 绑定关系 |
| `tee-verifier/server.js` | 增加 source chain dispatcher、Raft RequestVote / AppendEntries / heartbeat / commit、`/raft/status` 和 committed signing 接口 |
| `tee-verifier/core/certification.js` | Fabric 目标链签名 `hmsgDigest`，EVM 目标链签名 `deliveryDigest` |
| `fabric-chaincode/xcall/index.js` | 新增 h-xmsg 入站执行、TEE 签名阈值验证、执行记录 |
| `scripts/request-evm-fabric-call.js` | 调用新的 EVM `submitRequest()` |
| `scripts/run-evm-fabric-tests.js` | EVM -> Fabric 自动化测试 |
| `relayer/evm-to-fabric.js` | 改为 `/attest` + `ExecuteHXMsg` 主路径 |
| `docker-compose.yml` | 增加 4 个 TEE 节点 |
| `shared/hxmsg/evm-melv-policy.js` | 新增 EVM finality policy 构造 |

## 4. EVM 源链变化

`EvmSourceContract` 不再只发旧的 `FabricCallRequested(uint64,string)`，而是提供标准源请求：

```solidity
event CrossChainCallRequested(
    bytes32 indexed requestID,
    address indexed sender,
    bytes32 indexed targetChainID,
    bytes32 targetDomainID,
    bytes32 targetObject,
    bytes4 functionSelector,
    bytes32 callDataHash,
    bytes32 businessPayloadHash,
    bytes32 receiver,
    uint64 nonce,
    uint64 expireAt
);
```

该事件字段与 h-xmsg 一一绑定。TEE 后续从 receipt log 中重新解析这些字段，并检查它们与 h-xmsg 的 `header / target / targetAction / payloadBinding` 一致。

合约中也保留了 Mercury 风格状态机接口骨架：

```text
Pending -> Challenged -> Completed
Pending -> Challenged -> Refunded
```

当前普通消息调用不强制使用 challenge/refund，后续涉及资产锁定时再完善。

## 5. TEE 的 MELV-EF 验证

TEE 的 EVM adapter 会执行：

1. 检查 `source.chainType = EVM`。
2. 检查 `target.chainType = Fabric`。
3. 检查 `verificationMethod = EVM_LIGHT_CLIENT`。
4. 解码 `sourceRef.encodedRef`，定位 `txHash / blockNumber / blockHash / logIndex / sourceContract`。
5. 检查 `sourceRef.refHash`。
6. 要求 relayer 提供 receipt MPT proof。
7. 使用 TEE 本地维护的 EVM header window 中的 `receiptsRoot` 验证 receipt proof。
8. 检查 receipt 的 `blockHash / blockNumber / txHash`。
9. 检查确认数或 finalized checkpoint 满足 policy。
10. 解析指定 log。
11. 检查 log address 是可信 `EvmSourceContract`。
12. 检查 topic0 是 `CrossChainCallRequested`。
13. 检查事件参数与 h-xmsg 字段一致。
14. 重新计算 `sourcePayloadHash`。
15. 重新计算 `targetExecutionHash`。
16. 验证通过后只接受共识 append，不立即签名。
17. Raft AppendEntries 成功复制到 majority 后提交同一条共识 entry。
18. 节点只在 entry committed 后签名。

当前没有保留单节点 header-helper 替代服务。每个 TEE 节点通过 EVM RPC 拉取并维护本地有限 header window，再用 header 中的 `receiptsRoot` 验证 receipt MPT proof；后续辅助 TEE 轮换委员会应接入到这个 header 更新边界，而不是绕过 TEE 本地验证。

## 6. 4 TEE / Raft 共识

当前 Docker 中启动：

```text
tee-verifier-1  equal TEE
tee-verifier-2  equal TEE
tee-verifier-3  equal TEE
tee-verifier-4  equal TEE
```

任意 TEE 节点都可以接收 `/attest`。如果当前节点不是 leader，会转发到已知 leader；如果没有 leader，会发起一轮 RequestVote 选举。leader 不是安全根，只是 Raft 协议当前 term 的日志复制协调者。

当前模拟实现的流程：

1. 节点通过 `/internal/raft/request-vote` 完成 term 和投票。
2. leader 周期性发送 heartbeat。
3. leader 本地独立验证 h-xmsg。
4. leader 构造 log entry，字段包括 `requestID / hmsgDigest / signingDigest / signatureDigestType / term / index / entryDigest`。
5. leader 调用其他 TEE 的 `/internal/raft/append-entries`。
6. 每个 TEE 收到 entry 后，重新计算 entry digest，并独立执行 h-FSV 或 MELV-EF 验证。
7. entry 复制到 Raft majority 后，leader 更新 `commitIndex`。
8. leader 通过 heartbeat/AppendEntries 将 `leaderCommit` 推送给 followers。
9. 每个 TEE 只有在本地 entry 已 committed 后，才允许 `/internal/raft/sign-committed` 生成签名。
10. leader 汇总 committed 节点的签名，形成 `teeClusterCertification`。

返回的 `teeClusterCertification` 包含：

```text
algorithm = mercury-raft-tee-cluster
proposerID
leaderID
term
index
entryDigest
threshold
raftMajority
reached
quorumReached
signingDigest
signatureDigestType
certifications[]
appendAcks[]
commitAcks[]
certAcks[]
verificationResults[]
```

当前默认阈值是 3/4，Raft majority 也是 3/4。当前实现已经具备 RequestVote、AppendEntries、leader election、heartbeat、日志一致性检查、commitIndex 和提交后签名。仍未实现生产级 Raft 的 snapshot、日志压缩、复杂网络分区恢复和长期运行压测。

## 7. Fabric 目标链验证

Fabric 链码新增：

```text
RegisterTrustedTEE(teeAddress)
QueryTrustedTEE(teeAddress)
ExecuteHXMsg(hxmsgJson, callDataHex, certJson)
```

`ExecuteHXMsg` 会检查：

1. `requestID` 未消费。
2. h-xmsg 未过期。
3. `target.chainType == Fabric`。
4. `targetAction.actionType == CHAINCODE_INVOKE`。
5. `target.chainID / target.domainID` 匹配当前 Fabric channel/domain。
6. `targetObject` 匹配当前 `mychannel/xcall`。
7. `keccak256(callData) == callDataHash`。
8. `targetExecutionHash` 正确。
9. TEE 签名覆盖完整 `hmsgDigest`。
10. TEE 地址已注册。
11. 满足 TEE 阈值。

执行成功后写入：

```text
crosschainExec:{requestID}
inbound:{requestID}
hxmsg-consumed:{requestID}
```

## 8. 对 Fabric -> EVM 的影响

TEE 从单节点升级为 4 节点集群后，Fabric -> EVM 也改为经过 Raft 日志复制和 commit。EVM 目标链不再使用单个 `teeCertification`，而是调用 `HXMsgGateway.executeHXMsgMinimalCluster()`，链上验证多 TEE 阈值签名。

这意味着：

1. 原 Fabric -> EVM 流程没有被破坏。
2. 测试脚本会注册所有 committed TEE 地址。
3. EVM 链上要求签名数量达到阈值，且不能重复使用同一 TEE 地址。
4. 由于 EVM 侧多验证了 3 个 TEE 签名，gas 高于之前单签名低 gas 路径，这是可信边界增强带来的预期成本。

## 9. 测试结果

EVM -> Fabric：

```text
npm run hxmsg:test:evm-fabric
FINAL 1/1 passed, 0 failed
```

结果文件：

```text
runtime/hxmsg-evm-fabric-results.json
runtime/hxmsg-evm-fabric-summary.md
```

关键结果：

```text
TEE adapter: evm-melv-ef
TEE quorum: 4/3 reached
threshold: 3
Fabric inbound status: executed
```

Fabric -> EVM 回归：

```text
npm run hxmsg:test:forward
FINAL 8/8 passed, 0 failed
```

最新 Fabric -> EVM gas 区间：

```text
最新区间: 130,982 - 132,491
稳定区间: 约 131k - 132k
```

## 10. 当前边界

当前已经实现第四阶段可运行闭环，但仍有几个实验边界：

1. TEE 仍是 Node.js 模拟服务，不是真实硬件 TEE。
2. 共识层已经实现本地 Raft 主路径，但还缺少 snapshot、日志压缩、长期故障恢复和系统化分区测试。
3. Mercury 辅助 TEE 轮换委员会尚未实现；当前不使用单节点替代服务。
4. receipt MPT proof 已实现；真实 PoS finalized checkpoint 仍需接入 beacon light client update，Hardhat 本地环境使用 RPC `finalized` 标签或确认数回退。
5. Fabric 侧 TEE registry 当前由 `Org1MSP` 管理身份注册，后续应扩展为多组织治理策略。

这些边界不影响当前实验说明：TEE 已独立验证 EVM 上的交易 receipt/log 与 h-xmsg 绑定关系，Fabric 目标链只接受满足 TEE quorum 的 h-xmsg 执行。
