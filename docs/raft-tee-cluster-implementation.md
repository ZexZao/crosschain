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
15. leader 侧为每个 follower 维护 `nextIndex / matchIndex`
16. follower 落后时通过 AppendEntries 前缀补齐进行日志追赶
17. 内部 Raft RPC 使用共享密钥 HMAC 做节点身份认证
18. Raft 故障测试脚本覆盖选主、follower crash/rejoin、leader crash/re-election

未实现或仍需增强：

1. snapshot。
2. log compaction。
3. 复杂网络分区后的长期恢复测试。
4. 成员动态变更。
5. 生产级持久化 WAL。
6. 真实 TEE remote attestation。
7. HMAC 认证仍是实验实现，真实部署应替换为 mTLS + TEE remote attestation 绑定。

## 3. 节点配置

当前 Docker 中运行 5 个 TEE 节点：

```text
tee-verifier-1
tee-verifier-2
tee-verifier-3
tee-verifier-4
tee-verifier-5
```

每个节点都配置其他 4 个 peer：

```text
TEE_CLUSTER_PEERS=http://...
TEE_CLUSTER_THRESHOLD=3
```

当前配置是 5 节点、阈值 3。Raft majority 也是 3。

当前实验采用 `N=5, threshold=3`，对应 Mercury 中常见的 `2f+1` TEE、`f+1` quorum 表述，可容忍最多 2 个 TEE 异常时仍要求至少 3 个 TEE 对同一已验证事实达成提交和签名。

## 4. 请求流程

用户或 relayer 可以向任意 TEE 节点提交 `/attest`。

如果当前节点是 leader：

```text
/attest
  -> 本地验证 h-xmsg
  -> 构造 Raft log entry
  -> AppendEntries 到其他 TEE
  -> 对落后 follower 使用 nextIndex/matchIndex 补齐日志前缀
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

## 6.1 日志追赶

Leader 为每个 follower 维护：

```text
nextIndex
matchIndex
```

当 follower 因为宕机、重启或网络短暂中断导致日志落后时，leader 会从 `nextIndex` 开始发送后缀日志。若 follower 返回 log consistency check failed，leader 回退 `nextIndex` 并重试，直到找到双方一致的前缀，再补齐缺失日志。

这比之前的单次 `prevLogIndex=0` 重试更接近标准 Raft，也避免 follower 只收到最新 entry 而缺失历史前缀。

## 7. 提交后签名

TEE 签名接口为：

```text
POST /internal/raft/sign-committed
```

节点只有在本地 log entry 状态为 `committed` 时才会调用 `buildCertification()`。

这样避免了“验证通过但尚未被 Raft commit 的 TEE 签名”进入目标链。

## 7.1 内部 RPC 认证

内部 Raft RPC 包括：

```text
POST /internal/raft/request-vote
POST /internal/raft/append-entries
POST /internal/raft/sign-committed
```

这些接口现在要求请求头携带：

```text
x-tee-node-id
x-tee-raft-ts
x-tee-raft-signature
```

签名使用 `TEE_RAFT_SHARED_SECRET` 计算 HMAC-SHA256，覆盖发送方、时间戳、HTTP 方法、路径和稳定序列化后的请求体。接收方检查：

1. 发送方必须在静态 peer 列表中。
2. 发送方不能伪装成本节点。
3. 时间戳不能过期。
4. HMAC 必须匹配。
5. `candidateID / leaderID` 必须与认证发送方一致。

这能防止普通外部请求直接调用内部 Raft 接口。真实 TEE 部署时，应将该实验 HMAC 替换或增强为 mTLS、TEE remote attestation、节点证书和代码版本哈希绑定。

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

## 10. Raft 专项测试

新增脚本：

```bash
npm run raft:test
```

该脚本会启动 EVM + 5 个 TEE verifier，并测试：

1. 未认证内部 Raft RPC 被拒绝。
2. 5 节点集群能选出 leader。
3. 单个 follower 停止后，剩余 4 节点仍能维持 majority。
4. follower 重启后能重新加入。
5. 当前 leader 停止后，剩余 majority 能重新选主。
6. 旧 leader 重启后能观察当前集群并退回 follower/同步状态。

测试结果保存到：

```text
runtime/raft-cluster-test-results.json
runtime/raft-cluster-test-summary.md
```
