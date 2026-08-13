# h-xmsg 项目 AI 会话移交手册

> 最后核对日期：2026-08-14
> 当前主仓库：`/home/zex/projects/crosschain_experiment/crosschain_experiment`
> 当前分支：`paper/h-xmsg-tee`
> 当前远端：`git@github.com:ZexZao/crosschain.git`
> 基准提交：`74278d3 feat: unify automated cross-chain lifecycle`，但当前工作树包含尚未提交的重要后续改造和删除，不能用该提交覆盖工作树。

本文是新 AI 会话进入项目时的首要上下文。它以 2026-08-14 的实际工作树、`package.json`、Compose 文件和当前代码为准。若本文、历史文档、旧 README 段落或 Git 索引中的旧文件发生冲突，应按以下优先级判断：

```text
当前实际文件和测试行为
  > 本移交手册
  > docs/current-code-path-audit-2026-08-11.md
  > README.md 的当前架构部分
  > 其他设计/历史文档
```

## 0. 新 AI 必须先遵守的规则

1. 先执行 `pwd`、`git status --short` 和 `git branch --show-current`，确认位于本手册标出的主仓库。
2. 当前工作树很脏，但这些修改来自已经完成的项目改造。不要执行 `git reset --hard`、`git checkout -- .`、`git restore .`，也不要恢复当前显示为 `D` 的旧文件。
3. 业务端到端实验的唯一主路径是 `automation/`。不要新写“脚本直接构造证明 -> 直接调用 TEE -> 直接提交目标链”的旁路。
4. 普通消息和需要 RESPONSE/atomicity 的消息必须共用同一 scanner、builder、proof、TEE 和 target submit 路径，只允许由策略字段触发后续 RESPONSE/Watcher 分支。
5. TEE quorum 当前是 Raft 提交后的 `ECDSA_QUORUM_V1` 签名集合。不要重新引入已经放弃的 TEE BLS 门限签名。
6. Avalanche Warp 验证内部使用的 BLS12-381 是 Avalanche 原生 validator 权重证明，不是 TEE quorum 的签名算法。两者不能混写。
7. 不要仅依据 `artifacts/` 判断源码是否存在。该目录有历史编译残留，例如已删除的 `EIP2537BLSVerifier.sol` artifact；当前源码中没有该合约。
8. 不要创建新的 Automation、TEE、Fabric 或 Avalanche 容器组。优先使用 `npm run pair:up -- <pair>` 复用现有服务定义。
9. 不要展示、记录、提交或复制 `.env`、Fabric wallet、MSP keystore 中的私钥。本文只记录变量名、公钥地址和安全使用方式。
10. 修改 Solidity 后重新编译并部署对应 EVM-compatible 链；修改 Fabric chaincode 后递增 sequence 重新部署；修改 TEE/Automation 后重建对应容器。

## 1. 工作区边界，避免进入错误项目

| 路径 | 身份 | 是否使用 |
|---|---|---|
| `/home/zex/projects/crosschain_experiment/crosschain_experiment` | 当前主项目，分支 `paper/h-xmsg-tee` | 是，所有 h-xmsg 开发和实验都在这里 |
| `/home/zex/projects/crosschain_experiment/crosschain` | 冻结旧基线，分支 `master`，提交 `2ca1e25` | 否，不要编辑、运行或从中复制旧路径 |
| `/home/zex/projects/crosschain_experiment/mercury_reproduction` | Mercury 消融实验的独立 Git 仓库，远端 `ZexZao/mercury_reproduction` | 仅做 Mercury baseline 时使用 |
| `./mercury_reproduction` | 主仓库内的旧快照 | 不作为可运行权威副本，见第 18 节 |
| `/home/zex/codex-work/修改文件` | 原始设计文件和 Mercury 论文 | 只读设计依据 |

外部设计依据：

| 文件 | 作用 |
|---|---|
| `/home/zex/codex-work/修改文件/h-xmsg.md` | canonical h-xmsg 的原始设计 |
| `/home/zex/codex-work/修改文件/h-FSV方案.md` | Fabric View-like 存在性证明方案 |
| `/home/zex/codex-work/修改文件/MELV-EF方案.md` | EVM receipt/light-client 存在性证明方案 |
| `/home/zex/codex-work/修改文件/tee_hxmsg_crosschain_overall_scheme.md` | 整体系统结构 |
| `/home/zex/codex-work/修改文件/Mercury_Practical_Cross-Chain_Exchange_via_Trusted_Hardware.pdf` | Mercury 原论文 |

## 2. 项目目标与当前结论

项目目标不是普通消息转发器，而是一个基于 TEE 子网的异构链可信互操作原型。当前接入：

| 链 | 本地形态 | 源链验证方式 |
|---|---|---|
| Ethereum | Hardhat，chain ID `31337` | 本地模拟 header committee + receipt MPT proof |
| Sepolia | 真实 Ethereum 测试网，chain ID `11155111` | 真实 Beacon Sync Committee finality + execution header ancestry + receipt MPT proof |
| Hyperledger Fabric | Fabric 2.5，1 个组织、4 个 peer、1 个 orderer | h-FSV endorsed view + MSP/endorsement 验证 + block/VALID/rwset 检查 |
| Avalanche | 本地 5 validator AvalancheGo，C-Chain chain ID `1337` | Warp message + genesis-pinned P-Chain validator set + validator 权重 BLS 签名 |

当前三类源链各有独立的 5 节点 TEE 证明子网，阈值为 3/5。每个节点独立验证源链事实，Raft majority 提交后才产生 ECDSA quorum certificate。目标链验证 certificate、目标绑定、过期时间和 replay bitmap，再执行真实业务动作。

已完成的关键能力：

| 能力 | 当前状态 |
|---|---|
| canonical h-xmsg 与链下 envelope | 已实现 |
| 三链两两六个有向方向 | 已实现本地实验路径 |
| Ethereum/Sepolia receipt MPT 与可信 header | 已实现；本地 committee 为模拟，Sepolia Sync Committee 为真实协议验证 |
| Fabric h-FSV | 已实现 peer endorsed view、MSP、提交区块和 rwset 检查 |
| Avalanche Warp/P-Chain | 已实现真实本地 Warp、5 validator 权重证明和 P-Chain genesis 锚 |
| TEE 子网隔离 | 已实现独立 cluster ID、签名键、Raft secret、源链类型/ID 域绑定 |
| 5 节点 Raft | 已实现选举、heartbeat、AppendEntries、majority commit、日志追赶、current-term barrier 和内部 RPC 认证 |
| TEE batch signing | 已实现 batch root 一次 Raft/TEE 认证 |
| compact target delivery | 已实现 19 字段 minimal delivery + 7 字段 CompactCall |
| 真实业务执行 | 已实现 ERC20 reserve transfer/mint 与 Fabric 资产账本，以及多类领域状态 |
| RESPONSE 与原子性 | 已实现开放 RESPONSE relay、challenge、Watcher 和 token escrow 真实退款/结算 |
| Lifecycle Checkpoint | 核心链上/链码与 TEE 认证已实现；自动聚合调度未实现 |
| 常驻 Automation | 已实现 scanner、cursor、finality、proof、TEE、submit、response、watcher 的持久状态机 |
| 自洽伪造攻击回归 | 已实现 EVM -> Fabric 和 Fabric -> EVM |

不能声称已经完成的能力：

| 边界 | 真实状态 |
|---|---|
| 硬件 TEE | 当前是 Node.js `SIMULATED_TDX_QUOTE_V1`，没有真实 TDX quote 验证、sealed key 或 enclave 内执行测量 |
| 生产级 Raft | 没有 WAL、snapshot、log compaction、动态成员变更和完整网络分区验证 |
| Automation 高可用 | JSON store 只允许单进程写，尚未迁移事务数据库 |
| Fabric 去中心化实验 | 当前只有 `Org1MSP`，4 peers 属于同一组织；不等价于多组织对手模型 |
| Avalanche 动态 validator 轮换 | 本地实验使用 genesis 固定集合，集合变化时 fail closed |
| 自动 Checkpoint | 显式 `/v1/jobs/checkpoint` 可用，候选自动收集/定时批处理未实现 |
| 非资产通用补偿 | 真实 `TOKEN_ESCROW` 已实现；授权撤销、Oracle 回滚等仍需业务特定可逆资源和 handler |
| 服务安全 | 尚未加 mTLS、RBAC、完整 schema 校验、速率限制和生产密钥托管 |

## 3. 当前唯一端到端主路径

```text
用户/业务调用源链合约或链码
  -> 源链写入事实并发出规范事件
  -> 测试驱动把完整业务 material 发布到 Automation 内容键
  -> Automation scanner 发现事件并持久化 cursor/event
  -> Relayer 等待源链 finality
  -> 源链 adapter 构造事实证明和 canonical h-xmsg
  -> 对应源链 TEE 子网的每个节点独立验证
  -> Raft majority commit
  -> 3/5 ECDSA quorum certificate
  -> Automation target-submitter 提交 minimal h-xmsg + CompactCall
  -> 目标 Gateway/chaincode 验证并执行真实业务动作
  -> 普通消息结束，或进入 WAITING_RESPONSE
  -> 任意 relayer 可提交目标执行事实作为 ResponseProof
  -> 目标链类型对应的 TEE 子网验证 RESPONSE 事实
  -> 源链完成并结算 escrow
  -> 若 RESPONSE 丢失，Watcher 在 deadline 后 challenge，窗口结束后真实补偿
```

禁止恢复的旁路模式：

```text
测试脚本 -> 自己构造完整证明 -> 直接 POST /attest -> 直接调用 Gateway
```

只有安全专项测试允许直接访问被测边界：

| 专项脚本 | 为什么允许直连 |
|---|---|
| `run-hxmsg-forgery-attack-tests.js` | 测试 TEE 是否拒绝自洽伪造证明 |
| `run-raft-cluster-tests.js` | 测试 Raft 内部选举和故障恢复 |
| `run-challenge-response-tests.js` | 合约状态机级回归，不声称是 Automation E2E |
| `run-lifecycle-checkpoint-tests.js` | Checkpoint/Watcher 授权合约级回归 |
| `run-sepolia-sync-committee-check.js` | 单独验证 light-client 数据，不发送跨链消息 |

## 4. h-xmsg、Delivery 与 CompactCall

### 4.1 canonical h-xmsg

canonical h-xmsg 保持在链下，由 `computeHXMsgDigest()` 完整绑定：

| 区块 | 字段与作用 |
|---|---|
| `header` | `version/requestID/msgType/nonce/nonceScope/sourceTimestamp/deliveryExpireAt` |
| `source` | `chainType/chainID/domainID`，确定源链安全域 |
| `target` | `chainType/chainID/domainID`，确定目标链 |
| `sourceRef` | `refType/refHash`，绑定 EVM event/receipt、Fabric View 或 Avalanche Warp |
| `targetAction` | `actionType/targetObject/functionSelector/callDataHash/receiver` |
| `verification` | 验证方法、finality、policyRef 和 verifier profile |
| `payloadBinding` | `sourcePayloadHash/businessPayloadHash` |
| `feedback` | 是否需要 RESPONSE、类型、timeout、callback hash |
| `atomicity` | commit-or-compensate、commitment 类型、成功/失败动作和 challenge window |

完整证明和正文放在 `HxmsgEnvelope`：

| Envelope 字段 | 作用 |
|---|---|
| `hxmsg` | canonical h-xmsg |
| `sourceEvidence` | encoded source ref 和源链证明 |
| `executionData` | CompactCall、完整 business payload、目标地址 |
| `runtime` | 非共识运行上下文 |
| `auditRecord` | tx ID、height、proof metadata |

### 4.2 当前链上 minimal delivery

当前目标提交的权威转换函数是 `shared/hxmsg/hash.js::toMinimalHXMsg()`，输出 19 项：

```text
requestID, hmsgDigest,
targetChainType, targetChainID,
actionType, targetObject, functionSelector, callDataHash, receiver,
targetExecutionHash,
feedbackRequired, expectedMsgType, feedbackTimeout, callbackRefHash,
expireAt, replayScope, sourceNonce,
sourceChainType, sourceChainID
```

最后两个源链域字段用于阻止把某个 TEE 子网的 certificate 重用于另一源链。`shared/hxmsg/delivery.js::toMinimalHXMsgV2()` 是 17 字段的较早辅助表示，当前没有被目标提交器调用；新代码不得把它当作 Gateway ABI。`shared/hxmsg/hash.js::toOnChainHXMsg()` 也没有当前调用者，不是主线入口。

### 4.3 CompactCall

`shared/xmsg.js` 将动态业务正文变成固定 7 字段调用：

```text
opCode, recordIdHash, actorHash, actorAddress, amount, metadataHash, requireAck
```

完整业务 payload 仍在链下 material/envelope 中，并通过 `businessPayloadHash`、`callDataHash` 和 `hmsgDigest` 绑定。目标 Fabric 会重算 CompactCall 与完整业务 payload 的一致性；EVM Gateway 校验 CompactCall hash 与 h-xmsg。

当前 opCode：

| op | code | EVM/Fabric 动作 |
|---|---:|---|
| `asset_lock` | 1 | 资产结算/入账 |
| `mint_confirm` | 2 | 资产铸造确认 |
| `receivable_attest` | 3 | 应收账款登记 |
| `logistics_sync` | 4 | 物流状态同步 |
| `medical_consent` | 5 | 授权记录 |
| `oracle_update` | 6 | Oracle 最新轮次更新 |
| `approval_commit` | 7 | 审批决定登记 |
| `subsidy_confirm` | 8 | 补贴/资产结算 |
| `token_transfer` | 9 | 从目标链预置 reserve 真实转账 |

### 4.4 Batch

Automation 使用 `batchGroupID + batchSize + batchIndex` 聚合同源、同目标消息。TEE 对每条消息独立验证，再对 `batchRoot` 做一次 Raft commit 和 quorum certificate。

