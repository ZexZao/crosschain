# Project Improvement Review Against Design Goals

Date: 2026-05-29

本文档从项目设计初衷出发，对当前实现进行一次完整梳理，并列出后续需要改进的部分。这里的设计初衷是：

1. 系统面向异构链消息互通，不是简单事件转发。
2. 源链事实必须被可信验证，不能只验证区块合法而不验证具体交易或事件存在性。
3. Fabric -> EVM 应参考 Fabric Cacti Weaver 的 Fabric View 思路。
4. EVM -> Fabric 应参考 Mercury 的轻客户端思路，由 TEE 使用本地维护的区块头窗口验证 receipt MPT proof。
5. TEE 集群应采用多 TEE quorum，当前实验为 5 个模拟 TEE、3/5 quorum。
6. 普通消息和需要 RESPONSE 的原子消息应共享同一条构造、验证和投递路径，差异由 h-xmsg 策略字段驱动。
7. 新链接入应尽量通过 builder + adapter 扩展，不破坏已经存在的链适配逻辑。

## 1. 当前已经符合设计初衷的部分

### 1.1 h-xmsg 已成为跨链消息核心

当前 h-xmsg 由 `shared/hxmsg/` 定义哈希和规范化逻辑，由 `hxmsg-builder/` 统一构造。消息中包含：

- `header`
- `source`
- `target`
- `sourceRef`
- `targetAction`
- `verification`
- `payloadBinding`
- `feedback`
- `atomicity`

这些字段共同进入 `hmsgDigest`。因此 relayer 不能在链下单独篡改目标执行、反馈策略或原子性策略。

### 1.2 Fabric -> EVM 主路径实现了 h-FSV / Fabric View 风格验证

当前 `tee-verifier/adapters/fabric-hfsv-adapter.js` 不接受 relayer 提供的 Fabric block bytes 作为可信来源，而是：

1. 根据 h-xmsg `sourceRef` 定位 `QueryCrosschainEvent(requestID)`。
2. 主动向 Fabric peers 发起 endorsed query。
3. 验证 peer endorsement 签名。
4. 验证 endorser MSP 身份和证书链。
5. 检查多个 peer 返回的 view payload 一致。
6. 检查 h-FSV policy hash 与 h-xmsg 绑定一致。
7. 再通过 QSCC 获取包含该 txId 的 Fabric block。
8. 解码 block，确认交易存在、交易状态 VALID、写集包含 `crosschainEvents:{requestID}`。

这不是“TEE 随便查区块再自己找交易”的简化方案。当前实现同时使用 Fabric View 风格的 endorsed view 和 block/rwset 验证具体交易存在性。

### 1.3 EVM -> Fabric 主路径实现了 receipt MPT proof + header window

当前 `tee-verifier/adapters/evm-melv-adapter.js` 要求 relayer 提供 `evmReceiptProof`，TEE 使用本地 header window 中的 `receiptsRoot` 验证 receipt proof。

重要边界：

- TEE 不直接相信 relayer 提供的 RPC 返回值。
- relayer 可以提供 proof 和 committee header update，但 proof 必须能被本地 header 的 `receiptsRoot` 验证。
- header 必须经过模拟 Header Committee 认证后才能进入 TEE header window。
- `MELV_ALLOW_RPC_HEADER_SYNC` 默认未开启；只有显式设为 `true` 时才会走 RPC 同步辅助路径。

这符合“TEE 类似轻客户端，维护有限区块头并本地验证交易存在性”的实验目标。

### 1.4 多 TEE quorum 已升级为 5 节点、3/5 quorum

当前 Docker 默认启动 5 个 TEE：

```text
tee-verifier-1
tee-verifier-2
tee-verifier-3
tee-verifier-4
tee-verifier-5
```

默认阈值为 3/5，对应 `2f+1=5`、`f+1=3`。

`tee-verifier/server.js` 已实现：

- RequestVote
- AppendEntries
- leader election
- heartbeat
- commitIndex
- lastApplied
- follower catch-up
- current-term entry commit 限制
- 内部 Raft RPC HMAC 认证
- committed 后才允许签名

因此单个 TEE 不能独自生成项目接受的 quorum certification。

### 1.5 普通消息和 RESPONSE 消息共用路径

