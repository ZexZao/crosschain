# 事件驱动 Automation 与 Lifecycle Checkpoint

## 1. 实现目标

`automation/` 是运行在 TEE 外的常驻控制面。它不替代源链证明、TEE 验证或目标链合约，而是负责把这些安全组件连接成可恢复的工作流：

```text
source event
-> finality
-> source proof
-> TEE subnet attest
-> target submit
-> optional response/challenge
-> optional lifecycle checkpoint
```

canonical h-xmsg、TEE adapter 和链上验证规则没有为自动化服务另写一套实现。Automation 只能推进满足链上与 TEE 安全检查的任务。

## 2. 目录结构

```text
automation/
├── server.js
├── client.js
├── config.js
├── relayer/
│   ├── adapter-dispatch.js
│   ├── relayer-service.js
│   └── target-submitter.js
├── watcher/
│   ├── chain-client.js
│   └── watcher-service.js
└── shared/
    ├── listener-service.js
    ├── core/
    │   ├── state-machines.js
    │   └── retry-policy.js
    ├── store/automation-store.js
    └── adapters/
        ├── ethereum/
        ├── fabric/
        └── avalanche/
```

`shared/adapters/<chain>/` 各自实现 scanner、finality 和 proof builder。Relayer 与 Watcher 只依赖统一任务模型，不包含某条链的证明细节。

## 3. 监听与持久游标

- Ethereum/Sepolia 扫描 `CrossChainCallRequested` 日志；
- Avalanche 扫描 `AvalancheHXMsgWarpRequested` 日志；
- Fabric 使用 contract listener 接收 `XCALL` 与生命周期事件，并从 QSCC 读取账本高度；
- EVM 类 scanner 保存最近区块的 `height + hash` checkpoint，重启后从持久 cursor 继续；
- 检测到分叉时，分叉点之后的事件标记为 orphaned，对应未完成任务会被取消；
- Fabric cursor 保存 channel、block number 和 transaction ID。

事件写入、cursor 推进和任务创建由同一个 `AutomationStore.ingest()` 调用完成。单进程内不会出现 cursor 已推进但任务未写入的窗口。

## 4. Source Material

源链事件只保存可验证哈希时，业务 payload 正文和补偿参数由任意数据可用性/relayer 节点通过内容键发布：

```text
PUT /v1/materials/{requestID-or-callDataHash}
```

材料可先于或晚于链上事件到达。只有材料与已发现事件同时存在时才会创建 Relayer/Watcher 任务。这样旧 benchmark 发出的事件不会被生产监听器重复投递，也不会堆积永久等待材料的任务。

材料不是信任根。Proof builder 会重算 `callDataHash/businessPayloadHash`，TEE 会再把它们与 receipt log、Fabric View/rwset 或 Avalanche Warp message 中的源链事实比较。内部自洽但不符合源链事实的材料仍会被拒绝。

## 5. Relayer 状态机

```text
DISCOVERED
-> WAITING_MATERIAL
-> WAITING_FINALITY
-> BUILDING_PROOF
-> TEE_ATTESTING
-> TARGET_SUBMITTING
-> COMPLETED | WAITING_RESPONSE
```

三个源链 adapter 的实际证明输入如下：

| 源链 | Finality/证明 |
|---|---|
| 本地 Ethereum | 模拟 header committee + receipt MPT proof |
| Sepolia | Sync Committee finality + execution header 链 + receipt MPT proof |
| Fabric | 确定性提交 + h-FSV View、Peer endorsement、block/tx/rwset |
| Avalanche | Warp message + P-Chain validator set + 5 validator 权重签名 |

TEE 返回的 quorum certificate 由目标链现有 Gateway/chaincode 验证。目标提交使用 compact delivery，但它仍被 canonical `hmsgDigest` 和 delivery digest 绑定。

## 6. Watcher 状态机

```text
WATCHING_PENDING
-> CHALLENGE_SUBMITTING
-> WATCHING_CHALLENGE
-> COMPENSATION_SUBMITTING
-> COMPENSATED
```

只有 `feedback.required=true` 且 `atomicity.challengeWindow>0` 的源事件会自动登记 Watcher。Watcher 查询源链的真实 lifecycle 状态：

1. feedback deadline 前持续等待；
2. 超时后由已授权 watcher 账户调用 `StartChallenge`；
3. challenge window 内有效 RESPONSE 仍可完成请求；
4. 挑战截止后仍无 RESPONSE，调用 `CompensateAfterChallenge`；
5. `TOKEN_ESCROW` 由合约/链码执行真实退款，不以状态字段变化代替补偿。

RESPONSE 采用开放中继模型：任何 relayer 都可以构造目标链事实证明并提交 `/v1/jobs/response`。不要求固定 responder，也不要求用户在线；伪造 RESPONSE 会被 TEE 目标链事实验证和源链绑定检查拒绝。

## 7. 持久任务与 API

状态文件默认为 `runtime/automation-tasks.json`，包含：

- tasks、确定性 idempotency key、lease、retry、dead-letter；
- scanner cursors 和 canonical/orphaned events；
- source materials、proof/certificate 中间材料；
- Relayer 与 Watcher workflow 状态和分阶段耗时。

当前 API：

```text
PUT  /v1/materials/:key
POST /v1/jobs/response
POST /v1/jobs/watch
POST /v1/jobs/checkpoint
POST /v1/workflows/:id/cancel
GET  /v1/events
GET  /v1/cursors
GET  /v1/tasks
GET  /v1/workflows/:id
GET  /health
```

旧 `/v1/jobs/relay` 已删除。Relay 只能由链上事件和已发布材料共同触发，不能由调用方绕过扫描器直接塞入 h-xmsg。

设置 `AUTOMATION_API_KEY` 后，`/v1/*` 需要 Bearer token。HTTP body 默认限制为 20 MiB，可由 `AUTOMATION_HTTP_JSON_LIMIT` 调整。

## 8. Lifecycle Checkpoint

`checkpoint` worker 保留显式候选集合入口。它只接受 `Completed/Compensated/Failed/Cancelled`，并要求 token escrow 已 settled/refunded。源链、TEE 和合约/链码分别重算相同 terminal root，TEE quorum 认证后才清理活动协议状态。

Checkpoint 不删除目标业务结果、事件日志、Fabric 区块历史或累计 checkpoint root。自动收集终态候选和按阈值定时成批仍属于后续长期运行优化。

## 9. 实验入口

事件驱动闭环：

```bash
npm run automation:test:evm-avalanche
npm run automation:test:evm-fabric
npm run automation:test:fabric-evm
npm run automation:test:watcher-escrow
```

旧的 `run-hxmsg-forward-tests.js` 与 `run-evm-fabric-tests.js` 直接路径已经删除。论文 benchmark 也必须经 scanner、持久化任务、Relayer、TEE 和 Watcher 策略登记；批次参数只作为 automation 调度元数据，不得成为第二套 Relayer。

## 10. 部署边界

当前 JSON store 只支持一个 Automation 进程。`AUTOMATION_ROLE=relayer|watcher` 预留了角色拆分，但在多实例部署前必须把 store 换为具有事务、唯一约束、租约 fencing 和 `SKIP LOCKED` 的数据库，并协调 EVM nonce。

迁移到 TDX 时，Automation、Fabric wallet、扫描数据库仍运行在 enclave 外；TEE 内只保留证明验证、有限可信链状态、Raft、密钥和签名。生产部署还需要 mTLS、API RBAC、速率限制、审计日志和密钥托管。