EVM-compatible 目标链会重算整个 batch root，不携带逐消息 Merkle proof。Fabric 目标链当前仍为每条 delivery 携带对应 Merkle proof，并在链码中验证。两者都要求每条业务动作真实执行，batch 不是“一个状态代表多笔交易完成”。

注意：三个 `run-automation-*-batch-experiments.js` 中的 `tee-batch-signing` 和 `batch-transfer` 都使用相同的 optimized token transfer、TEE batch certificate 和单目标 batch transaction。当前差异主要是实验标签和输入 ID/metadata，不是两个独立协议执行路径；论文中不能把它们描述成两种不同机制的消融对照。

## 5. 三类源链事实验证

### 5.1 Ethereum/Sepolia：轻客户端区块头 + receipt MPT proof

1. Scanner 从受信源合约地址发现 `CrossChainCallRequested`。
2. Finality worker 重新获取 receipt，检查 status、blockHash 和分叉。
3. 本地 Ethereum 使用模拟 header committee 对区块头签名；Sepolia 等待 Beacon finalized execution height 覆盖源交易。
4. Proof builder 构造 receipt trie 的 MPT proof。
5. Sepolia 还构造 Sync Committee update、finality branch、execution payload branch 和目标区块到 finalized header 的 parentHash 链。
6. TEE 将认证 header 放入有限 header window，用其 `receiptsRoot` 验证 MPT proof。
7. TEE 从已证明 receipt 的 log 中解析真实事件，逐项比对 requestID、nonce、目标、callDataHash、businessPayloadHash、feedback 和 atomicityHash。
8. 链下 h-xmsg 即使被攻击者整体改成内部自洽，只要不等于源链 log 就会被拒绝。

Sepolia trusted root 的选择优先级：TEE 子网多数节点已有 root -> `.env` 的 `SEPOLIA_TRUSTED_BLOCK_ROOT` -> `runtime/sepolia-sync-committee-state.json`。成功验证后默认推进 runtime state 和 `.env`，除非 `SEPOLIA_UPDATE_ENV_TRUSTED_ROOT=false`。

### 5.2 Fabric：h-FSV endorsed View

1. Fabric chaincode 的 `EmitXCall` 或 `LockAssetXCall` 写入 `crosschainEvents:{requestID}` 并发出事件。
2. Source builder 将 `sourceRef` 固定到 `QueryCrosschainEvent(requestID)` 和 expected state key。
3. Fabric TEE 通过 Fabric Gateway 向 channel endorsers 发送 query proposal，不接受 relayer 自带的任意 view。
4. TEE 检查所有成功 peer 返回相同 payload，验证每个 proposal endorsement、X.509 证书、MSP root 和 h-FSV policy。
5. TEE 比对 view 中的 requestID、nonce、目标、callDataHash、businessPayloadHash、feedback/atomicity 与 h-xmsg。
6. TEE 再通过 QSCC 取 `GetBlockByTxID`，检查 tx ID、区块号、VALID 状态和预期 rwset 写入。
7. RESPONSE 从 Fabric 返回时也使用 `GetInboundStatus` 的 Fabric execution view，走同类 peer endorsement 验证。

这里不是“TEE 随便查询一个 RPC 然后相信返回值”，也不是单纯在区块中搜索交易。可信性来自 Fabric MSP/peer endorsements、确定性账本提交和 rwset 绑定。当前所有 peers 同属 `Org1MSP`，论文必须声明该信任模型边界。

### 5.3 Avalanche：Warp + P-Chain validator 权重证明

1. `AvalancheWarpSourceContract` 调用 Warp Messenger precompile 并发出 `AvalancheHXMsgWarpRequested`。
2. Proof builder 从 AvalancheGo 获取 unsigned Warp message 和 5 个 validator 的 message signature。
3. `generate-avalanche-pchain-trust-anchor.js` 将网络 genesis、5 节点一致查询结果、C-Chain blockchain ID、validator BLS 公钥和权重固定到 runtime anchor。
4. 每个 Avalanche TEE 通过自己的 P-Chain RPC 查询证明高度的真实 validator set，不信任 relayer 提供的集合、权重或阈值。
5. TEE 使用锚定的公钥和权重验证 Warp BLS signatures，要求至少 67% 权重。
6. TEE 解析 Warp payload，逐项绑定 h-xmsg、CompactCall、feedback、atomicity 和目标执行。
7. 通过后才进入 Avalanche TEE 子网的 Raft/ECDSA quorum。

## 6. TEE 子网、Raft 与注册

每个源链类型对应一个独立子网：

| 子网 | profile | cluster 文本 | 节点 | 阈值 |
|---|---|---|---:|---:|
| Ethereum proof subnet | `ethereum` | `HXMSG_ETHEREUM_PROOF_SUBNET_V1` | 5 | 3 |
| Fabric proof subnet | `fabric` | `HXMSG_FABRIC_PROOF_SUBNET_V1` | 5 | 3 |
| Avalanche proof subnet | `avalanche` | `HXMSG_AVALANCHE_PROOF_SUBNET_V1` | 5 | 3 |

证书签名摘要绑定：

```text
certificateDomain,
clusterID,
epoch,
sourceChainType,
sourceChainID,
subjectDigest
```

`subjectDigest` 对单消息是 delivery digest，对 batch 是 batch signing digest，对 RESPONSE 是 response digest，对 checkpoint 是 checkpoint digest。Certificate 还携带 signer bitmap、selected signer hash、committed Raft term/index，目标链逐签名恢复 ECDSA 地址。

Raft 现有能力：

| 能力 | 实现位置 |
|---|---|
| RequestVote 与日志新旧判断 | `tee-verifier/server.js` |
| AppendEntries 与 conflict index | 同上 |
| leader forwarding | `/attest*` 入口中的 `ensureRaftLeaderOrForward` |
| current-term no-op barrier | `ensureCurrentTermCommitBarrier` |
| follower 独立 proof 验证 | `/internal/raft/append-entries` |
| majority commit 后签名 | `/internal/raft/sign-committed` |
| leader verification lease | 防止长证明验证期间频繁换主 |
| HMAC 内部 RPC 认证 | 独立 `TEE_*_RAFT_SHARED_SECRET` |
| 持久状态 | `runtime/tee-consensus-<node>.json` |

TEE HTTP API：

| API | 作用 |
|---|---|
| `GET /identity`、`GET /pubkey` | 模拟 attestation 身份和签名公钥 |
| `GET /chain-state` | 本地可信 header/P-Chain 状态 |
| `GET /raft/status` | role、term、leader、commit/log index |
| `POST /attest` | 单 h-xmsg 证明验证和证书 |
| `POST /attest-batch` | batch 验证和证书 |
| `POST /attest-response` | 目标执行事实验证和 RESPONSE 证书 |
| `POST /attest-checkpoint` | 终态集合认证 |
| `/internal/raft/*` | 子网内部接口，不是业务 API |

TEE runtime 文件：

| 模式 | 内容 | 是否可随意删除 |
|---|---|---|
| `tee-state-<node>.json` | TEE ECDSA 私钥/地址 | 否；本地 Compose 固定 key 可重建，但删除会影响已注册身份 |
| `tee-chain-state-<node>.json` | EVM header window、Sync Committee/P-Chain 状态 | 否；删除会丢可信进度 |
| `tee-consensus-<node>.json` | Raft term、vote、log、commit index | 仅在容器停止且明确做全新本地实验时清理 |

注册流程：

1. TEE `/identity` 返回 cluster、subnet、source type、signer index、public key hash、measurement、quote hash、epoch 和 self-signature。
2. `registerEVMTEEs()` 或 `registerFabricTEEs()` 将身份注册到目标链。
3. EVM `TEERegistry` 只允许 owner 注册；Fabric `RegisterTrustedTEE` 按 cluster 保存身份。
4. 本地 target submission 会幂等补注册；Sepolia 可先运行 `npm run sepolia:register:tee-subnets`，避免业务交易阶段重复注册成本。
5. 当前 quote 验证是模拟公式，不是 Intel TDX remote attestation。迁移 TDX 时保留 Registry/identity 边界，替换 quote verifier 和 enclave key lifecycle。

## 7. Automation 代码与状态机

Automation 运行在 TEE 外，是 scanner、relayer、watcher 和响应任务的常驻控制面。默认地址 `http://127.0.0.1:9200`。

Relayer 状态机：

```text
DISCOVERED
  -> WAITING_MATERIAL
  -> WAITING_FINALITY
  -> BUILDING_PROOF
  -> TEE_ATTESTING
  -> TARGET_SUBMITTING
  -> COMPLETED | WAITING_RESPONSE
```

异常终态包含 `ORPHANED/EXPIRED/FAILED`。EVM scanner 保存最近 block hash checkpoints；发生 reorg 时将事件标记 orphaned 并取消未完成任务。

Watcher 状态机：

```text
WATCHING_PENDING
  -> CHALLENGE_SUBMITTING
  -> WATCHING_CHALLENGE
  -> COMPENSATION_SUBMITTING
  -> COMPENSATED
```

如果有效 RESPONSE 先到，则进入 `COMPLETED`。只有 `feedback.required=true` 且 `atomicity.challengeWindow>0` 才登记 watcher。Watcher 是唯一被授权调用 challenge/compensation 的执行者；用户不直接发 challenge。

Automation REST API：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/health` | role、enabled chains、任务/cursor 数 |
| `PUT` | `/v1/materials/:key` | 发布业务正文和策略；key 通常是 requestID 或 callDataHash |
| `GET` | `/v1/materials/:key` | 查询材料 |
| `GET` | `/v1/events`、`/v1/cursors` | scanner 事件和游标 |
| `GET` | `/v1/tasks`、`/v1/tasks/:id` | worker 任务 |
| `GET` | `/v1/workflows`、`/v1/workflows/:id` | 工作流及分阶段耗时 |
| `POST` | `/v1/workflows/:id/cancel` | 取消未完成工作流 |
| `POST` | `/v1/jobs/response` | 任意 relayer 提交候选 ResponseProof |
| `POST` | `/v1/jobs/watch` | 显式 Watcher 任务 |
| `POST` | `/v1/jobs/checkpoint` | 显式 lifecycle checkpoint |

不存在 `/v1/jobs/relay`。业务 relay 只能由规范源链事件加匹配 material 触发。

`runtime/automation-tasks.json` 同时保存 events、cursors、materials、workflows、tasks、lease、retry 和阶段结果。它通过临时文件原子替换保证单进程持久化，但不支持多个 Automation 进程并发写。`AUTOMATION_ROLE=all|relayer|watcher` 只是角色拆分预留，不代表 JSON store 已支持多实例。

## 8. EVM 智能合约与真实业务动作

部署关系：

```text
TEERegistry
  <- EvmSourceContract / AvalancheWarpSourceContract 验 RESPONSE 和 checkpoint certificate
  <- HXMsgGateway 验 source proof certificate

HXMsgGateway
  -> TargetContract
       -> CrossChainAssetService -> CrossChainToken
       -> ReceivableRegistryService
       -> LogisticsTrackerService
       -> ConsentRegistryService
       -> OracleFeedService
       -> ApprovalWorkflowService