普通消息和需要 RESPONSE 的消息均通过 h-xmsg 进入 TEE `/attest`，目标链执行入口也保持一致。差异主要由：

- `feedback.required`
- `feedback.expectedMsgType`
- `atomicity.required`
- `atomicity.mode`
- `atomicity.challengeWindow`

决定。

这符合“消息交互系统不应为是否需要 response 分裂成两套路径”的要求。

### 1.6 挑战响应闭环已经实现基础状态机

当前 EVM 源链和 Fabric 源链均具备：

```text
Pending -> Completed
Pending -> Challenged -> Completed
Pending -> Challenged -> Compensated
```

TEE 对 RESPONSE 的签名覆盖 `responseDigest`，源链会检查 RESPONSE 与原始请求、目标执行哈希、TEE quorum 绑定。

## 2. 高优先级改进项

### 2.1 目标链和 Fabric chaincode 不应从 calldata / cert envelope 接受 threshold

当前 EVM 侧：

```solidity
executeHXMsgMinimalCluster(..., uint256 threshold)
completeWithResponse(..., uint256 threshold)
```

Fabric 侧：

```javascript
const threshold = Number(certEnvelope.threshold || 1)
```

问题是：threshold 属于系统安全参数，不应由 relayer 提交。虽然当前测试脚本提交的是 3/5，但合约和链码本身仍应从可信配置读取固定阈值。

建议：

1. 扩展 `TEERegistry`，增加 `clusterID -> members -> threshold`。
2. EVM gateway 和 EVM source contract 从 registry 读取 threshold。
3. Fabric chaincode 增加 `InitTEECluster` / `UpdateTEECluster` / `QueryTEECluster`。
4. cert envelope 只能携带 `clusterID / reached / total` 等元信息，不能决定验签阈值。
5. 目标链拒绝低于链上可信配置的 certification。

这是当前最应优先处理的安全改进。

### 2.2 模拟 TEE 需要替换为真实 TEE remote attestation

当前 TEE 是 Node.js 服务。它能模拟验证逻辑和 quorum 流程，但还不能证明代码确实运行在 TEE 中。

建议：

1. 为 TEE 服务增加 attestation quote 生成和验证接口。
2. 将 TEE public key 与 remote attestation measurement 绑定。
3. 将可信 TEE 注册从“登记地址”升级为“登记 attested identity”。
4. EVM 和 Fabric 侧只接受已 attested 的 TEE key。

### 2.3 Header Committee 当前仍是模拟实现

EVM header window 的安全性依赖 Header Committee。当前 `shared/evm/header-committee.js` 使用本地模拟私钥和固定 committee。

建议：

1. 设计正式区块头管理委员会。
2. 引入 committee epoch / rotation / membership proof。
3. TEE 只接受当前 epoch committee 认证的 header update。
4. header update 中绑定 chainID、finalized checkpoint、committeeID、epoch 和 threshold。
5. 后续可接入 beacon light client 或外部 finalized checkpoint 来源。

### 2.4 Raft 仍需生产级增强

当前 Raft 主路径已经可运行，但作为论文系统或真实实验仍需增强：

1. 持久化 WAL。
2. snapshot。
3. log compaction。
4. 网络分区恢复测试。
5. 动态成员变更。
6. mTLS + remote attestation 替换共享 HMAC。
7. 长时间运行压测。

## 3. 中优先级改进项

### 3.1 常驻 relayer / watcher / responder 尚未实现

当前测试脚本负责触发：

- 源链事件读取
- h-xmsg 构造
- TEE `/attest`
- 目标链提交
- RESPONSE 构造
- challenge / compensation

这足以做实验闭环，但不是完整工程系统。

建议在 `relayer/` 中实现常驻进程：

1. source watcher
2. proof builder
3. TEE client
4. target submitter
5. response watcher
6. challenge monitor
7. retry and idempotency store

### 3.2 补偿动作目前只是状态收束，不是通用业务补偿执行框架

当前 `CompensateAfterChallenge` 会校验 `failureActionHash`，并将请求状态置为 `Compensated`。这能证明状态机闭环，但对于换币、资产锁定、权限锁等场景，还需要具体业务合约或链码执行补偿动作。

建议：

