# Automation 完成度与剩余工作

## 1. 当前结论

事件发现、持久游标、自动 finality、自动证明构造、TEE attest、目标提交和 Watcher 自动挑战补偿已经完成重构。普通消息无需人工构造 h-xmsg；源事件与内容寻址材料到齐后，Automation 会自行推进整个 Relayer 工作流。

当前仍不能称为“生产级多实例自治系统”，主要边界是数据库高可用、终态 checkpoint 自动聚合、服务安全加固和真实 TDX 部署。

## 2. 六项完成度

| 项目 | 状态 | 说明 |
|---|---|---|
| 多链事件监听与持久 cursor | 已实现 | Ethereum/Sepolia、Fabric、Avalanche scanner；EVM reorg rollback；Fabric block cursor |
| 自动证明构造与 finality 等待 | 已实现 | receipt MPT、Sync Committee、h-FSV、Warp 均由源链 adapter 构造 |
| Relay 与 Watch 自动串联 | 已实现 | requestID workflow、幂等阶段任务、策略驱动 Watcher |
| ResponseProof 提交 | 按开放中继实现 | 任意 relayer 可提交目标事实材料；TEE 验证后回源链，不设置唯一 responder |
| Lifecycle Checkpoint | 核心已实现 | TEE quorum 认证和链上清理已完成；候选自动聚合/定时触发待补 |
| API 与多实例安全 | 部分实现 | 可选 Bearer key、body limit；JSON store 只允许单进程，未实现数据库事务/RBAC/mTLS |

## 3. 为什么 RESPONSE 不绑定固定 Responder

项目采用开放 relay：目标执行事实公开后，任意节点都能构造 ResponseProof。安全性不依赖构造者身份，而依赖：

1. TEE 使用目标链自己的事实证明验证执行存在；
2. RESPONSE 绑定原始 `requestID/hmsgDigest/targetExecutionHash`；
3. 源链验证 TEE quorum certificate 和防重放；
4. 若所有 relayer 都失效，Watcher 最终 challenge 并执行补偿。

因此没有必要让固定 responder 成为活性单点。尚需补充的是目标执行事件的通用扫描和 response material 的自动发布工具，它只提高活性，不改变安全模型。

## 4. 仍需补齐

### 4.1 自动 Checkpoint 调度

按终态数量、累计状态字节或时间阈值收集 `Completed/Compensated/Failed/Cancelled`，验证 escrow 已收束后自动创建 checkpoint task。成功提交后再移出活动候选集合。

### 4.2 多实例数据库

JSON store 适合当前单机论文原型。多个 Relayer/Watcher 进程需要 PostgreSQL 等事务存储，至少包含：

- idempotency unique constraint；
- `FOR UPDATE SKIP LOCKED`；
- lease fencing token；
- cursor/event/task transactional outbox；
- EVM nonce 协调或独立发送账户。

### 4.3 服务安全

TDX/服务器部署前应增加 mTLS、角色权限、schema 校验、速率限制、审计日志、密钥托管与最小权限服务账户。当前 Bearer key 仅适合隔离网络实验。

### 4.4 真实 TEE 运行时

把模拟 quote/measurement 替换为 TDX remote attestation，把 TEE 私钥改为 enclave 内生成和 sealed storage，并为 Raft 增加 WAL/snapshot/log compaction。

## 5. 验收结果

- Ethereum -> Avalanche 事件驱动真实转账：PASS；
- Fabric -> Ethereum h-FSV 事件驱动真实转账：PASS；
- Ethereum -> Fabric receipt proof 事件驱动真实入账：PASS；
- Watcher token escrow challenge/真实退款：PASS；
- Challenge suite：7/7 PASS；
- Lifecycle checkpoint：PASS；
- Raft fault suite：6/6 PASS。

完整改造说明见 `docs/event-driven-relayer-watcher-refactor.md` 和 `docs/persistent-automation-and-lifecycle-checkpoint.md`。