```

当前主入口：

| 合约 | 当前主入口 |
|---|---|
| `EvmSourceContract` | `submitHXMsgRequest`、`submitTokenEscrowHXMsgRequest` |
| `AvalancheWarpSourceContract` | `submitWarpHXMsgRequest`、`submitTokenEscrowWarpHXMsgRequest` |
| `HXMsgGateway` | `executeHXMsgMinimalCompactCluster`、`executeHXMsgMinimalCompactBatchCluster`、`executeFabricEVMCompactBatchCluster` |
| `TargetContract` | 仅 Gateway 可调用的 `executeCompact`、`executeAssetBatch` |
| `ResponseLifecycleBase` | `startChallenge`、`completeWithResponse`、`compensateAfterChallenge`、checkpoint |

真实资产语义：

| 动作 | 真实变化 |
|---|---|
| `token_transfer` | 从目标 `CrossChainAssetService` 预置 XCST reserve 调用真实 `transfer` 到 recipient |
| asset/mint/subsidy 类 | 调用 XCST `mint`，真实增加 recipient balance |
| EVM source token escrow | `transferFrom` 把 token 锁进 source contract；成功 RESPONSE 标记 settled；超时补偿真实 transfer 回 owner |
| Fabric source token escrow | 扣减 Fabric 余额、写 escrow；成功 RESPONSE settled；超时补偿恢复余额 |

非资产服务不是空函数。它们分别写入可独立查询的领域状态和事件。资产 batch 快路径有意不重复写完整 `CompactBusinessRecord`，但必须有逐条 ERC20 `Transfer` 事件、余额变化和 execution count 断言。

## 9. Fabric chaincode 状态与接口

活跃 chaincode 为 `fabric-chaincode/xcall/index.js`，channel=`mychannel`，chaincode=`xcall`。

| 接口 | 作用 |
|---|---|
| `EmitXCall` | 普通 Fabric 源请求，写 source record 和 `XCALL` 事件 |
| `LockAssetXCall` | 真实扣款并创建 escrow，再发 `ASSET_LOCKED_XCALL` |
| `QueryCrosschainEvent` | h-FSV source view |
| `ExecuteHXMsgCompact` | 单消息目标执行 |
| `ExecuteHXMsgCompactBatch` | TEE batch certificate 的批量目标执行 |
| `GetInboundStatus` | Fabric execution h-FSV RESPONSE view |
| `InitAssetBalance`、`QueryAssetBalance`、`QueryAssetEscrow` | 实验资产前置和断言 |
| `RegisterTrustedTEE`、`QueryTrustedTEE`、`QueryTEEClusterConfig` | Fabric 侧 TEE Registry |
| `BindResponseLifecycleHXMsg` | 将源请求 lifecycle 与已验证 hmsgDigest 绑定 |
| `QueryResponseLifecycle` | 查询统一生命周期 |
| `InitializeWatcherAuthorization`、`SetWatcherAuthorization` | Watcher 治理 |
| `StartChallenge` | timeout 后 challenge |
| `CompleteWithResponse` | 验证 RESPONSE certificate 并完成/结算 |
| `CompensateAfterChallenge` | challenge window 后真实补偿 |
| `PreviewLifecycleCheckpoint`、`UpdateLifecycleCheckpoint` | 终态批清理 |
| `QueryBusinessRecord`、`QueryBusinessRecordByRequest` | 查询真实目标业务结果 |

关键 world-state 前缀包括 `crosschainEvents:`、`inbound:`、`business:`、`businessByRequest:`、`assetBalance:`、`assetEscrow:`、`responseLifecycle:`、`trustedTEE:`、`teeClusterConfig:` 和 `lifecycleCheckpoint:`。

已删除的旧入口 `ExecuteHXMsg`、直接 `RefundAssetEscrow`、`GetAckStatus` 和空 `InitLedger` 不得恢复。Fabric refund 只能经 Watcher 状态机进入 `CompensateAfterChallenge`。

## 10. 容器、进程和端口拓扑

### 10.1 主 Compose 组

主文件是 `docker-compose.yml`。默认 Compose project name 来自目录名 `crosschain_experiment`，所以服务 `automation` 的实际容器名通常是 `crosschain_experiment-automation-1`。除非端口冲突，不要用 `-p` 另建一套同构容器。

| Compose service | 通常的容器名 | 主机端口 | 作用 |
|---|---|---:|---|
| `automation` | `crosschain_experiment-automation-1` | 9200 | scanner、relayer、watcher 和持久任务状态机 |
| `evm-node` | `crosschain_experiment-evm-node-1` | 8545 | Hardhat 本地 Ethereum，chain ID 31337 |
| `avalanche-rpc-proxy` | `crosschain_experiment-avalanche-rpc-proxy-1` | 无公开端口 | 将容器请求按路径转发到宿主机 5 个 AvalancheGo 节点 |
| `tee-verifier` | `crosschain_experiment-tee-verifier-1` | 9000 | Ethereum proof subnet 节点 1 |
| `tee-verifier-2` 至 `tee-verifier-5` | 同名前缀容器 | 9001 至 9004 | Ethereum proof subnet 节点 2 至 5 |
| `tee-fabric-1` 至 `tee-fabric-5` | 同名前缀容器 | 9100 至 9104 | Fabric proof subnet 五节点 |
| `tee-avalanche-1` 至 `tee-avalanche-5` | 同名前缀容器 | 9020 至 9024 | Avalanche proof subnet 五节点 |
| `deployer` | 临时工具容器 | 无 | 编译并部署本地 EVM 合约；正常优先用 npm 部署命令，不常驻 |

所有 TEE 容器都执行同一份 `tee-verifier/server.js`。差异仅由 `TEE_SUBNET_PROFILE`、cluster ID、节点身份、peer URL、Raft secret 和链端点注入。三个子网的测试签名私钥目前是 Compose 中可复现的本地开发密钥，这只是模拟 TEE；真实 TDX 部署必须由 enclave 内部生成/密封密钥并用远程证明完成注册。

### 10.2 Fabric Compose 组

Fabric 文件是 `docker-compose.fabric.yml`，服务使用显式容器名：

| 容器 | 端口 | 作用 |
|---|---:|---|
| `fabric-ca.org1.example.com` | 7054 | Org1 CA |
| `orderer.example.com` | 7050 | 单 orderer |
| `peer0.org1.example.com` | 7051、7052 | Org1 peer 0 和 chaincode 端口 |
| `peer1.org1.example.com` | 8051、8052 | Org1 peer 1 |
| `peer2.org1.example.com` | 9051、9052 | Org1 peer 2 |
| `peer3.org1.example.com` | 10051、10052 | Org1 peer 3 |
| `fabric-tools` | 无 | 只通过 `docker compose run --rm` 执行建通道和部署链码，不应常驻 |
| `dev-peer...-xcall...` | 动态 | peer 启动的 chaincode 容器，不要手工创建 |

Fabric peer 的 chaincode network mode 默认为 `crosschain_experiment_default`，从而和主 Compose 的 TEE/Automation 通信。若改目录名或 Compose project name，必须同步检查 `FABRIC_DOCKER_NETWORK`。

### 10.3 AvalancheGo 不是 Docker 容器

本地 Avalanche 使用 Avalanche CLI 在宿主机启动 5 个真实 AvalancheGo validator 进程，不在 Docker 中。默认节点 API 端口是 `9650`、`9652`、`9654`、`9656`、`9658`。容器中的 `avalanche-rpc-proxy` 仅负责访问这些宿主进程。

```bash
npm run avalanche:up
npm run avalanche:status
npm run avalanche:down
```

`avalanche:up` 会同时执行 `generate-avalanche-pchain-trust-anchor.js`，生成当前网络的 genesis-pinned validator trust anchor。不要只启动 C-Chain RPC 而跳过该锚。

### 10.4 Mercury 消融实验容器组

权威 Mercury baseline 位于同级独立仓库 `/home/zex/projects/crosschain_experiment/mercury_reproduction`，Compose project 明确叫 `mercury-ablation`。它有 5 个 Mercury TEE（9300 至 9304）和 EOS `nodeos`（8888/9876）。该组不属于 h-xmsg 主实验，不能和主项目容器混为一组，也不要为了主实验启动它。

## 11. 环境变量、账户和密钥

### 11.1 `.env` 只记录变量名，不记录秘密值

根目录 `.env` 被 `.gitignore` 忽略。当前 Sepolia 相关变量包括：

| 变量 | 用途 |
|---|---|
| `SEPOLIA_RPC_URL` | Sepolia execution JSON-RPC，用于交易、receipt 和 execution block |
| `SEPOLIA_BEACON_API_URL` | Beacon REST API，一般 finality 查询 |
| `SEPOLIA_LIGHT_CLIENT_BEACON_API_URL` | 必须支持 `/eth/v1/beacon/light_client/*` 的轻客户端 API |
| `SEPOLIA_TRUSTED_BLOCK_ROOT` | 当前人工引导的可信 Beacon block root；验证成功后可滚动更新 |
| `SEPOLIA_CHAIN_ID` | 应为 11155111 |
| `SEPOLIA_ACCOUNT_ADDRESS` | 公开测试账户地址 |
| `SEPOLIA_PRIVATE_KEY` | Sepolia 交易签名私钥，绝不写入文档或 Git |
| `DEPLOYER_PRIVATE_KEY` | Sepolia 合约部署私钥，绝不写入文档或 Git |
| `SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT` | 默认 false；禁止在没有已有可信锚的情况下动态相信远端根 |
| `SEPOLIA_UPDATE_ENV_TRUSTED_ROOT` | 默认 true；成功完成严格轻客户端验证后滚动更新 `.env` 中的根 |
| `SEPOLIA_MAX_ANCESTOR_HEADERS` | execution ancestry 的最大回溯窗口，Compose 默认 512 |

当前公开 Sepolia 测试地址是 `0x54aDD75dEED257F3BF2815B71ED75B3dcc7E0C7c`。`SEPOLIA_PRIVATE_KEY` 与 `DEPLOYER_PRIVATE_KEY` 当前均应派生到该地址，但新 AI 只能通过代码派生地址做一致性检查，不能打印私钥。RPC URL 也应在日志中遮蔽 API key。

执行一次权限检查：

```bash
stat -c '%a %n' .env fabric-network/wallet/appUser.id
chmod 600 .env fabric-network/wallet/appUser.id
```

当前审计发现两者曾是 `0644`，应视为本地安全风险。只有用户明确允许时才改权限。

### 11.2 Execution RPC 与 Beacon API 不能混用

`SEPOLIA_RPC_URL` 处理 EVM JSON-RPC；Beacon URL 处理共识层对象、finality branch、Sync Committee update。Alchemy/Infura 的普通 Ethereum endpoint 不能自动替代 Beacon light-client endpoint。四方向 preflight 会先验证这一点。

### 11.3 Fabric wallet 是本地身份材料

`fabric-network/wallet/appUser.id` 包含 X.509 证书和私钥。它当前意外处于 Git 跟踪且有修改，这是需要后续安全处理的问题：

1. 不读取或展示其中私钥。
2. 不把它加入提交。
3. 在用户确认后，从 Git 历史/索引移除并改为目标主机自行运行 `npm run fabric:wallet` 生成。
4. `fabric-network/wallet/README.md` 仅描述恢复步骤，不是可公开 wallet 本体。

### 11.4 本地开发账户

Hardhat 和 Avalanche CLI 的 prefunded key 只用于本机可复现实验。四方向脚本每次创建随机部署账户，再由各本地链的 prefunded account 向它充值，避免复用 nonce。Compose 中 TEE key 也只是测试 key。以上任何密钥均不具备生产安全性，不得迁移为真实 TDX signer key。

## 12. 两两启动、部署和清理的标准流程

受本机资源限制，常规实验只启动两条链。统一入口：

```bash
npm run pair:up -- evm-fabric
npm run pair:up -- evm-avalanche
npm run pair:up -- fabric-avalanche
npm run pair:down
```

`scripts/manage-chain-pair.js` 会先停止三条链的已知服务、15 个 TEE、Automation、动态 Fabric chaincode 容器和 AvalancheGo，然后只启动所选两条链、对应的两个五节点 TEE 子网与一个 Automation。不要在它之外再创建第二个 Automation。

### 12.1 EVM + Fabric

首次初始化 Fabric：

```bash
docker compose -f docker-compose.fabric.yml run --rm fabric-tools \
  bash /fabric-network/fabric-network/scripts/bootstrap.sh
npm run fabric:up
npm run fabric:channel
npm run fabric:wallet
npm run fabric:cc:deploy
```

以后实验：

```bash
npm run pair:up -- evm-fabric
npm run deploy
npm run fabric:cc:deploy
```

`fabric:channel` 只在 ledger 初始化后执行一次。`fabric:cc:deploy` 会读取已提交 definition 并自动使用当前 sequence + 1。`npm run fabric:down` 实际执行 `down -v`，会破坏性删除 Fabric volume，不能作为普通“停机”命令。

### 12.2 EVM + Avalanche

```bash
npm run pair:up -- evm-avalanche
npm run deploy
npm run deploy:avalanche
```

pair manager 已经启动 5 个 AvalancheGo 并生成 P-Chain anchor；不要再运行第二次 `avalanche:up`。

### 12.3 Fabric + Avalanche

```bash
npm run pair:up -- fabric-avalanche
npm run deploy:avalanche
npm run fabric:cc:deploy
```

此组合不应启动 `evm-node` 或 Ethereum proof subnet。Fabric 和 Avalanche 的 EVM-compatible target 都由 Avalanche deployment 提供。

### 12.4 部署后必须重建 Automation

Automation 在启动时读取 deployment 地址。`pair:up` 先启动 Automation，而随后 fresh deploy 会改变地址，因此稳妥顺序是：

```bash
docker compose stop automation
rm -f runtime/automation-tasks.json
AUTOMATION_ENABLED_CHAINS=ethereum,avalanche \
  docker compose up -d --force-recreate automation
curl -s http://127.0.0.1:9200/health
```

把 `AUTOMATION_ENABLED_CHAINS` 换成实际组合。只为干净实验删除 `runtime/automation-tasks.json`；不要顺手删除 Sync Committee state、P-Chain trust anchor、deployment 文件或历史结果。

### 12.5 Challenge 实验要切换 Watcher-only

Challenge/timeout rollback 脚本要求 Automation 不主动 relay 原请求，否则正常路径会先完成，无法制造超时：

```bash
docker compose stop automation
AUTOMATION_ENABLED_CHAINS=ethereum,avalanche AUTOMATION_ROLE=watcher \
  docker compose up -d --force-recreate automation
npm run automation:test:challenge:ethereum-avalanche
```

测试后将 `AUTOMATION_ROLE=all` 并重建容器。普通 batch、atomic 和 E2E 不使用 watcher-only。

### 12.6 当前 Docker 可用性诊断

本手册生成时，一次 `docker compose config` 检查返回“WSL 2 distro 中找不到 docker”。这通常是 Docker Desktop 的 WSL integration 没有开启或临时失联，不是项目 Compose 文件缺失。新会话先执行：

```bash
docker version
docker compose version
```

若命令不存在，在 Docker Desktop Settings -> Resources -> WSL Integration 中重新启用当前发行版，再重开 WSL。不要因此新装第二套互相冲突的 Docker daemon。

## 13. 测试入口：必须区分三类

### 13.1 纯代码/协议专项测试

| 命令 | 前置 | 验证内容 | 结果 |
|---|---|---|---|
| `npm test` | 无，Hardhat test 自带临时链 | P-Chain trust + TEE 子网密码学隔离 | 控制台 |
| `npm run test:node` | 无 | P-Chain anchor 三类单元测试 | 控制台 |
| `npm run test:hardhat` | 无 | cluster/domain/subnet 隔离合约测试 | 控制台 |
| `npm run automation:test:store` | 无 | cursor、lease、retry、reorg、持久恢复 | `runtime/automation-store-test-result.json` |
| `npm run hxmsg:test:challenge` | Hardhat | EVM lifecycle 七类状态机用例 | JSON + Markdown |
| `npm run hxmsg:test:checkpoint` | Hardhat | checkpoint 预览、证书和批清理 | `runtime/lifecycle-checkpoint-test-result.json` |
| `npm run raft:test` | Ethereum 五 TEE | 选举、复制、故障、重启、barrier | JSON + Markdown |
| `npm run hxmsg:test:forgery` | EVM、Fabric 与相应 TEE | 两方向“自洽伪造”均应被源链事实证明拒绝 | JSON + Markdown |

`hxmsg:test:forgery` 和 `raft:test` 可以直接访问 TEE，因为它们是协议安全专项测试；这不构成业务 E2E 旁路。

### 13.2 普通 Automation 端到端测试

| 方向/语义 | 命令 | 默认结果文件 |
|---|---|---|
| Ethereum -> Avalanche | `npm run automation:test:ethereum-avalanche` | `automation-ethereum-avalanche-e2e-result.json` |
| Ethereum -> Avalanche，非转账 Oracle | `npm run automation:test:ethereum-avalanche:oracle` | 由脚本指定的 E2E 结果/报告 |
| Avalanche -> Ethereum | `npm run automation:test:avalanche-ethereum` | `automation-avalanche-ethereum-e2e-result.json` |
| Ethereum -> Fabric | `npm run automation:test:evm-fabric` | `automation-evm-fabric-e2e-result.json` |
| Fabric -> Ethereum | `npm run automation:test:fabric-evm` | `automation-fabric-evm-e2e-result.json` |

Fabric 与 Avalanche 没有另写一套“简单直连”脚本。若只测一条，可用批处理驱动并设 `AUTOMATION_BATCH_EXPERIMENT_SIZE=1`；Avalanche -> Fabric 必须保留真实 Warp 证明，不得用普通 EVM receipt 路径冒充。

每个普通用例都必须满足：源链真实事件、Automation workflow、源证明、正确 TEE subnet、Raft quorum、目标链真实动作和目标状态断言。仅出现 tx hash 不等于测试通过。

### 13.3 TEE 批签名 + 目标批量转账

每个脚本各运行两个方向、两个实验标签，一共四组；默认/推荐批次为 8：

```bash
AUTOMATION_BATCH_EXPERIMENT_SIZE=8 npm run automation:test:batch:ethereum-fabric
AUTOMATION_BATCH_EXPERIMENT_SIZE=8 npm run automation:test:batch:ethereum-avalanche
AUTOMATION_BATCH_EXPERIMENT_SIZE=8 npm run automation:test:batch:fabric-avalanche
```

注意：当前 `tee-batch-signing` 与 `batch-transfer` 都会生成多条真实 source 请求、对 batch root 给出一次 TEE quorum certificate，并在目标链用一笔 batch transaction 完成多笔真实 token transfer。二者是不同实验标签/ID/metadata，不是两条本质不同的协议实现，论文不能把它们虚构成两个独立机制。

批大小可通过环境变量调整。大批次会受到 source 交易吞吐、目标 block gas limit、Fabric proposal 大小和 Automation timeout 约束。不要为批次 16/32 创建专用合约或写死数组长度。

### 13.4 需要 RESPONSE + atomicity 的批处理

```bash
AUTOMATION_ATOMIC_BATCH_SIZE=8 npm run automation:test:batch:ethereum-fabric:atomic
AUTOMATION_ATOMIC_BATCH_SIZE=8 npm run automation:test:batch:ethereum-avalanche:atomic
AUTOMATION_ATOMIC_BATCH_SIZE=8 npm run automation:test:batch:fabric-avalanche:atomic
```

这些测试走同一 Automation 主路径，并额外完成 target execution fact -> ResponseProof -> 源链 RESPONSE certificate -> escrow settle/terminal lifecycle。任意 relayer 可提交候选 response；TEE 只接受可由目标链事实证明验证的候选。

### 13.5 Challenge 与超时真实补偿

先按第 12.5 节将 Automation 切为 watcher-only，再执行：

```bash
npm run automation:test:challenge:ethereum-fabric
npm run automation:test:challenge:ethereum-avalanche
npm run automation:test:challenge:fabric-avalanche
```

每个脚本覆盖两个方向。预期结果不是只改状态：源链 escrow 必须先真实扣款；deadline 后 Watcher 发 challenge；challenge window 后执行通用 compensation handler；EVM ERC20 或 Fabric 资产余额必须真实退回。

独立 EVM Watcher escrow 测试：

```bash
npm run automation:test:watcher-escrow
```

### 13.6 2026-08-11 两两链完整回归基线

当前工作树最近一次完整回归覆盖三种链对，每个链对两个方向，并包含：8 条 TEE batch signing、8 条 batch transfer、需要 RESPONSE/atomicity 的 batch、challenge、timeout rollback。总计 `24/24` 场景通过。权威摘要是：

`runtime/three-chain-pairwise-automation-test-summary-2026-08-11.md`

`runtime/` 被 Git 忽略，因此它是本机实验记录，不是代码规范；修改核心逻辑后必须重跑，不能永远引用该旧日期结果。

## 14. Gas 统计口径

项目使用与 Mercury 对比时的 protocol gas 口径：

```text
EVM-compatible source transaction gas
+ EVM-compatible target transaction gas
+ RESPONSE/challenge/compensation 中属于该协议路径的 EVM transaction gas
```

不纳入每笔均值：合约部署、初始 reserve 注资、一次性 TEE 注册、Fabric 网络初始化、链码部署、链下 proof 构造、TEE CPU 和 Raft 网络时间。Fabric 没有 EVM gas，因此报告为 0 gas，但必须另报 Fabric latency/transaction count，不能写成“无成本”。

批次平均每笔：

```text
avgProtocolGas = sum(protocol transactions gasUsed) / numberOfBusinessMessages
```

对 EVM -> EVM，通常同时计 source 和 target；对 Fabric -> EVM，只计 EVM target；对 EVM -> Fabric，只计 EVM source。需要 RESPONSE/atomicity 时，源链 completion 或 challenge/compensation 交易也应按实验定义列出。必须同时给出总 gas、batch size、平均 gas 和包含的交易集合，不能只摘最低的 target 平均值。

Gas 优化仍保留真实语义：`CompactCall` 代替动态字符串业务数据；链上只接收 minimal h-xmsg；TEE 对 batch root 一次签名；EVM target 重算 root 并一笔完成 batch；资产 batch 避免重复完整业务记录，但保留真实余额变化和逐条 `Transfer`。禁止为了低 gas 改成空函数或只写一个“完成”状态。

## 15. Sepolia 真链实验

### 15.1 四方向脚本的准确含义

```bash
npm run sepolia:test:four-directions:preflight
npm run sepolia:test:four-directions
```

四方向是：

1. local Ethereum -> Sepolia
2. local Avalanche -> Sepolia
3. Sepolia -> local Ethereum
4. Sepolia -> local Avalanche

它不包含 Fabric。脚本会自动：启动 `evm-avalanche` 链对；为两条本地链创建并充值随机实验 deployer；重新部署本地合约；清理本次 Automation store；以 `ethereum,avalanche,sepolia` 重建唯一 Automation；执行 preflight；串行运行四个方向以避免 Sepolia nonce 冲突；保存汇总。

Sepolia 为源链的两条方向需要真正等待 finalized checkpoint，默认最长 `40` 分钟。统计时 `finalityWaitMs` 与 `executionWithoutFinalityMs` 分开。不要通过降低确认数冒充 finality。

### 15.2 Preflight 检查

`run-sepolia-four-direction-preflight.js` 会检查：

1. Sepolia wallet/deployer 私钥派生地址一致且余额达到阈值。
2. Sepolia deployment 地址上确有 bytecode，ABI 为 compact gateway。
3. Sepolia target reserve 足够执行真实转账。
4. Ethereum 和 Avalanche 两个源证明子网均为 5/5 健康、存在 leader、Raft log 对齐。
5. Beacon light-client API 可达，当前 Sync Committee 参与者达到阈值。
6. trusted root 能严格衔接到当前 update，而不是把 RPC 返回值直接当可信根。

`npm run sepolia:sync-committee` 本身不发送业务交易，可独立检查并更新 `runtime/sepolia-sync-committee-state.json`。四方向 preflight 为避免未完成业务前改变状态，会以不持久化模式运行检查。

### 15.3 Sepolia 与 Fabric 单独脚本

```bash
npm run sepolia:test:evm-fabric
npm run sepolia:test:fabric-evm
```

这些 wrapper 不负责完整启动基础设施。Sepolia -> Fabric 需要：Fabric 网络、Fabric chaincode、Ethereum proof subnet、Automation enabled chains=`sepolia,fabric`。Fabric -> Sepolia 需要 Fabric proof subnet、Sepolia 已部署 gateway/registry/target 和 Automation enabled chains=`fabric,sepolia`。

### 15.4 Sepolia 与 Avalanche 单独脚本

```bash
npm run sepolia:test:avalanche-sepolia
npm run sepolia:test:sepolia-avalanche
```

它们是 Automation-aware 的 Warp/Sync Committee wrapper，但不会像四方向总脚本一样保证从零启动所有服务。优先使用总脚本做可复现实验，单脚本用于定位某个方向。

### 15.5 Sync Committee state 和信任根

持久状态在 `runtime/sepolia-sync-committee-state.json`。严格验证会从 `.env` 中已人工审核的 trusted block root 开始，验证跨 period 的 committee update、finality branch、execution payload branch 和 parentHash ancestry，成功后才可滚动到新的根。不能因为等待时间长就把当前公共 API 返回的 root 直接写成可信根。

若出现 `sync committee trusted block root mismatch`，先检查上一次实验是否在验证全部成功前修改了 `.env`，以及 state 文件和当前 API period 是否一致。不要把全历史 Sync Committee 证明塞进 Raft 日志；Raft 只提交最终验证结论与必要摘要，每个 TEE 本地维护有限 header/committee 状态。

## 16. Runtime 文件和实验结果映射

`runtime/` 整体被 `.gitignore` 忽略。它同时包含当前部署地址、协议状态和历史结果，不能一刀切清空。

### 16.1 不应随便删除的状态

| 文件/模式 | 作用 |
|---|---|
| `deployment.json` | 本地 Hardhat 合约地址 |
| `avalanche-deployment.json` | 本地 Avalanche C-Chain 合约地址 |
| `deployment.sepolia.json` | Sepolia 合约地址 |
| `avalanche-pchain-trust-anchor.json` | 本地 Avalanche genesis/P-Chain validator 锚 |
| `sepolia-sync-committee-state.json` | Sepolia 轻客户端滚动状态 |
| `automation-tasks.json` | Automation event/cursor/material/workflow/task 数据库 |
| `tee-state-*.json` | TEE 已处理/防重放状态 |
| `tee-consensus-*.json` | Raft term、vote、log、commit 状态 |
| `tee-chain-state-*.json` | 各 TEE 本地 header/committee/chain state |

### 16.2 主要结果文件

| 测试 | 结果 |
|---|---|
| Automation store | `automation-store-test-result.json` |
| Ethereum -> Fabric | `automation-evm-fabric-e2e-result.json` |
| Fabric -> Ethereum | `automation-fabric-evm-e2e-result.json` |
| Ethereum -> Avalanche | `automation-ethereum-avalanche-e2e-result.json` 和报告 |
| Avalanche -> Ethereum | `automation-avalanche-ethereum-e2e-result.json` |
| 三链 pair batch | `automation-*-batch-experiments.json` 与部分 Markdown report |
| atomic batch | `automation-*-atomic-batch-result.json` |
| challenge/rollback | `automation-*-challenge-rollback-result.json` |
| Sepolia 四方向 | `sepolia-four-direction-automation-result.json` |
| Sepolia preflight | `sepolia-four-direction-preflight.json` |
| Sync Committee | `sepolia-sync-committee-result.json` 和 summary |
| Raft | `raft-cluster-test-results.json` 和 summary |
| 自洽伪造攻击 | `hxmsg-forgery-attack-results.json` 和 summary |
| lifecycle/checkpoint | `hxmsg-challenge-response-results.json`、`lifecycle-checkpoint-test-result.json` |

结果文件名可能残留旧日期实验。判断有效性必须同时检查 `testedAt`、当前 Git/worktree 状态、deployment 地址、batch size、方向、`pass`、Automation workflow state 和真实余额/业务断言。

## 17. 逐文件索引

以下索引覆盖当前工作树中应由开发者理解的所有源码、配置、文档和脚本。`node_modules/`、`artifacts/`、`cache/`、`runtime/` 和 `fabric-network/runtime/` 属于生成物，按第 17.10 节处理。

### 17.1 根目录文件

| 文件 | 作用与使用约束 |
|---|---|
| `README.md` | 面向读者的项目总览、部署和实验说明；部分历史段落可能落后于工作树，冲突时以本手册和代码为准 |
| `package.json` | 所有正式 npm 入口和 JS/Solidity 依赖；新 AI 应先复用现有 script，而不是另造入口 |
| `package-lock.json` | 锁定 Node 依赖版本，修改依赖时一并更新 |
| `hardhat.config.js` | Solidity 0.8.24、optimizer runs=200、`viaIR`、本地高 block gas limit、localhost/Sepolia 网络配置 |
| `docker-compose.yml` | Automation、本地 Hardhat、RPC proxy 和三个五节点 TEE 子网的唯一主 Compose 定义 |
| `docker-compose.fabric.yml` | Fabric CA、orderer、四 peers 和临时 fabric-tools 定义 |
| `.env` | Git 忽略的本地秘密和 Sepolia trust root；绝不提交或展示值 |
| `.gitignore` | 忽略 `node_modules`、`artifacts`、`cache`、`.env`、`logs`、`runtime`、`.claude` |

### 17.2 `automation/`：唯一业务投递编排层

| 文件 | 作用 |
|---|---|
| `automation/server.js` | 启动 HTTP API、AutomationStore、ListenerService、RelayerService、WatcherService；按 `AUTOMATION_ROLE` 装配角色 |
| `automation/config.js` | 定义 ethereum/sepolia/avalanche/fabric profile，读取 deployment、RPC、wallet、chain ID，按源链选择 TEE subnet |
| `automation/client.js` | 测试驱动调用 Automation API、发布 material、等待 workflow 的客户端工具 |
| `automation/fabric-client.js` | 用 Fabric connection profile/wallet 建 Gateway，供 scanner、proof builder 和 submitter 复用 |
| `automation/handlers.js` | API 请求处理与 RESPONSE/checkpoint/watch job 的参数归一、入库和 workflow 关联 |
| `automation/tee-client.js` | 在 5 节点 subnet 中发现 leader、处理 term/barrier 重试、请求单笔/batch/response/checkpoint quorum certificate |
| `automation/avalanche-rpc-proxy.js` | 容器到宿主 AvalancheGo 多节点 RPC 的薄代理；不验证证明，不是 relayer |
| `automation/relayer/adapter-dispatch.js` | 按 source/target profile 选择 scanner、finality、proof builder 和 target submitter，保持核心状态机无链特例 |
| `automation/relayer/relayer-service.js` | Relayer 工作流推进器；生成各阶段 task、lease/retry、计时并驱动到 COMPLETED/WAITING_RESPONSE |
| `automation/relayer/source-lifecycle-binder.js` | 在需要 RESPONSE/atomicity 时，把规范 hmsgDigest/certificate 与源链 lifecycle 绑定 |
| `automation/relayer/target-submitter.js` | 目标统一入口；EVM 只走 compact gateway，Fabric 只走 `ExecuteHXMsgCompact*`，无动态 calldata fallback |
| `automation/watcher/chain-client.js` | Watcher 对 EVM/Fabric source lifecycle 的查询、授权、challenge、response completion、compensation、checkpoint 操作 |
| `automation/watcher/watcher-service.js` | 观察 deadline/challenge window，推进 watcher 状态机并真实结算或补偿 |
| `automation/shared/listener-service.js` | 启动各链 scanner 周期，持久事件与 cursor，把匹配 material 的事件交给 Relayer |
| `automation/shared/core/state-machines.js` | Relayer 和 Watcher 合法状态、终态及迁移约束；修改流程先改这里并补测试 |
| `automation/shared/core/retry-policy.js` | 可重试错误分类、指数退避、最大次数和 lease 时间规则 |
| `automation/shared/store/automation-store.js` | 单进程 JSON 数据库；events/cursors/materials/workflows/tasks/leases/idempotency/reorg rollback |
| `automation/shared/adapters/index.js` | 适配器注册表，按 profile 创建 scanner/finality/proof builder |
| `automation/shared/adapters/evm/scanner-base.js` | EVM log 范围扫描、确认游标、block hash 记录和 reorg rollback 的公共基类 |
| `automation/shared/adapters/ethereum/scanner.js` | EvmSourceContract 事件扫描器；同时用于 local Ethereum 与 Sepolia profile |
| `automation/shared/adapters/ethereum/finality.js` | local header committee 或 Sepolia Sync Committee finality 策略选择与等待 |
| `automation/shared/adapters/ethereum/proof-builder.js` | 构造 canonical h-xmsg、receipt MPT、header/finality helper data 和 compact execution material |
| `automation/shared/adapters/avalanche/scanner.js` | AvalancheWarpSourceContract/Warp 事件扫描器 |
| `automation/shared/adapters/avalanche/finality.js` | 等待 Avalanche source 可构造 Warp 权重证明的状态 |
| `automation/shared/adapters/avalanche/proof-builder.js` | 从真实 Warp message、validator signatures 和 P-Chain trust data 构造 TEE 输入 |
| `automation/shared/adapters/fabric/scanner.js` | 按 Fabric block/event 扫描 `XCALL`、`ASSET_LOCKED_XCALL` 等，持久 block cursor |
| `automation/shared/adapters/fabric/finality.js` | Fabric 确定性提交策略；不套用 EVM finality |
| `automation/shared/adapters/fabric/proof-builder.js` | 构造 h-FSV view ref/policy/canonical h-xmsg；证明本身由每个 Fabric TEE 主动向 endorsers/QSCC 获取 |

Automation 的关键边界：scanner 只发现事件；proof-builder 只构造链特定材料；TEE 独立验真；target-submitter 只消费已认证结果。不要把 RPC 查询结果在 handler 中直接改写成“已验证”。

### 17.3 `hxmsg-builder/`：规范消息构建层

| 文件 | 作用 |
|---|---|
| `hxmsg-builder/compose.js` | 合并 source fact、target action、verification、feedback、atomicity，构造 canonical h-xmsg/envelope；活跃调用 `hydrateLegacyHXMsg` 兼容内部别名 |
| `hxmsg-builder/evm-to-evm.js` | local Ethereum/Sepolia -> Ethereum/Avalanche 的 receipt event 到 h-xmsg 构建器 |
| `hxmsg-builder/evm-to-fabric.js` | Ethereum/Sepolia -> Fabric 的构建器，目标 selector 对齐 `ExecuteHXMsgCompact` |
| `hxmsg-builder/fabric-to-evm.js` | Fabric event -> Ethereum/Avalanche/Sepolia 的构建器，绑定 h-FSV source record |
| `hxmsg-builder/response.js` | 从 EVM receipt 或 Fabric inbound status 构造 RESPONSE proof ref，不赋予 relayer信任 |
| `hxmsg-builder/source-builders/evm.js` | 解析真实 `CrossChainCall` log，建立 event ref/payload hash，并检查 feedback/atomicity 与源事件一致 |
| `hxmsg-builder/source-builders/fabric.js` | 规范 Fabric source record/view ref/policy hash，检查源 payload 的反馈与原子性绑定 |
| `hxmsg-builder/target-builders/evm.js` | 构造 EVM-compatible compact target action 和 callDataHash |
| `hxmsg-builder/target-builders/fabric.js` | 构造 Fabric compact target action、selector 和 payload binding |

加入新链时优先新增 source/target builder 与 adapter，不在已有 Ethereum/Fabric/Avalanche builder 中堆新的 `if chain`。h-xmsg 顶层结构不应因加链而变化。

### 17.4 `shared/hxmsg/` 与通用共享代码

| 文件 | 作用与当前身份 |
|---|---|
| `shared/hxmsg/constants.js` | ChainType、VerificationMethod、FeedbackType、AtomicityMode、ResponseStatus、CommitmentType 等协议枚举 |
| `shared/hxmsg/canonical.js` | 输入归一到 canonical 三层 h-xmsg，处理 finality/policyRef 与兼容别名 |
| `shared/hxmsg/envelope.js` | envelope 构造、sourceEvidence/executionData/auditRecord 提取、binding 校验；`hydrateLegacyHXMsg` 名字旧但仍是活跃兼容函数 |
| `shared/hxmsg/hash.js` | hmsgDigest、feedback/atomicity、target execution、replay scope、response digest；`toMinimalHXMsg` 是当前 19 字段链上 ABI 转换 |
| `shared/hxmsg/invariants.js` | 强制 feedback、atomicity 和超时策略之间的逻辑不变量 |
| `shared/hxmsg/codec.js` | stable JSON、bytes32/address/chain ID 编解码工具 |
| `shared/hxmsg/batch.js` | batch leaf、Merkle tree、proof 和 batch signing digest；EVM target 目前重算整批 root，Fabric delivery 仍可携逐消息 proof |
| `shared/hxmsg/checkpoint.js` | lifecycle terminal records 的 Merkle root、checkpoint digest 与离线验证 |
| `shared/hxmsg/delivery.js` | delivery message 工具；其中 `toMinimalHXMsgV2` 是较旧 17 字段形式，当前 target submitter 不使用它，不得误当最新 ABI |
| `shared/hxmsg/evm-melv-policy.js` | 构造 EVM MELV-EF proof policy/ref 和默认参数 |
| `shared/hxmsg/fabric-hfsv-policy.js` | 构造 h-FSV endorsement/MSP policy，读取 root cert hashes |
| `shared/hxmsg/index.js` | 统一导出上述协议 API，业务脚本应从这里引入稳定接口 |
| `shared/xmsg.js` | 业务 payload 归一和 `CompactCall` 编码；维护 opCode 1 至 9、金额单位、actor address/hash 与 metadata hash |
| `shared/env.js` | 无依赖 `.env` parser/loader；环境变量已有值时不覆盖 |
| `shared/utils.js` | `runtime/` JSON 读写和目录辅助 |

`shared/hxmsg/hash.js::toOnChainHXMsg()` 当前没有主路径调用者，是保留的完整 on-chain 表示工具；不要据此新增完整 h-xmsg 上链路径。若确认删除，必须先全仓 `rg` 并跑所有方向。

### 17.5 `shared/evm/`、`shared/avalanche/` 与 `shared/tee/`

| 文件 | 作用 |
|---|---|
| `shared/evm/header-committee.js` | 本地 Hardhat 实验的模拟 header committee update；只替换委员会输入，不在 TEE 内另写一套 receipt 验证 |
| `shared/evm/receipt-proof.js` | 从 block receipts 构建 receipt trie/MPT proof，编码 typed/legacy receipt，并按 receiptsRoot 验证 |
| `shared/evm/sync-committee-light-client.js` | SSZ root、BLS aggregate signature、Merkle branch、fork/domain、finality/execution payload/committee update 的真实 Beacon 轻客户端验证 |
| `shared/evm/sync-committee-state.js` | Sync Committee state 文件、trusted root、period 轮换和有限状态持久化 |
| `shared/avalanche/warp-proof.js` | 真实 Warp unsigned message/payload、validator signature、权重聚合和证明材料工具 |
| `shared/avalanche/pchain-trust.js` | genesis-pinned P-Chain anchor 规范化、validator set hash、height/network 校验 |
| `shared/tee/attestation.js` | 当前模拟 TDX quote/measurement/identity 的可替换 attestation provider 和验签辅助 |
| `shared/tee/registration.js` | 从 TEE health/identity 收集注册材料，写入 EVM TEERegistry 或 Fabric registry |
| `shared/tee/quorum-certificate.js` | ECDSA quorum certificate digest、签名恢复、threshold 和 signer index 校验 |
| `shared/tee/subnet-routing.js` | source chain type -> 五节点 subnet URL/cluster ID 路由，阻止错误子网验错链 |
| `shared/tee/domains.js` | cluster、subnet、source chain、purpose 的 domain-separated digest；防止跨子网/跨链重放签名 |

`@chainsafe/bls` 依赖服务于 Ethereum Sync Committee 与 Avalanche Warp 的原生 BLS 验证，不代表 TEE quorum 使用 BLS。

### 17.6 `tee-verifier/`：模拟 TEE 内执行代码

| 文件 | 作用 |
|---|---|
| `tee-verifier/server.js` | 单个 TEE 节点完整进程：subnet scope、proof adapter、Raft election/log/commit/barrier/lease、单笔/batch/response/checkpoint attestation、状态持久化和健康 API |
| `tee-verifier/adapters/index.js` | 按 canonical source chain/verification method 选择唯一源事实验证器 |
| `tee-verifier/adapters/evm-melv-adapter.js` | EVM 轻客户端式验证：维护有限 header window，验证 local committee 或 Sepolia Sync Committee finality，再验证 receipt MPT 和事件字段绑定 |
| `tee-verifier/adapters/fabric-hfsv-adapter.js` | h-FSV：TEE 主动向多个 peer 发同一 proposal，验证 payload 一致、X.509/MSP endorsement policy，再用 QSCC/block rwset 确认 VALID transaction；也验证 Fabric RESPONSE view |
| `tee-verifier/adapters/fabric-block.js` | 解码 Fabric block/envelope/action/rwset，检查 tx ID、block number、validation code 和预期 state write |
| `tee-verifier/adapters/avalanche-icm-adapter.js` | 验 Warp message/payload、P-Chain validator set anchor、各节点独立 P-Chain 查询、67% 权重 BLS 和 h-xmsg binding |
| `tee-verifier/msp-certs/ca-cert.pem` | Fabric h-FSV 默认 MSP root trust material |
| `tee-verifier/msp-certs/orderer-signcert.pem` | Fabric block/orderer 相关验证的本地证书材料 |

`server.js` 当前规模很大但属于 TEE trusted computing base。迁往 TDX 时应保留 adapter API，将 transport/storage/attestation provider 替换为真实运行时，不在 enclave 内维护“本地模拟版”和“服务器版”两套业务验证代码。

### 17.7 `contracts/`：Solidity 文件

| 文件 | 作用 |
|---|---|
| `contracts/HXMsgLib.sol` | minimal h-xmsg、atomicity、response、cluster certificate struct 和链上 digest |
| `contracts/TEERegistry.sol` | owner 治理的 TEE 注册、cluster membership/epoch/threshold 和 domain-separated ECDSA quorum 验证 |
| `contracts/EvmSourceContract.sol` | 普通 EVM source request 与真实 ERC20 escrow source request |
| `contracts/AvalancheWarpSourceContract.sol` | 调 Avalanche Warp Messenger precompile 发 source message，继承相同 lifecycle/escrow |
| `contracts/ResponseLifecycleBase.sol` | watcher 授权、Pending/Challenged/Completed/Compensated、真实 refund/settle 和 lifecycle checkpoint |
| `contracts/HXMsgGateway.sol` | minimal compact 单笔/批次入口、TEE cert、batch root、防重放和 Target 调用 |
| `contracts/TargetContract.sol` | gateway-only `CompactCall` dispatch、asset batch 快路径、业务记录和 execution events |
| `contracts/BusinessServiceContracts.sol` | 资产、应收账款、物流、医疗授权、预言机、审批六类真实服务合约 |
| `contracts/CrossChainToken.sol` | 本地实验 XCST token，真实 transfer/approve/transferFrom/mint/burn；不是生产审计版 ERC20 |

不存在活跃 `EIP2537BLSVerifier.sol` 源码。若 `artifacts/` 中看到同名 JSON，那是历史生成物，不能恢复 TEE BLS 路径。

### 17.8 `scripts/`：部署、基础设施和实验驱动

| 文件 | 作用 |
|---|---|
| `scripts/deploy.js` | 部署本地 Hardhat 或 Sepolia 的 registry/source/gateway/target/services/token，注册两个 EVM 相关 TEE clusters，注入 reserve，写 deployment JSON |
| `scripts/deploy-avalanche-local.js` | 部署 Avalanche C-Chain source/Warp source/registry/gateway/target/services/token，注册 clusters 和 reserve |
| `scripts/export-fabric-wallet.js` | 从 Fabric runtime MSP 导出 appUser wallet；输出含私钥，不得提交 |
| `scripts/generate-avalanche-pchain-trust-anchor.js` | 从 5 节点本地网络/genesis 构造并交叉检查 P-Chain validator anchor |
| `scripts/manage-chain-pair.js` | 三种链对唯一启动/停止管理器；停止全部后按 pair 启动两链、两个 TEE subnet 和一个 Automation |
| `scripts/register-sepolia-tee-subnets.js` | 把当前模拟/远程 TEE identity 注册到 Sepolia TEERegistry，输出注册结果 |
| `scripts/run-automation-evm-evm-e2e.js` | 通用 Ethereum/Sepolia -> Ethereum/Avalanche/Sepolia Automation E2E driver |
| `scripts/run-automation-avalanche-evm-e2e.js` | Avalanche Warp source -> EVM-compatible target E2E |
| `scripts/run-automation-evm-fabric-e2e.js` | Ethereum/Sepolia receipt source -> Fabric target E2E |
| `scripts/run-automation-fabric-evm-e2e.js` | Fabric h-FSV source -> EVM-compatible target E2E |
| `scripts/run-automation-ethereum-avalanche-oracle-e2e.js` | 非资产 `oracle_update` 普通消息，证明路径不限于转账 |
| `scripts/run-automation-ethereum-fabric-batch-experiments.js` | Ethereum/Fabric 双向，batch signing 与 batch transfer 四组实验 |
| `scripts/run-automation-ethereum-avalanche-batch-experiments.js` | Ethereum/Avalanche 双向四组 batch 实验 |
| `scripts/run-automation-fabric-avalanche-batch-experiments.js` | Fabric/Avalanche 双向四组 batch；包含真实 Warp/h-FSV |
| `scripts/run-automation-ethereum-avalanche-atomic-batch.js` | Ethereum/Avalanche 双向 RESPONSE + atomic batch |
| `scripts/run-automation-fabric-avalanche-atomic-batch.js` | 参数化 Fabric 与 Ethereum/Avalanche 的双向 RESPONSE + atomic batch |
| `scripts/run-automation-ethereum-avalanche-challenge-rollback.js` | Ethereum/Avalanche 双向 watcher challenge 和真实 rollback |
| `scripts/run-automation-fabric-evm-challenge-rollback.js` | 参数化 Fabric 与 Ethereum/Avalanche 的双向 challenge/rollback |
| `scripts/run-automation-watcher-escrow-e2e.js` | EVM source escrow 的 Watcher 自动 challenge/真实 refund 独立 E2E |
| `scripts/run-automation-store-tests.js` | Automation JSON store、cursor、reorg、lease、retry 单元/集成测试 |
| `scripts/run-challenge-response-tests.js` | Hardhat lifecycle 合约状态机专项套件，不声称经过 Automation |
| `scripts/run-lifecycle-checkpoint-tests.js` | TEE registration、watcher policy、checkpoint、escrow cleanup 合约专项套件 |
| `scripts/run-hxmsg-forgery-attack-tests.js` | 两方向构造字段自洽但与源链事实不一致的材料，断言 TEE 拒绝 |
| `scripts/run-raft-cluster-tests.js` | 五节点 Raft election、leader barrier、复制、故障和恢复专项套件 |
| `scripts/run-sepolia-sync-committee-check.js` | 真 Sync Committee light-client update/checkpoint 检查和状态保存 |
| `scripts/run-sepolia-four-direction-preflight.js` | 四方向账户、余额、部署、TEE、Raft、ABI、reserve、Sync Committee 前置检查 |
| `scripts/run-sepolia-four-direction-tests.js` | 一键准备 local Ethereum/Avalanche，串行执行四个 Sepolia 方向并汇总 |
| `scripts/run-sepolia-evm-fabric-test.js` | Sepolia -> Fabric 单方向 wrapper |
| `scripts/run-sepolia-fabric-evm-test.js` | Fabric -> Sepolia 单方向 wrapper |
| `scripts/run-avalanche-sepolia-warp-test.js` | Avalanche -> Sepolia Warp 单方向 wrapper |
| `scripts/run-sepolia-avalanche-warp-test.js` | Sepolia -> Avalanche 单方向 wrapper |

脚本可以准备交易和发布 content-addressed material，但不能跳过 scanner/Automation。判断一个脚本是否仍符合主路径，搜索它是否使用 `AutomationClient`/`/v1/materials`/workflow，而不是直接执行“TEE attest 后调用 gateway”。

### 17.9 Fabric 工程文件

| 文件 | 作用 |
|---|---|
| `fabric-chaincode/xcall/index.js` | 唯一 Fabric chaincode；源事件、h-FSV 查询、TEE registry、compact target、业务状态、资产 escrow、Watcher lifecycle 和 checkpoint 全在此实现 |
| `fabric-chaincode/xcall/package.json` | Chaincode npm 元数据与 `fabric-contract-api`/`fabric-shim` 依赖 |
| `fabric-chaincode/xcall/package-lock.json` | Chaincode 依赖锁 |
| `fabric-network/configtx.yaml` | 单 channel `mychannel`、OrdererMSP、Org1MSP 和 capability/profile 配置 |
| `fabric-network/crypto-config.yaml` | 本地 cryptogen 的 orderer/Org1/四 peer 拓扑 |
| `fabric-network/connection-org1.json` | 宿主进程访问 Fabric 的 localhost connection profile |
| `fabric-network/connection-org1.docker.json` | 容器内访问 Fabric service names 的 profile |
| `fabric-network/scripts/bootstrap.sh` | 生成 crypto、genesis/channel artifact 和 CA/runtime 目录的首次初始化脚本 |
| `fabric-network/scripts/create-channel.sh` | 创建 `mychannel` 并让四 peers 加入 |
| `fabric-network/scripts/deploy-chaincode.sh` | package/install/approve/commit chaincode，自动计算新 sequence |
| `fabric-network/wallet/README.md` | 在新主机恢复 appUser wallet 的说明 |
| `fabric-network/wallet/appUser.id` | 本地 appUser X.509 wallet，含私钥；当前被 Git 跟踪是风险，禁止展示/提交 |

`fabric-network/runtime/` 保存 crypto、genesis、channel artifact、peer/orderer ledger、chaincode packages 等生成物；它不在上述文件清单中，但当前本机网络依赖它。不要把它当源码推送，也不要在普通测试前删除。

### 17.10 测试源码与生成目录

| 路径 | 作用 |
|---|---|
| `test/avalanche-pchain-trust.test.js` | anchor canonicalization、validator hash、错误 network/set 拒绝 |
| `test/tee-subnet-cryptographic-isolation.test.js` | 在 Hardhat 上验证 cluster/source/domain 签名不能跨子网复用 |
| `test-cases/` | 当前有意为空；旧静态 JSON 用例已删除，活跃 driver 以参数生成任意 batch size |
| `test-data/` | 当前有意为空；旧 Fabric 固定测试数据已删除 |
| `artifacts/` | Hardhat 编译输出，可能含已删除源码的历史 artifact；可重新生成，不能作为活跃代码证据 |
| `cache/` | Hardhat cache，可重新生成 |
| `node_modules/` | 根依赖安装目录，可由 lockfile 恢复 |
| `fabric-chaincode/xcall/node_modules/` | Chaincode 依赖生成目录 |
| `logs/` | 日志生成目录，Git 忽略 |

### 17.11 `docs/` 文档可信度标签

| 文件 | 当前用途/可信度 |
|---|---|
| `docs/AI-PROJECT-HANDOFF.md` | 本手册；新 AI 首先阅读 |
| `docs/current-code-path-audit-2026-08-11.md` | 当前唯一业务路径与已删除旧入口的最近审计，强参考 |
| `docs/event-driven-relayer-watcher-refactor.md` | scanner/store/workers/relayer/watcher 重构记录，强参考 |
| `docs/persistent-automation-and-lifecycle-checkpoint.md` | 持久 Automation、开放 RESPONSE relay、checkpoint 代码细节，强参考 |
| `docs/automation-completion-requirements.md` | 当前完成度与生产化缺口，强参考 |
| `docs/hxmsg-structure-and-design.md` | canonical h-xmsg、minimal 和 envelope 的当前设计说明，强参考 |
| `docs/raft-tee-cluster-implementation.md` | 五节点 Raft、3/5 quorum 和故障测试说明，需结合当前 `server.js` |
| `docs/tee-verifier-subnet-design.md` | 三个 source proof subnet 与授权绑定设计，强参考 |
| `docs/avalanche-pchain-trust-anchor.md` | 最新 P-Chain anchor 威胁模型和实现，强参考 |
| `docs/evm-receipt-mpt-proof-and-header-window.md` | EVM receipt proof/header window 实现说明，强参考 |
| `docs/business-execution-logic.md` | 真实业务合约、资产动作和补偿语义，强参考 |
| `docs/hxmsg-challenge-response-design.md` | RESPONSE/challenge/compensation 状态机设计，结合当前代码使用 |
| `docs/gas-optimization-implementation.md` | compact/minimal/batch 优化的实现说明；数字需用最新 runtime 复验 |
| `docs/gas-optimization-analysis.md` | Gas 来源与阶段性方案；含历史测量，不是最新结果唯一来源 |
| `docs/all-directions-gas-optimization.md` | 三链六方向优化思路与实现记录；结合当前 target submitter 核对 |
| `docs/mercury-style-asset-batch-implementation.md` | 借鉴 Mercury 的 batch asset execution 说明，当前代码仍采用其核心思想 |
| `docs/mercury-batch-signing-optimization.md` | TEE 对 batch root 签名的设计背景；偏设计文档 |
| `docs/mercury-tee-upgrade.md` | 早期 Mercury TEE/Raft 迁移设计；历史背景，实际以当前代码为准 |
| `docs/tee-lightweight-verification.md` | TEE 有限 header/state 思路；设计背景 |
| `docs/avalanche-integration-plan.md` | Avalanche 接入总体设计；实际完成度以 P-Chain/Warp adapter 为准 |
| `docs/avalanche-fabric-alignment.md` | Avalanche/Fabric lifecycle 和真实动作对齐记录 |
| `docs/avalanche-local-deployment.md` | 早期部署说明，含已经不存在的 smoke 命令和“Warp 未完成”等过时表述；只作历史参考，不照抄执行 |

## 18. Mercury 复现工程边界

### 18.1 使用哪个副本

主仓库内 `mercury_reproduction/` 是旧快照；其若干相对路径仍假设自己位于同级目录，放在主仓库内部运行会解析到错误的嵌套路径。权威可运行副本是：

```text
/home/zex/projects/crosschain_experiment/mercury_reproduction
```

该目录是独立 Git 仓库，分支 `main`，远端 `git@github.com:ZexZao/mercury_reproduction.git`，核对时提交为 `330254c`。主项目内快照与独立仓库在 `.gitignore`、`tee/mercury-raft.js` 和 `tee/mercury-tee-server.js` 等处已有差异；不要从内嵌快照启动实验或反向覆盖独立仓库。

### 18.2 内嵌快照逐文件说明

| 文件 | 作用 |
|---|---|
| `mercury_reproduction/README.md` | Mercury baseline 的环境、部署和实验说明 |
| `mercury_reproduction/package.json` | 独立 baseline 依赖和命令 |
| `mercury_reproduction/package-lock.json` | 独立 baseline Node 依赖锁 |
| `mercury_reproduction/hardhat.config.js` | Mercury Sepolia/EVM 合约编译和网络 |
| `mercury_reproduction/docker-compose.yml` | `mercury-ablation` 五 TEE + EOS nodeos 容器组 |
| `mercury_reproduction/docs/mercury-ablation-design.md` | 消融实验设计、统计口径和与 h-xmsg 的边界 |
| `mercury_reproduction/contracts/MercuryVault.sol` | Sepolia 源 vault deposit/challenge/refund/checkpoint |
| `mercury_reproduction/contracts/MercuryTargetVault.sol` | EVM 目标 vault 处理批次完成 |
| `mercury_reproduction/contracts/MercuryTEERegistry.sol` | Mercury TEE operator/quorum registry |
| `mercury_reproduction/contracts/test/MockERC20.sol` | Mercury 合约测试 token |
| `mercury_reproduction/contracts/test/MockTEERegistry.sol` | Mercury 测试 registry |
| `mercury_reproduction/eos/contracts/mercuryvault/mercuryvault.cpp` | EOS vault action 的 C++ 实现 |
| `mercury_reproduction/eos/contracts/mercuryvault/mercuryvault.hpp` | EOS vault table/action 声明 |
| `mercury_reproduction/eos/contracts/mercuryvault/mercuryvault.abi` | 已生成的 EOS vault ABI |
| `mercury_reproduction/eos/contracts/mercuryvault/mercuryvault.wasm` | 已编译 EOS vault WASM；源码变化后必须重编 |
| `mercury_reproduction/eos/contracts/token/token.cpp` | EOS 测试 token action 实现 |
| `mercury_reproduction/eos/contracts/token/token.hpp` | EOS 测试 token 声明 |
| `mercury_reproduction/eos/contracts/token/token.abi` | 已生成的 EOS token ABI |
| `mercury_reproduction/eos/contracts/token/token.wasm` | 已编译 EOS token WASM；源码变化后必须重编 |
| `mercury_reproduction/scripts/bootstrap-eos.js` | 初始化 nodeos wallet/account/token/vault |
| `mercury_reproduction/scripts/build-eos-contracts.js` | 构建 EOS C++ 合约 |
| `mercury_reproduction/scripts/deploy-mercury-vaults.js` | 部署 EVM Mercury vault/registry/token |
| `mercury_reproduction/scripts/register-mercury-tees-sepolia.js` | 向 Sepolia baseline registry 注册 TEE |
| `mercury_reproduction/scripts/run-local-mercury-raft-smoke.js` | Mercury 五 TEE 本地 Raft 冒烟 |
| `mercury_reproduction/scripts/run-sepolia-eos-mercury-ablation.js` | Sepolia -> EOS deposit/proof/quorum/transfer/confirm/refund/checkpoint 实验 |
| `mercury_reproduction/shared/mercury-digest.js` | Mercury deposit/idSet/checkpoint digest |
| `mercury_reproduction/tee/mercury-raft.js` | baseline 的独立 Raft 实现 |
| `mercury_reproduction/tee/mercury-tee-server.js` | baseline TEE proof/quorum 服务 |
| `mercury_reproduction/test/mercury-protocol.test.js` | Mercury vault/registry/checkpoint 协议测试 |

Mercury baseline 的目标是论文消融对照，不采用 h-xmsg、三个 TEE subnet 或主项目 Automation。不要把 Mercury Vault/TEE 直接搬入主项目，也不要把主项目结果写成 Mercury 复现结果。

## 19. 已删除旧路径：绝对不要恢复

当前工作树中以下文件显示为 Git `D`。删除是有意的，因为它们绕过 Automation、使用旧 ABI、重复已完成阶段或与当前安全模型冲突：

### 19.1 旧业务/测试脚本

```text
fabric-network/scripts/invoke-xcall.sh
scripts/request-evm-fabric-call.js
scripts/run-asset-transfer-refund-tests.js
scripts/run-avalanche-local-source-smoke.js
scripts/run-avalanche-response-lifecycle-test.js
scripts/run-evm-fabric-challenge-e2e.js
scripts/run-fabric-evm-challenge-e2e.js
```

### 19.2 旧静态测试数据

```text
test-cases/asset-transfer-batch-cases.json
test-cases/no-response-no-challenge-cases.json
test-data/README.md
test-data/fabric-real-cases.json
```

测试现在按 batch size 程序化生成，且普通/无需 RESPONSE 只靠 policy 字段区分，不再维护特殊 JSON 路径。

### 19.3 已完成或冲突的历史文档

```text
docs/adapter-decoupling-phase1-plan.md
docs/gas-optimization-stage3-implementation.md
docs/hxmsg-project-refactor-plan.md
docs/paper-readiness-gaps.md
docs/project-improvement-review-2026-05-29.md
docs/security-gap-review-against-design-goals.md
docs/stage4-melv-ef-evm-to-fabric-implementation.md
```

不要用 `git restore` 恢复这些文件，也不要因 GitHub 当前 commit 仍显示它们就重新接入。当前工作树尚未提交的删除本身就是项目状态。

## 20. 三条源链的实际代码路径

### 20.1 Ethereum/Sepolia -> Fabric 或 EVM-compatible target

```text
EvmSourceContract CrossChainCall/escrow event
 -> EthereumEventScanner
 -> material(requestID/callDataHash)
 -> ethereum finality
    local: simulated header committee
    Sepolia: real Sync Committee finalized update
 -> ethereum/proof-builder: receipt trie proof + canonical h-xmsg
 -> Ethereum proof subnet 5 nodes
 -> evm-melv-adapter: local header state + receiptsRoot MPT + log field binding
 -> Raft commit + 3/5 ECDSA certificate
 -> Fabric ExecuteHXMsgCompact* 或 EVM HXMsgGateway compact entry
 -> real target action
```

关键安全点：攻击者即使同步篡改 h-xmsg、callData 和 hmsgDigest，也无法生成一份在可信 `receiptsRoot` 下包含篡改 event 的 MPT proof；TEE 从已证明 receipt log 重新提取 request/action/policy 字段并与 canonical h-xmsg 比较。

### 20.2 Fabric -> Ethereum/Avalanche/Sepolia

```text
Fabric EmitXCall/LockAssetXCall + committed event/state write
 -> FabricEventScanner
 -> fabric/proof-builder: view ref + policy + canonical h-xmsg
 -> Fabric proof subnet 5 nodes
 -> each TEE independently query-proposes QueryCrosschainEvent to peers
 -> verify identical payload + X.509/MSP endorsements + policy
 -> QSCC GetBlockByTxID + VALID code + expected rwset write
 -> Raft commit + 3/5 ECDSA certificate
 -> EVM-compatible HXMsgGateway compact entry
 -> real target action
```

这里不是“relayer 给一份 Fabric block，TEE 自己相信”。每个 TEE 主动获得 h-FSV view 和 block/QSCC 事实，验证 peer endorsement。当前实验只有一个 Org1MSP，安全结论必须限定在背书策略和组织信任假设内。

### 20.3 Avalanche -> Ethereum/Fabric/Sepolia

```text
AvalancheWarpSourceContract -> Warp Messenger message
 -> AvalancheEventScanner
 -> real Warp proof builder
 -> Avalanche proof subnet 5 nodes
 -> each TEE independently query its assigned P-Chain endpoint
 -> genesis-pinned validator set/height/network binding
 -> 67% stake-weighted Avalanche native BLS proof
 -> h-xmsg payload/source/target/policy binding
 -> Raft commit + 3/5 TEE ECDSA certificate
 -> EVM compact gateway 或 Fabric compact chaincode
 -> real target action
```

Warp 的 validator aggregate signature 先证明 Avalanche 源事实；TEE 的 ECDSA quorum 再证明五个隔离 verifier 对该事实达成 Raft 提交。两层证书目的不同。

## 21. 开发习惯和修改边界

### 21.1 每次实验的推荐记录流程

1. 记录 `git status --short`、当前 commit 和时间。
2. `pair:up` 只启动所需两链。
3. 按改动重新部署合约或 chaincode。
4. 重建唯一 Automation，并确认 `/health` 的 `enabledChains`。
5. 检查两个 TEE subnet 都为 5/5，存在 leader，Raft logs 对齐。
6. 运行正式 npm 入口，不直接运行拼凑的临时代码。
7. 检查 result JSON 的 workflow stages、realAction、余额/业务断言、gas、finalityWaitMs 和 pass。
8. 把精确命令、batch size、链高度、deployment 地址摘要和失败样本记入结果报告。
9. 实验后用 `pair:down` 停止，不用 `fabric:down` 破坏 ledger。

### 21.2 修改后的最小验证矩阵

| 改动区域 | 至少执行 |
|---|---|
| `shared/hxmsg` / builder | `npm test`、compile、三种链对至少一个双向 Automation E2E、forgery |
| Solidity / minimal ABI | compile、重新部署所有受影响 EVM-compatible 链、EVM target 两方向、Sepolia preflight ABI |
| Fabric chaincode | JS syntax、递增 sequence 部署、Fabric source 和 target 两方向 |
| TEE/Raft | `npm test`、`raft:test`、相关 source adapter E2E、subnet isolation |
| Automation store/scanner | `automation:test:store`、至少一个普通、一个 atomic、一个 challenge E2E |
| Sync Committee | `sepolia:sync-committee`、preflight、一个 Sepolia source 方向；允许真实 finality 等待 |
| Avalanche Warp/P-Chain | P-Chain unit tests、5-node local network、Avalanche source 两方向 |

### 21.3 加入新链时的扩展点

正常需要新增：Automation scanner/finality/proof-builder、TEE source adapter、h-xmsg source/target builder、target submitter/链上 verifier 或业务 gateway、部署与测试脚本、subnet route/registry 配置。已有链的 adapter 不应修改，除非协议公共接口发生版本升级。

新链证明必须回答：可信状态根/validator set 从哪里来、finality 语义是什么、transaction/event inclusion 如何证明、证明中的业务字段如何和 canonical h-xmsg 绑定、目标链如何验证 TEE cluster/domain、reorg 如何回滚 cursor。只新增 `chainType` 字符串和 RPC 查询不是接链。

### 21.4 常见误改

1. 把 `shared/hxmsg/delivery.js::toMinimalHXMsgV2` 当成最新 target ABI。
2. 从 `artifacts/EIP2537BLSVerifier` 恢复已经放弃的 TEE BLS。
3. 为“无需 RESPONSE”另写一条 relay 路径，而不是设置 `feedback.required=false`。
4. 用脚本直接调 TEE 和 gateway，绕过 scanner/cursor/workflow。
5. 把 Fabric gas 记为有 EVM gas，或因 gas=0 声称 Fabric 没成本。
6. 为 batch=16/32 写死专用函数，而不是使用环境变量和通用数组。
7. 在每次启动前删整个 `runtime/`，导致 trusted root、P-Chain anchor 和 Raft 状态丢失。
8. 同时启动三条本地链和 15 个 TEE，违反本机两两实验资源策略。
9. 创建第二个 Automation 共同写 JSON store，造成 cursor/task 竞争。
10. 把 Mercury baseline 的 Vault/checkpoint 直接混入 h-xmsg 主协议。

## 22. 已实现与仍未完成

### 22.1 已实现，不要重复造轮子

1. Canonical h-xmsg、envelope、minimal on-chain representation、feedback/atomicity 规范化与字段哈希绑定。
2. Ethereum receipt MPT proof；TEE 从已证明 receipt log 重新提取源事实。
3. Sepolia 真实 Sync Committee BLS/finality/execution branch/period update 和滚动 trust state。
4. Fabric h-FSV/Weaver-like peer endorsement + QSCC/block/rwset 验证，包含 RESPONSE view。
5. 本地真实五 validator AvalancheGo、真实 Warp weighted BLS、P-Chain genesis trust anchor。
6. 三个密码学隔离的五节点 source-proof TEE subnet，各自 Raft、3/5 ECDSA quorum 和 domain separation。
7. EVM 与 Fabric 链上 TEE registry、cluster membership、epoch、threshold；当前 quote 是模拟值。
8. 事件驱动 Automation：多链 scanner、persistent cursor、reorg、finality、proof、TEE、target、retry/lease/idempotency。
9. 普通与需要 RESPONSE 的消息共用主路径；开放 response relay；Watcher 自动 challenge 与真实 compensation。
10. EVM ERC20 reserve transfer、mint、source escrow/refund/settle；Fabric 资产扣款/退款；六类非资产真实业务状态。
11. TEE batch root 签名、目标批量真实转账、compact calldata/minimal h-xmsg Gas 优化。
12. Lifecycle checkpoint 的 digest、TEE quorum、EVM/Fabric 批量终态清理核心。
13. 三链两两双向普通、batch、atomic、challenge/rollback 实验脚本和结果保存。

### 22.2 论文原型仍需明确的边界

1. **真实 TDX 未接入。** quote、measurement、sealed key 仍模拟；已预留 provider/registration 接口，但不能声称完成硬件远程证明。
2. **真实 TDX 上的 Raft 持久化未生产化。** 当前 JSON state、HTTP peer 和 shared secret 适合实验；后续需 enclave sealed WAL、snapshot/log compaction、mTLS 和故障注入。
3. **Automation 仅单实例。** JSON store 有持久 cursor/lease，但多个进程需要事务数据库、fencing token、outbox 和 nonce 协调。
4. **Checkpoint 自动聚合/定时触发未完成。** 合约、TEE 和显式 API 已有；按数量/时间自动收集 terminal candidates 尚待实现。
5. **开放 RESPONSE relay 没有常驻通用 responder scanner。** 这不削弱安全性，任意 relayer 可提交候选且 TEE 验真；它是活性/运维完善项。
6. **Fabric 信任域较小。** 当前一个 Org1MSP、四 peers、单 orderer；论文需增加多组织实验和恶意/离线 endorsement 故障模型。
7. **本地 Ethereum header committee 是模拟。** Sepolia 使用真实 Sync Committee；未来自定义链的委员会治理/轮换仍需单独方案。
8. **Avalanche 实验为真实本地链，但不是公共 Avalanche 网络。** P-Chain anchor/validator rotation 的长期与 adversarial 实验仍要补。
9. **合约和服务未做生产审计。** `CrossChainToken` 是实验 token，owner/watcher/registry 治理是原型权限模型。
10. **性能规模仍需服务器实验。** 当前两两启动和 5-node subnet 可验证正确性；论文性能应在 TDX g9i.xlarge 等环境测吞吐、P50/P95/P99、节点增长、batch size、故障恢复和资源占用。

## 23. 故障定位速查

| 现象 | 优先检查 |
|---|---|
| `DISCOVERING`/`WAITING_MATERIAL` 很久 | scanner 是否发现源事件；material key 是否为同一 requestID/callDataHash；Automation 是否在 deployment 后重建 |
| `no reachable TEE node`/502 | 对应 subnet 容器是否启动；启动中的 Node 服务会短暂 502；检查 `/health` 和主机端口 |
| `current term barrier requires leader role` | leader 发生轮换；让 `automation/tee-client.js` 重试，检查 5 节点 term/log；不要固定请求某个旧 leader |
| `leader can only directly commit entries from its current term` | Raft current-term no-op barrier 未完成或状态残留不一致；先看 raft health/log，再跑 `raft:test`，不要绕过 barrier |
| `nonce too low` | 并发 Sepolia sender 共用账户；四方向应串行；等待 pending tx 或用独立本地实验账户，不能简单重复固定 nonce |
| `trusted block root mismatch` | `.env` root、state file、API period/endpoint 不一致；从上一个严格验证成功 root 衔接，禁止动态相信远端 |
| Sepolia finality timeout | 比较 source block 与 Beacon finalized execution height；40 分钟上限；记录 finality wait 并允许失败，不降安全级别 |
| TLS/socket reset | 公共 Beacon/RPC endpoint 短暂断开；使用有界重试和备用同协议 endpoint，不能切到不支持 light-client 的普通 RPC |
| Avalanche Warp event not found | Warp source contract/deployment 是否为当前网络；source tx 是否成功；scanner 地址是否在 Automation 启动时加载 |
| Avalanche estimateGas revert | Sepolia registry cluster/epoch/ABI/reserve 是否与当前 certificate/deployment 一致；检查 target contract revert，不盲目提高 gas |
| Fabric `ENDORSEMENT_POLICY_FAILURE` | chaincode sequence/package/四 peer install/approve 是否一致，wallet MSP 和 channel 是否匹配 |
| Fabric orphan containers 警告 | 动态/旧 chaincode 或另一 Compose service；先辨认是否当前 ledger 需要，不能用 `--remove-orphans` 无差别删除 |
| Gas 突然增大 | 是否误走动态旧 ABI、逐消息 target tx、逐消息 cert/proof、非 asset batch；同时确认真实动作没有被优化掉 |

## 24. 新 AI 会话的第一小时检查单

```bash
cd /home/zex/projects/crosschain_experiment/crosschain_experiment
pwd
git branch --show-current
git status --short
git log -1 --oneline
node --version
npm --version
docker version
docker compose version
```

然后按顺序：

1. 完整阅读本手册。
2. 阅读 `docs/current-code-path-audit-2026-08-11.md` 和 `docs/automation-completion-requirements.md`。
3. 用 `rg` 核对所改函数的所有调用者，尤其 minimal ABI、target submitter、chaincode selector。
4. 查看 `git status` 中的 `D` 文件，确认不会恢复。
5. 不打印 `.env` 或 wallet；只检查变量是否存在、派生地址和文件权限。
6. 根据任务选择唯一链对，先做小范围测试，再做 8 条 batch/atomic/challenge 回归。
7. 修改前说明会动哪些层；修改后报告部署、测试、结果文件、Gas 口径和未运行项。

如果目标只是分析或撰写论文，不要先动代码、清空 runtime 或启动全部容器。若目标是实现功能，完成标准是“源码 + 相应部署 + Automation 主路径真实动作 + 安全断言 + 保存结果”，不是只让某个函数返回 `true`。

## 25. 环境变量速查

环境变量的事实来源是 `automation/config.js`、`docker-compose.yml`、`tee-verifier/server.js` 和具体实验脚本。以下按职责分组；未设置时多数本地值有开发默认值，Sepolia secret 和 trusted root 没有安全默认值。

| 类别 | 变量 | 用途 |
|---|---|---|
| Automation 服务 | `AUTOMATION_PORT`、`AUTOMATION_URL` | 服务监听端口和客户端基址 |
| Automation 服务 | `AUTOMATION_ROLE` | `all`、`relayer` 或 `watcher` |
| Automation 服务 | `AUTOMATION_ENABLED_CHAINS` | 逗号分隔的 `ethereum,fabric,avalanche,sepolia` 子集 |
| Automation 服务 | `AUTOMATION_STORE_FILE` | JSON store 路径 |
| Automation 服务 | `AUTOMATION_API_KEY` | 可选 Bearer token；当前不是完整 RBAC |
| Automation 服务 | `AUTOMATION_HTTP_JSON_LIMIT` | API body limit，默认 20 MB |
| Automation 调度 | `AUTOMATION_POLL_MS`、`AUTOMATION_SCAN_POLL_MS`、`AUTOMATION_MATERIAL_POLL_MS`、`AUTOMATION_BATCH_POLL_MS` | worker/scanner/material/batch 轮询周期 |
| Automation 调度 | `AUTOMATION_LEASE_MS`、`AUTOMATION_RELAYER_MAX_ATTEMPTS`、`AUTOMATION_WATCH_MAX_ATTEMPTS` | lease 和 retry 上限 |
| Automation 客户端 | `AUTOMATION_CLIENT_TIMEOUT_MS`、`AUTOMATION_WORKFLOW_TIMEOUT_MS`、`AUTOMATION_PROGRESS_INTERVAL_MS` | HTTP、workflow 和进度输出超时 |
| 实验参数 | `AUTOMATION_BATCH_EXPERIMENT_SIZE` | 普通 batch signing/transfer 大小，默认 8 |
| 实验参数 | `AUTOMATION_ATOMIC_BATCH_SIZE` | RESPONSE/atomic batch 大小，默认 8 |
| 实验参数 | `AUTOMATION_EVM_SOURCE_PROFILE`、`AUTOMATION_EVM_TARGET_PROFILE` | 通用 EVM driver 的 source/target profile |
| 实验参数 | `AUTOMATION_FABRIC_EVM_PEER` | Fabric 参数化 atomic/challenge 脚本的另一链，`ethereum` 或 `avalanche` |
| 实验结果 | `AUTOMATION_EVM_EVM_RESULT_FILE`、`AUTOMATION_EVM_AVALANCHE_RESULT_FILE`、`AUTOMATION_EVM_FABRIC_RESULT_FILE`、`AUTOMATION_FABRIC_EVM_RESULT_FILE`、`AUTOMATION_AVALANCHE_EVM_RESULT_FILE` | 覆盖结果文件名；`EVM_AVALANCHE` 是通用 EVM 结果名的兼容 fallback |
| 本地 EVM | `EVM_RPC`、`EVM_CHAIN_ID`、`EVM_DEPLOYMENT_FILE`、`LOCAL_EVM_PRIVATE_KEY` | Hardhat profile |
| 部署 | `DEPLOYMENT_OUTPUT_FILE`、`INITIAL_ASSET_RESERVE_UNITS` | deployment 输出和目标 reserve 初始量 |
| Sepolia | `SEPOLIA_RPC_URL`、`SEPOLIA_PRIVATE_KEY`、`DEPLOYER_PRIVATE_KEY`、`SEPOLIA_CHAIN_ID`、`SEPOLIA_DEPLOYMENT_FILE` | execution/deployment |
| Sepolia Beacon | `SEPOLIA_BEACON_API_URL`、`SEPOLIA_LIGHT_CLIENT_BEACON_API_URL`、`SEPOLIA_TRUSTED_BLOCK_ROOT` | 共识层轻客户端输入 |
| Sepolia state | `SEPOLIA_SYNC_COMMITTEE_STATE_FILE`、`SEPOLIA_SYNC_COMMITTEE_PERSIST`、`SEPOLIA_UPDATE_ENV_TRUSTED_ROOT`、`SEPOLIA_ENV_FILE` | state/root 持久化 |
| Sepolia 安全 | `SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT`、`SEPOLIA_MAX_ANCESTOR_HEADERS`、`SEPOLIA_LIGHT_CLIENT_UPDATE_CHUNK_SIZE` | 引导策略、ancestry 和跨 period update 分块 |
| Sepolia 实验 | `SEPOLIA_FINALITY_TIMEOUT_MS`、`SEPOLIA_MIN_BALANCE_ETH`、`SEPOLIA_MIN_ASSET_RESERVE_UNITS`、`SEPOLIA_FOUR_DIRECTION_PREFLIGHT_ONLY` | 等待上限、余额/reserve 前置、仅 preflight |
| Avalanche | `AVALANCHE_RPC_URL`、`AVALANCHE_PRIVATE_KEY`、`AVALANCHE_DEPLOYMENT_FILE`、`AVALANCHE_NETWORK_ID` | C-Chain profile |
| Avalanche CLI | `AVALANCHE_CLI`、`AVALANCHE_NETWORK_RUN_DIR`、`AVALANCHE_GENESIS_FILE` | CLI 路径和本地网络目录/genesis |
| Avalanche P-Chain | `AVALANCHE_PCHAIN_RPC_URL`、`AVALANCHE_NODE_ENDPOINTS`、`AVALANCHE_PCHAIN_TRUST_ANCHOR_FILE`、`AVALANCHE_PCHAIN_MAX_HEIGHT_LAG`、`AVALANCHE_PCHAIN_RPC_TIMEOUT_MS` | validator set 独立查询和 anchor |
| Avalanche proxy | `AVALANCHE_PROXY_TARGET_HOST`、`AVALANCHE_PROXY_PORT` | 宿主节点转发 |
| Fabric | `FABRIC_CONNECTION_PROFILE`、`FABRIC_WALLET_PATH`、`FABRIC_IDENTITY`、`FABRIC_CHANNEL`、`FABRIC_CHAINCODE`、`FABRIC_AS_LOCALHOST`、`FABRIC_DOCKER_HOST` | Gateway/profile/wallet/channel 配置 |
| h-FSV | `HFSV_REQUIRED_ORGS`、`HFSV_POLICY_RULE`、`HFSV_POLICY_THRESHOLD`、`HFSV_SECURITY_DOMAIN`、`HFSV_QUERY_TIMEOUT_MS`、`FABRIC_MSP_ROOT_CERT_PATH`、`FABRIC_MSP_ROOT_HASHES_JSON` | endorsement/MSP policy |
| local MELV | `HEADER_COMMITTEE_ID`、`HEADER_COMMITTEE_SIGNERS`、`HEADER_COMMITTEE_PRIVATE_KEYS`、`HEADER_COMMITTEE_THRESHOLD` | 本地模拟 header committee |
| MELV | `MELV_FINALITY_MODE`、`MELV_REQUIRED_CONFIRMATIONS`、`MELV_HEADER_WINDOW_SIZE`、`MELV_HEADER_MAINTAINER`、`MELV_ALLOW_RPC_HEADER_SYNC` | EVM header/finality 策略；不能在 Sepolia 严格路径启用不可信 RPC 同步 |
| TEE identity | `TEE_NODE_ID`、`TEE_PRIVATE_KEY`、`TEE_SIGNER_INDEX`、`TEE_SUBNET_ID`、`TEE_SUBNET_PROFILE`、`TEE_CLUSTER_ID`、`TEE_CLUSTER_THRESHOLD`、`TEE_CLUSTER_PEERS` | 节点、子网和 cluster 身份 |
| TEE scope | `TEE_SUPPORTED_SOURCE_CHAINS`、`TEE_SUPPORTED_VERIFICATION_METHODS`、`TEE_EVM_RPC` | 限制节点可验证的源链/方法及 EVM endpoint |
| TEE attestation | `TEE_ATTESTATION_EPOCH`、`TEE_ATTESTATION_NOT_AFTER`、`TEE_ENCLAVE_MEASUREMENT` | 模拟/未来真实 attestation metadata |
| TEE state | `TEE_STATE_FILE`、`TEE_CHAIN_STATE_FILE`、`TEE_CONSENSUS_STATE_FILE` | signer、light-client 和 Raft 状态文件 |
| TEE Raft | `TEE_RAFT_SHARED_SECRET`、`TEE_RAFT_AUTH_REQUIRED`、`TEE_RAFT_TERM`、`TEE_RAFT_APPEND_MAX_BYTES`、`TEE_RAFT_VERIFICATION_LEASE_MS` | 内部认证、日志传输和长证明 lease |
| TEE HTTP | `TEE_HTTP_JSON_LIMIT`、`PORT` | TEE JSON body limit 和监听端口 |
| TEE client | `TEE_URL`、`TEE_URLS`、`HXMSG_TEE_TIMEOUT_MS`、`HXMSG_TEE_BATCH_TIMEOUT_MS` | 直连专项测试/注册 URL 与证明超时 |
| rollback 测试 | `ROLLBACK_FEEDBACK_DELAY_SECONDS`、`ROLLBACK_CHALLENGE_WINDOW_SECONDS` | challenge 实验短 deadline/window；不代表生产参数 |
| 其他 | `PROJECT_ROOT`、`HXMSG_CHAIN_PAIR` | 某些脚本/部署的路径和链对覆盖 |

不要把 Compose 中的 `local-*-dev-secret`、固定测试 signer key 或 Hardhat prefunded key 复制到公网部署。真实 TDX 环境应通过 secret manager/enclave provisioning 注入。

## 26. `package.json` 入口总表

| 类别 | npm scripts |
|---|---|
| 构建/基础测试 | `node`、`compile`、`test`、`test:node`、`test:hardhat` |
| EVM 部署 | `deploy`、`deploy:sepolia`、`deploy:avalanche`、`sepolia:register:tee-subnets` |
| 本地链管理 | `pair:up`、`pair:down`、`avalanche:up`、`avalanche:anchor`、`avalanche:status`、`avalanche:down` |
| Fabric 管理 | `fabric:up`、`fabric:channel`、`fabric:wallet`、`fabric:cc:deploy`、`fabric:down` |
| 服务调试 | `tee`、`automation`、`automation:up`、`automation:down` |
| 协议专项 | `raft:test`、`hxmsg:test:challenge`、`hxmsg:test:checkpoint`、`hxmsg:test:forgery`、`automation:test:store`、`avalanche:test:pchain-anchor` |
| 普通 E2E | `automation:test:ethereum-avalanche`、`automation:test:ethereum-avalanche:oracle`、`automation:test:avalanche-ethereum`、`automation:test:evm-fabric`、`automation:test:fabric-evm` |
| Batch E2E | `automation:test:batch:ethereum-fabric`、`automation:test:batch:ethereum-avalanche`、`automation:test:batch:fabric-avalanche` |
| Atomic batch | `automation:test:batch:ethereum-fabric:atomic`、`automation:test:batch:ethereum-avalanche:atomic`、`automation:test:batch:fabric-avalanche:atomic` |
| Challenge | `automation:test:challenge:ethereum-fabric`、`automation:test:challenge:ethereum-avalanche`、`automation:test:challenge:fabric-avalanche`、`automation:test:watcher-escrow` |
| Sepolia | `sepolia:sync-committee`、`sepolia:test:four-directions:preflight`、`sepolia:test:four-directions`、`sepolia:test:evm-fabric`、`sepolia:test:fabric-evm`、`sepolia:test:avalanche-sepolia`、`sepolia:test:sepolia-avalanche` |

`npm run tee` 和 `npm run automation` 是宿主进程调试入口，正常两链实验使用 Compose。`fabric:down` 带 `-v`，再次提醒它不是普通停机。

## 27. 当前未提交工作树快照

HEAD `74278d3` 之后的重要改造尚未形成新 commit。除第 19 节的删除外，以下未跟踪文件也是当前实现的一部分，不能因“Git 没跟踪”而丢弃：

```text
docs/AI-PROJECT-HANDOFF.md
docs/avalanche-pchain-trust-anchor.md
docs/current-code-path-audit-2026-08-11.md
scripts/generate-avalanche-pchain-trust-anchor.js
scripts/register-sepolia-tee-subnets.js
scripts/run-automation-fabric-evm-challenge-rollback.js
shared/avalanche/pchain-trust.js
shared/tee/domains.js
test/avalanche-pchain-trust.test.js
test/tee-subnet-cryptographic-isolation.test.js
```

大量 Automation、合约、chaincode、builder、TEE 和实验脚本也处于已修改未提交状态。新 AI 必须基于当前工作树继续，而不是以远端 GitHub 或 HEAD 重新克隆内容覆盖。提交前还必须单独处理 `fabric-network/wallet/appUser.id` 的秘密泄露风险，不能把它与功能改动一起盲目 `git add -A`。