1. 为 `TOKEN_ESCROW` 设计中间账户或 escrow 合约。
2. 为 `STATE_LOCK` 设计解锁链码或补偿 handler。
3. 为 `CUSTOM` 设计可注册的 compensation executor。
4. compensation 执行结果也应进入 source-chain fact，并可被 TEE 验证。

### 3.3 Fabric 网络仍是单组织实验配置

当前 Fabric 网络是 `Org1MSP` 单组织、4 peer。h-FSV adapter 支持 MSP 和 endorsement policy 检查，但实验网络还没有验证多组织场景。

建议：

1. 增加至少 2 组织 Fabric 网络。
2. 将 h-FSV policy 从默认 `Org1MSP` 扩展到多组织 AND / THRESHOLD。
3. 测试部分 peer 返回不一致 view 的拒绝路径。
4. 测试 endorsement policy 不满足时的拒绝路径。

### 3.4 新链接入框架还可以继续标准化

当前 builder 已经解耦为 source builder 和 target builder，TEE adapter 也按 verification method 分发。但还可以进一步强化“接入新链只修改 TEE 和新链 builder”的目标。

建议：

1. 定义 chain adapter manifest。
2. 每条链声明 source fact proof schema、target action schema、finality model。
3. TEE adapter registry 从硬编码分发升级为可配置注册。
4. h-xmsg `verification.policyRef` 标准化为跨链通用 policy URI / policy hash。
5. routing / subnet 信息与 h-xmsg 解耦，避免把具体部署拓扑写死到消息结构。

## 4. 低优先级但论文实验建议补齐的部分

### 4.1 批处理签名尚未实现

Mercury 提到 TEE 可以对一批交易签名以降低成本。当前项目仍是一条消息一个 quorum certification。

建议：

1. TEE 对 batch root 达成 Raft commit。
2. 单条消息携带 batch inclusion proof。
3. EVM 目标链验证 batch root quorum + message inclusion proof。
4. 对比单条提交和批处理提交的 gas / latency。

### 4.2 缺少系统性攻击测试

建议增加自动化 negative tests：

1. 伪造 Fabric view。
2. Fabric peer 返回不一致 view。
3. EVM receipt proof 与 header receiptsRoot 不匹配。
4. relayer 提交低 threshold。
5. 重复 TEE 签名。
6. RESPONSE 绑定错误 requestID。
7. 过期消息提交。
8. challenge 窗口内外状态转换边界。

### 4.3 缺少更完整的性能评估

建议记录并对比：

1. TEE 数量从 3 / 5 / 7 增加时的 latency。
2. quorum threshold 变化对 latency 的影响。
3. Fabric -> EVM 与 EVM -> Fabric 的 proof 构造时间。
4. 目标链 gas 开销。
5. batch signing 优化前后差异。
6. 本地 Docker 与真实 TEE 服务器的差异。

## 5. 当前不建议删除但可标记为后续整理的目录

以下目录当前不是主路径，但可以作为后续工程化入口保留：

| 目录 | 当前状态 | 建议 |
|---|---|---|
| `relayer/` | 当前为空 | 后续放常驻 watcher/router/responder |
| `proof-builder/` | 当前为空 | 后续放独立 proof 构造模块 |
| `source-chain/` | 当前为空 | 后续如保留示例源链再使用，否则可删除 |

## 6. 建议改进顺序

1. 固定 TEE cluster threshold，不允许 relayer 传入安全阈值。
2. 设计并实现 TEE attestation identity 注册。
3. 设计正式 Header Committee epoch / rotation。
4. 为 relayer / watcher / responder 建立常驻进程。
5. 增加多组织 Fabric 实验。
6. 实现 compensation executor / escrow 合约。
7. 增加 batch signing。
8. 扩展负面安全测试和性能评估。

## 7. 总结

当前项目已经达到实验原型层面的核心目标：双向跨链消息都不再依赖简单转发，TEE 会验证具体源链事实，目标链只接受 TEE quorum 证明过的 h-xmsg 绑定摘要。

但如果要进一步支撑论文或更接近真实系统，最关键的改进不是再增加更多业务样例，而是把当前仍由实验环境承担的信任边界转移到系统内：

- threshold 必须由目标链可信配置决定。
- TEE 身份必须由 remote attestation 证明。
- EVM header committee 必须从模拟升级为正式委员会。
- relayer / responder 必须从测试脚本升级为常驻、可恢复的工程组件。
