# Raft 未实现与待增强项

## 1. 当前已经实现的 Raft 主路径

当前项目已经在 Node.js 模拟 TEE 集群中实现 Raft 风格的主路径：

1. `currentTerm`
2. `votedFor`
3. `follower / candidate / leader`
4. `RequestVote`
5. `AppendEntries`
6. leader election
7. heartbeat
8. log consistency check
9. log replication
10. `commitIndex`
11. `lastApplied`
12. committed 后才允许 TEE 签名
13. leader 为 follower 维护 `nextIndex / matchIndex`
14. follower 日志落后时进行后缀补齐
15. 内部 Raft RPC HMAC 认证
16. Raft 专项故障测试脚本

该实现已经可以支撑当前 h-xmsg 跨链实验：TEE 集群对同一条 h-xmsg 达成日志提交后，才返回可被目标链验证的 TEE quorum 证明。

## 2. 尚未实现的生产级 Raft 能力

### 2.1 Snapshot

当前 Raft log 会持续增长，没有实现 snapshot。

后续需要实现：

1. 周期性生成状态机 snapshot。
2. 将已被 snapshot 覆盖的旧 log 安全裁剪。
3. follower 落后过多时，通过 snapshot 快速恢复。

### 2.2 Log compaction

当前没有日志压缩机制。长期运行后，TEE 节点的 `tee-consensus-*.json` 会越来越大。

后续需要实现：

1. 按 `lastIncludedIndex / lastIncludedTerm` 裁剪日志。
2. 保留足够的近期日志用于 follower 追赶。
3. 将已处理 requestID、policy checkpoint、chain header checkpoint 写入压缩状态。

### 2.3 InstallSnapshot RPC

当前只有 `RequestVote` 和 `AppendEntries`，没有 `InstallSnapshot`。

后续需要新增：

```text
POST /internal/raft/install-snapshot
```

用于恢复严重落后的 follower。

### 2.4 持久化 WAL

当前 Raft 状态通过 JSON 文件保存，适合实验，但不是生产级 WAL。

后续需要：

1. 原子写入。
2. fsync。
3. 崩溃恢复测试。
4. 防止部分写入导致状态损坏。

### 2.5 网络分区恢复测试

当前已新增 `npm run raft:test`，覆盖 leader crash、follower crash、节点重启和未认证内部 RPC 拒绝。

但它仍不是完整网络分区测试。后续还需要更系统地测试：

需要补充场景：

1. leader 被隔离。
2. minority partition 不能提交新日志。
3. majority partition 选出新 leader。
4. old leader 恢复后必须 step down。
5. 日志冲突必须被新 leader 覆盖。

### 2.6 动态成员变更

当前 TEE 节点列表由 `TEE_CLUSTER_PEERS` 静态配置。

尚未实现：

1. joint consensus。
2. 动态加入 TEE。
3. 动态移除 TEE。
4. TEE 证书、版本、远程证明与成员身份绑定。

### 2.7 Leader lease / ReadIndex

当前项目主要处理写入型 attestation 请求，没有实现线性一致读优化。

后续如果 TEE 需要对外暴露一致性读取，例如 policy checkpoint、header checkpoint、processed request 状态，需要实现：

1. ReadIndex。
2. leader lease。
3. follower read forwarding。

### 2.8 成熟的故障注入测试

当前已经加入基础 Raft 专项测试：

1. 未认证内部 RPC 拒绝。
2. leader election。
3. follower crash/rejoin。
4. leader crash/re-election/rejoin。

仍需进一步增加：

1. follower 长时间落后后的大量日志追赶测试。
2. 重复 AppendEntries 测试。
3. 日志冲突覆盖测试。
4. 超时和乱序网络测试。
5. majority / minority partition 的可提交性测试。

### 2.9 内部 RPC 认证的生产化

当前内部 Raft RPC 已经从无认证升级为 HMAC 认证，适合论文原型和单机/多机实验。

但真实 TEE 部署时仍需升级为：

1. mTLS。
2. TEE remote attestation 绑定节点证书。
3. 代码版本 hash / measurement 绑定。
4. 节点证书轮换与吊销。

## 3. 与真实 TEE 部署相关但不属于 Raft 本身的部分

以下能力不是 Raft 协议本身，但是真实 TEE 集群部署必须补齐：

1. TEE remote attestation。
2. TEE 内部私钥封存。
3. TEE 代码版本 hash 与注册表绑定。
4. TEE 节点证书生命周期管理。
5. TEE 节点升级策略。
6. TEE 故障节点隔离和恢复流程。

当前 Node.js 版本用于验证协议结构和跨链流程，不提供硬件隔离保证。

## 4. 当前实现边界总结

当前项目已经从“quorum append/commit 模拟”推进到“Raft 主路径实现”，但还不是生产级 Raft 库。

可以认为当前已经完成：

```text
Raft attestation happy path
```

尚未完成：

```text
Production-grade Raft operation
```

后续建议优先级：

1. 增加 Raft 故障注入测试。
2. 实现日志冲突覆盖和恢复用例。
3. 实现 snapshot / log compaction。
4. 替换 JSON 持久化为 WAL。
5. 接入真实 TEE remote attestation。
