# Raft TEE 集群实现说明

## 1. 目标

本次改造将原先的 Mercury-like quorum append/commit 升级为 Raft 风格的 TEE 集群共识层。

当前仍然是 Node.js 模拟 TEE，不是真实硬件 TEE；但 Raft 协议主路径已经在本地 Docker 多节点环境中实现，可在后续真实 TEE 服务器部署时继续复用。

## 2. 当前实现范围

已实现：

1. `currentTerm`
2. `votedFor`
3. `role = follower / candidate / leader`
4. `leaderID`
5. `RequestVote`
6. `AppendEntries`
7. leader election
8. heartbeat
9. log consistency check
10. log replication
11. `commitIndex`
12. `lastApplied`
13. committed 后才允许 TEE 签名
14. `/raft/status` 状态查询

未实现或仍需增强：

1. snapshot。
2. log compaction。
3. 复杂网络分区后的长期恢复测试。
4. 成员动态变更。
5. 生产级持久化 WAL。
6. 真实 TEE remote attestation。

## 3. 节点配置

当前 Docker 中运行 4 个 TEE 节点：

```text
tee-verifier-1
tee-verifier-2
tee-verifier-3
tee-verifier-4
```

每个节点都配置其他 3 个 peer：

```text
TEE_CLUSTER_PEERS=http://...
TEE_CLUSTER_THRESHOLD=3
```

当前配置是 4 节点、阈值 3。Raft majority 也是 3。

## 4. 请求流程

用户或 relayer 可以向任意 TEE 节点提交 `/attest`。

如果当前节点是 leader：

```text
/attest
  -> 本地验证 h-xmsg
  -> 构造 Raft log entry
  -> AppendEntries 到其他 TEE
  -> majority 复制成功
  -> 更新 commitIndex
  -> 通知 followers commit
  -> committed 节点签名
  -> 返回 teeClusterCertification
```

如果当前节点不是 leader：

```text
/attest
  -> 若已知 leader，转发给 leader
  -> 若未知 leader，发起 RequestVote 选举
  -> 成为 leader 后处理请求
```

## 5. Log Entry 绑定内容

Raft log entry 绑定：

```text
index
term
proposerID
requestID
hmsgDigest
signingDigest
signatureDigestType
sourceChainType
targetChainType
entryDigest
hxmsg
helperData
```

其中：

| 字段 | 说明 |
|---|---|
| `hmsgDigest` | 完整 h-xmsg 摘要 |
| `signingDigest` | TEE 实际签名摘要，EVM 目标链为 `deliveryDigest`，Fabric 目标链为 `hmsgDigest` |
| `entryDigest` | Raft entry 的一致性摘要 |
| `hxmsg` | follower 独立验证所需的完整消息 |
| `helperData` | Fabric block bytes 等辅助证明材料 |

## 6. 独立验证

Follower 收到 `AppendEntries` 后，不会直接信任 leader 的验证结果，而是执行：

1. 重新计算 entry digest。
2. 检查 entry 与 h-xmsg 的 `requestID / hmsgDigest / signingDigest` 一致。
3. 根据 source chain type 调用 h-FSV 或 MELV-EF adapter。
4. 验证通过后才 append 到本地 log。

这保证 Raft 复制的是“各 TEE 独立验证后接受的消息”，不是 leader 单方面声明的结果。

## 7. 提交后签名

TEE 签名接口为：

```text
POST /internal/raft/sign-committed
```

节点只有在本地 log entry 状态为 `committed` 时才会调用 `buildCertification()`。

这样避免了“验证通过但尚未被 Raft commit 的 TEE 签名”进入目标链。

## 8. 返回证明

`teeClusterCertification` 当前包含：

```text
algorithm = mercury-raft-tee-cluster
proposerID
leaderID
term
index
entryDigest
threshold
raftMajority
totalConfigured
reached
quorumReached
hmsgDigest
signingDigest
signatureDigestType
certifications[]
appendAcks[]
commitAcks[]
certAcks[]
verificationResults[]
```

目标链仍只验证必要的证明字段：

1. `hmsgDigest`
2. TEE 签名
3. TEE 注册状态
4. 阈值
5. 防重放和目标执行绑定

Raft metadata 主要用于审计、调试和实验记录。

## 9. 与 Mercury 设计的关系

该实现贴近 Mercury 中“多个 TEE 使用 Raft 达成一致”的方向：

1. 多个 TEE 节点共同维护验证服务状态。
2. TEE 之间使用日志复制对消息顺序和提交状态达成一致。
3. 目标链只接受达到阈值的 TEE 证明。
4. 单个 TEE 无法独自出具可被目标链接受的证明。

仍需注意：Raft 是 crash fault tolerant，不是 Byzantine fault tolerant。项目的安全假设仍然依赖 TEE 运行时可信、TEE 私钥受保护、TEE 代码可远程证明。
