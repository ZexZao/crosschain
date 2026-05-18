# Mercury-like 平等 TEE 共识改造说明

> 更新：当前项目已经在此基础上继续实现了 Raft 风格的 RequestVote、AppendEntries、leader election、heartbeat、日志复制和 commitIndex。最新实现说明见 `docs/raft-tee-cluster-implementation.md`。本文保留为从单节点 TEE 过渡到多 TEE 平等验证的设计记录。

## 目标

本次改造修正了之前 TEE 集群中“固定 leader 聚合认证”的表达方式。新的实现更贴近 Mercury 的设计初衷：TEE 节点是平等的验证者，单个节点不能单独决定跨链消息成立。

当前仍是 Node.js 模拟 TEE，不是真实硬件 TEE；但代码边界已经按后续真实 TEE 和真实 Raft 部署预留。

## 当前实现

TEE 集群包含 4 个节点，默认阈值为 3/4。任意 TEE 都可以接收 `/attest` 请求，并作为本轮 proposer 发起共识。proposer 不是安全根，只是本轮请求的协调者。

处理流程如下：

1. proposer 独立验证完整 h-xmsg。
2. proposer 构造共识 entry。
3. proposer 将 entry 发送给其他 TEE 的 `/internal/consensus/append`。
4. 每个 TEE 重新计算 entry 摘要，并独立执行 h-FSV 或 MELV-EF 验证。
5. append 达到阈值后，proposer 发送 `/internal/consensus/commit`。
6. 每个 TEE 只有在本地 entry committed 后才签名。
7. proposer 汇总 committed TEE 的签名，返回 `teeClusterCertification`。

共识 entry 绑定以下内容：

```text
term
index
proposerID
requestID
hmsgDigest
signingDigest
signatureDigestType
sourceChainType
targetChainType
entryDigest
```

其中 `signingDigest` 根据目标链不同而不同：

| 目标链 | TEE 签名内容 |
|---|---|
| EVM | `deliveryDigest` |
| Fabric | `hmsgDigest` |

## 与之前实现的区别

之前实现中，主节点调用 follower 的认证接口，收集签名后返回。这种方式虽然能形成多个 TEE 签名，但容易被理解为固定 leader 是权威节点，而且签名发生在“集群提交”之前。

现在的实现改为：

| 项目 | 之前 | 现在 |
|---|---|---|
| 节点关系 | 固定 leader + follower | 4 个平等 TEE |
| 请求入口 | 默认 leader | 任意 TEE 可作为本轮 proposer |
| follower 行为 | 验证后直接签名 | append 时独立验证，commit 后才签名 |
| 集群结果 | 聚合认证结果 | quorum committed entry |
| EVM 目标链 | 单 TEE 签名 | `HXMsgMinimalCluster` 阈值签名 |

## 对两条跨链方向的影响

Fabric -> EVM：

- TEE 仍严格执行 h-FSV 验证。
- TEE 集群对同一 `deliveryDigest` 达成 quorum commit。
- EVM 链上调用 `executeHXMsgMinimalCluster()`。
- EVM 链上验证多个 TEE 签名、TEE 注册状态和重复签名。

EVM -> Fabric：

- TEE 仍按 MELV-EF adapter 验证 EVM receipt、log、header 和 finality。
- TEE 集群对同一 `hmsgDigest` 达成 quorum commit。
- Fabric 链码验证 TEE quorum 后执行 `ExecuteHXMsg`。

## 当前边界

当前不是完整生产级 Raft，还缺少：

1. 自动 leader election。
2. 日志冲突恢复。
3. 网络分区恢复。
4. snapshot / compaction。
5. 真实 TEE remote attestation。
6. 真实 TEE 内部密钥封存。

但当前实现已经满足实验阶段最重要的安全语义：多个 TEE 独立验证源链事实，对同一条 h-xmsg 达成提交后才签名，目标链只接受达到阈值的 TEE 证明。
