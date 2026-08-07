# Crosschain h-xmsg Trusted Transport Prototype

本项目是一个面向异构区块链消息互通的可信跨链原型。当前接入 Ethereum、Hyperledger Fabric 和 Avalanche，支持三组链对的六个有向方向：

- Fabric -> EVM：参考 Fabric Cacti Weaver 的 Fabric View 思路，用 h-FSV view 证明 Fabric 链上跨链事件真实存在。
- EVM -> Fabric：参考 Mercury 的 TEE 轻客户端思路，由 TEE 维护有限 EVM header window，并用 receipt MPT proof 证明 EVM 交易和事件真实存在。
- Avalanche -> EVM/Fabric：验证真实 Avalanche Warp message、5 validator 权重签名和 P-Chain validator set，再由 Avalanche TEE 子网签发批次证书。
- EVM/Fabric -> Avalanche：分别复用 EVM light-client proof 与 Fabric h-FSV，目标 Avalanche C-Chain 通过部署时绑定为 `ChainType.AVALANCHE` 的 gateway 执行。

项目的核心不是简单转发消息，而是让目标链只接受经过 TEE quorum 证明的 `h-xmsg`。普通跨链消息和需要 RESPONSE 的跨链消息共用同一套构造、验证和投递路径，差异只由 `h-xmsg.feedback` 与 `h-xmsg.atomicity` 策略字段决定。

当前 TEE 仍是 Node.js 模拟实现，便于本地实验。代码结构已经按后续真实 TEE 部署预留：链适配器、h-xmsg builder、TEE quorum、目标链执行入口和挑战响应状态机彼此解耦。

## 当前实现程度

已实现：

| 能力 | 状态 |
|---|---|
| h-xmsg 通用消息结构 | 已实现，`shared/hxmsg/` |
| Fabric -> EVM | 已实现，h-FSV view + TEE quorum + EVM gateway |
| EVM -> Fabric | 已实现，receipt MPT proof + TEE header window + Fabric chaincode；本地默认使用模拟 committee header，Sepolia 模式支持真实 Ethereum sync committee / finalized header 验证 |
| Avalanche 双向互通 | 已实现真实本地 5 validator AvalancheGo、Warp 权重证明以及 EVM/Fabric 双向业务执行 |
| 多 TEE quorum | 已实现 5 个模拟 TEE 节点，默认 3/5 quorum；TEE 证书使用 Raft commit 后的 ECDSA quorum 签名集合 |
| Raft 风格复制 | 已实现 leader election、heartbeat、AppendEntries、commitIndex |
| 普通消息与 RESPONSE 消息统一入口 | 已实现，策略字段驱动分支 |
| 目标链业务执行 | 已实现，EVM compact/full 与 Fabric 目标侧均调用领域服务并写入可独立查询的真实业务状态 |
| 资产转账和退款 | 已实现实验闭环：Fabric escrow 锁定扣款、EVM ERC20 发放、成功 RESPONSE 最终结算锁仓、challenge timeout 自动退款 |
| 响应与原子性 | 已解耦：response-only 支持 Pending -> Completed；原子业务支持 Challenged / Compensated |
| Gas 优化 | 六个方向统一使用 compact delivery；EVM-compatible 目标链支持 TEE batch certificate 和 compact batch execution，完整 h-xmsg 由 TEE digest 绑定 |
| 自洽伪造攻击测试 | 已实现，覆盖 Fabric -> EVM 和 EVM -> Fabric 两个方向 |
| 测试结果落盘 | 已实现，输出到 `runtime/` |
| 常驻 Relayer / Watcher | 已实现，链上事件发现、持久 cursor、finality、证明构造、TEE attest、目标提交、challenge 和真实补偿由 `automation/` 串联 |
| RESPONSE relay | 开放中继；任意 relayer 可提交目标事实材料，TEE 验证后回源链，不设置固定 responder 单点 |
| 生命周期 Checkpoint | 已实现，EVM/Avalanche 与 Fabric 均由链上重算终态根、TEE quorum 认证后批量清理终态协议记录 |
| 压缩重放保护 | 已实现，按 `replayScope + sourceNonce` 使用 256-bit 位图记录；`nonceScope` 由 TEE 绑定到已证明的源合约或 Fabric channel+chaincode，不再为每条消息永久写一个布尔槽 |

当前仍保留的边界：

- TEE 是模拟服务，还没有部署到真实 TEE 服务器。
- 本地 Hardhat 回归测试仍使用模拟 EVM header committee；Sepolia 路径已接入真实 Beacon light-client 数据，TEE adapter 会验证 Ethereum sync committee 聚合签名、finality branch、execution payload branch，并把目标交易区块通过执行层 hash 链锚定到 finalized header。
- Fabric 网络当前是本地单组织多 peer 环境，策略按 `Org1MSP` 配置，接口保留多组织扩展。
- 常驻自动化服务已实现，但任务队列当前使用单进程持久 JSON；服务器多实例实验必须先替换为事务数据库，不能让多个进程同时写同一 JSON 文件。
- TEE quorum threshold 已由 EVM `TEERegistry` 和 Fabric 可信 cluster 配置推导，cert envelope 不能降低链上阈值。
- 项目自定义 TEE 签名已移除门限聚合签名路径，当前 TEE quorum 证书为 `ECDSA_QUORUM_V1`。代码中保留的 Ethereum 共识层签名验证库仅用于验证 sync committee 协议签名，不参与 TEE quorum。

## 整体架构

```text
Source Chain
  |
  | emits or stores source fact
  v
Automation scanner + persistent cursor
  |
  | waits finality and builds source proof
  v
h-xmsg builder
  |
  | builds chain-neutral canonical h-xmsg
  v
TEE cluster
  |
  | verifies source-chain fact with adapter
  | reaches quorum over the verified digest
  v
Target Chain gateway / chaincode
  |
  | verifies TEE quorum, replay, expiry, target binding
  v
Target application action
```

### Fabric -> EVM

```text
Fabric xcall chaincode
  |
  | EmitXCall writes crosschainEvents:{requestID}
  v
h-xmsg Fabric source builder
  |
  | sourceRef points to QueryCrosschainEvent(requestID)
  v
TEE fabric-hfsv-adapter
  |
  | queries Fabric peers for h-FSV view
  | verifies peer endorsements, MSP identity, policyHash
  | verifies Fabric block contains target tx and rwset write
  v
TEE quorum certification
  |
  | signs deliveryDigest bound to hmsgDigest with ECDSA quorum certificate
  v
EVM HXMsgGateway
  |
  | verifies minimal h-xmsg fields and TEE quorum
  v
TargetContract.execute(requestID, callData)
```

### EVM -> Fabric

```text
EvmSourceContract
  |
  | submitHXMsgRequest(..., policy)
  | emits CrossChainCallRequested(...)
  v
h-xmsg EVM source builder
  |
  | sourceRef points to EVM tx/block/log
  v
TEE evm-melv-adapter
  |
  | verifies committee-certified EVM header
  | verifies receipt MPT proof against local receiptsRoot
  | verifies CrossChainCallRequested log and policy binding
  v
TEE quorum certification
  |
  | signs hmsgDigest for Fabric execution with ECDSA quorum certificate
  v
Fabric xcall ExecuteHXMsg
  |
  | verifies TEE quorum and h-xmsg target binding
  v
Fabric inbound execution record
```

## h-xmsg 结构

`h-xmsg` 是链无关的跨链消息描述。它不直接把所有证明材料塞到目标链，而是把源链事实、目标执行、验证策略、反馈策略和原子性策略全部绑定进 `hmsgDigest`。

```text
HXMsg {
  header,
  source,
  target,
  sourceRef,
  targetAction,
  verification,
  payloadBinding,
  feedback,
  atomicity
}
```

| 模块 | 作用 |
|---|---|
| `header` | 协议版本、`requestID`、消息类型、nonce、创建时间、过期时间 |
| `source` | 源链类型、源链 ID、安全域 ID |
| `target` | 目标链类型、目标链 ID、安全域 ID |
| `sourceRef` | 源链事实定位信息，例如 Fabric view 或 EVM receipt/log |
| `targetAction` | 目标链执行对象、函数选择器、调用参数哈希、接收方 |
| `verification` | TEE 应使用的验证方法、最终性模型、策略引用和 adapterID |
| `payloadBinding` | 源链事实哈希、业务语义哈希、目标执行哈希 |
| `feedback` | 是否需要反馈、期望反馈类型、反馈超时、回调引用哈希 |
| `atomicity` | 是否需要挑战响应、commit/compensate 策略和挑战窗口 |

普通消息和需要 RESPONSE 的消息共用同一条路径：

| 消息类型 | `feedback` | `atomicity` | 后续状态 |
|---|---|---|---|
| 普通消息 | `required = false` | `required = false` | 目标链执行后结束 |
| 需要 RESPONSE 的消息 | `required = true, expectedMsgType = RESPONSE` | `required = true` | 目标执行后返回 `ResponseProof`，源链进入 `Completed` |

EVM 源链的 `CrossChainCallRequested` 事件会绑定 feedback 字段和 `atomicityHash`。Fabric 源链的 `QueryCrosschainEvent` view 也会返回 `feedback / feedbackHash / atomicity / atomicityHash`。TEE 会检查 h-xmsg 中的策略字段与源链事实一致，防止 relayer 在链下篡改消息语义。

## 目录结构

### 根目录

| 路径 | 作用 |
|---|---|
| `README.md` | 项目说明、架构、目录索引、流程和运行方式 |
| `package.json` | Node.js 依赖和 npm scripts |
| `package-lock.json` | npm 锁文件 |
| `hardhat.config.js` | Hardhat 本地 EVM 配置 |
| `docker-compose.yml` | EVM 节点和 5 个 TEE 模拟节点 |
| `docker-compose.fabric.yml` | Fabric CA、orderer、4 个 peer 和 fabric-tools；链码容器网络和启动超时已按本地实验环境配置 |
| `.gitignore` | Git 忽略规则 |

### `automation/`

常驻事件驱动控制面。`server.js` 启动 scanner 和 worker；`shared/store/automation-store.js` 持久化 event、cursor、material、workflow 和带租约任务；`shared/adapters/` 分别实现 Ethereum/Sepolia、Fabric、Avalanche 的扫描、finality 和证明构造；`relayer/` 负责目标提交，`watcher/` 负责 deadline、challenge 和补偿。旧手工 `/v1/jobs/relay` 已删除，Relay 只能由规范链事件与匹配的 source material 触发。

业务正文通过 `requestID` 或 `callDataHash` 内容键发布。Proof builder 和 TEE 会把正文重新绑定到源链事实，因此 material 提交者不属于信任根。完整结构和 API 见 `docs/persistent-automation-and-lifecycle-checkpoint.md`。

### `contracts/`

EVM 侧智能合约。

| 文件 | 作用 |
|---|---|
| `EvmSourceContract.sol` | EVM 源链请求合约；普通单向消息只发出可由 receipt proof 验证的事实事件，需要反馈/原子性的消息使用紧凑生命周期状态机 |
| `ResponseLifecycleBase.sol` | EVM 兼容源链共享的 RESPONSE、challenge、TEE certificate、token escrow 结算与真实退款实现 |
| `AvalancheWarpSourceContract.sol` | Avalanche Warp 源链入口；Warp payload 绑定 feedback、atomicity 和 validator policy，并复用共享生命周期 |
| `submitTokenEscrowHXMsgRequest` | `EvmSourceContract` 中的资产请求入口；真实锁定 ERC20，超时补偿时自动退款 |
| `executeAssetBatch` | `TargetContract` 的 Mercury-style 资产批量入口；一次网关调用执行多笔真实 mint 或 reserve transfer，不写重复通用业务记录 |
| `HXMsgGateway.sol` | EVM 目标链网关；验证 `HXMsgMinimal`、TEE quorum、目标绑定、防重放和过期时间；单消息 compact 使用强类型入口，批量消息使用 compact batch 入口 |
| `HXMsgLib.sol` | 链上 h-xmsg 压缩结构、delivery digest、response digest、atomicity hash |
| `TEERegistry.sol` | EVM 侧可信 TEE 地址注册表；验证 `ECDSA_QUORUM_V1` 证书中的 signer bitmap、注册状态和每个 TEE 的 ECDSA 签名 |
| `TargetContract.sol` | EVM 目标业务路由器；只接受 gateway 调用，解码业务 payload 并分发到分类服务合约 |
| `BusinessServiceContracts.sol` | EVM 分类业务服务；资产结算、应收账款、物流、授权、Oracle、多方审批 |
| `CrossChainToken.sol` | 实验 ERC20；资产类跨链消息可在目标 EVM 发放真实 token |

### `fabric-chaincode/`

Fabric 链码。

| 路径 | 作用 |
|---|---|
| `fabric-chaincode/xcall/index.js` | Fabric xcall 链码；发起/执行跨链请求、维护 response lifecycle、处理 RESPONSE/challenge/compensation，并执行真实 Fabric 业务状态变化 |
| `fabric-chaincode/xcall/package.json` | Fabric 链码 Node.js 依赖 |

关键链码接口：

| 接口 | 作用 |
|---|---|
| `EmitXCall` | Fabric 源链发起跨链请求，写入 `crosschainEvents:{requestID}` |
| `QueryCrosschainEvent` | h-FSV view 查询入口 |
| `ExecuteHXMsgCompact` | Fabric 目标链压缩执行入口；接收 minimal delivery、compact business call、业务 payload 和 TEE cert |
| `ExecuteHXMsg` | Fabric 目标链兼容执行入口；接收完整 EVM -> Fabric h-xmsg |
| `QueryBusinessRecord` | 按 `op / recordId` 查询目标链业务状态 |
| `QueryBusinessRecordByRequest` | 按 `requestID` 查询目标链业务状态 |
| `InitAssetBalance` | 初始化 Fabric 实验资产余额 |
| `LockAssetXCall` | Fabric 源链真实扣减余额并创建 escrow 后发起跨链请求 |
| `RefundAssetEscrow` | Fabric 源链真实退回 escrow 锁定资产 |
| `CompensateAfterChallenge` | challenge timeout 后按 commitment type 自动分发补偿；`TOKEN_ESCROW` 会触发 escrow refund |
| `ExecuteHXMsgCompact` | EVM -> Fabric 当前主线目标执行入口；验证 TEE quorum、minimal delivery、compact payload 后分发到资产、应收账款、物流、授权、Oracle、审批等业务服务 |
| `QueryAssetBalance` / `QueryAssetEscrow` | 查询 Fabric 资产余额和 escrow |
| `BindResponseLifecycleHXMsg` | Fabric 源链把需要反馈的请求生命周期与 TEE 证明过的 `hmsgDigest` 绑定 |
| `QueryResponseLifecycle` | 查询 response-only 或原子请求的统一生命周期 |
| `CompleteWithResponse` | 源链收到 TEE quorum RESPONSE 后完成请求；`TOKEN_ESCROW` 同时进入不可退款的 `Settled` 状态 |
| `StartChallenge` | feedback timeout 后进入 challenge |
| `CompensateAfterChallenge` | challenge 窗口结束仍无 RESPONSE 时执行补偿状态 |

### `fabric-network/`

本地 Fabric 网络配置和脚本。

| 路径 | 作用 |
|---|---|
| `configtx.yaml` | Fabric channel 和组织配置 |
| `crypto-config.yaml` | Fabric crypto material 生成配置 |
| `connection-org1.json` | 本机访问 Fabric 的 connection profile |
| `connection-org1.docker.json` | Docker 容器内访问 Fabric 的 connection profile |
| `scripts/bootstrap.sh` | Fabric 网络初始化辅助脚本 |
| `scripts/create-channel.sh` | 创建 channel |
| `scripts/deploy-chaincode.sh` | 打包、安装、审批并提交 xcall 链码 |
| `scripts/invoke-xcall.sh` | Fabric xcall 调用示例 |
| `wallet/README.md` | Fabric wallet 使用说明 |
| `wallet/appUser.id` | 本地 Fabric 身份文件，包含敏感私钥，不应提交到 GitHub |
| `runtime/` | Fabric 容器运行态数据、证书、账本和链码包，通常不作为源码阅读入口 |

### `hxmsg-builder/`

h-xmsg 构造层。该目录负责把不同源链事实和不同目标链动作组合成统一 h-xmsg。

| 文件或目录 | 作用 |
|---|---|
| `compose.js` | 通用 h-xmsg 组装器，统一计算 `hmsgDigest` |
| `fabric-to-evm.js` | Fabric -> EVM 兼容入口，组合 Fabric source builder 和 EVM target builder |
| `evm-to-fabric.js` | EVM -> Fabric 兼容入口，组合 EVM source builder 和 Fabric target builder |
| `response.js` | RESPONSE proof 构造、执行证明引用哈希 |
| `source-builders/fabric.js` | Fabric h-FSV 源链事实构造，生成 `sourceRef / sourcePayloadHash / policyRef` |
| `source-builders/evm.js` | EVM MELV-EF 源链事实构造，解析 EVM receipt/log，生成 `sourceRef / sourcePayloadHash / policyRef` |
| `target-builders/evm.js` | EVM contract call 目标动作构造 |
| `target-builders/fabric.js` | Fabric chaincode invoke 目标动作构造 |

### `shared/`

跨模块共享库。

| 路径 | 作用 |
|---|---|
| `shared/hxmsg/constants.js` | 链类型、消息类型、反馈类型、验证方法等枚举 |
| `shared/hxmsg/codec.js` | 稳定 JSON 编码、sourceRef 编码和 PEM 规范化 |
| `shared/hxmsg/hash.js` | `hmsgDigest`、feedback hash、atomicity hash、delivery digest、response digest |
| `shared/hxmsg/fabric-hfsv-policy.js` | Fabric h-FSV 默认策略构造 |
| `shared/hxmsg/evm-melv-policy.js` | EVM MELV-EF 默认最终性策略构造 |
| `shared/hxmsg/index.js` | h-xmsg 共享库统一导出 |
| `shared/evm/receipt-proof.js` | EVM receipt MPT proof 构造和验证 |
| `shared/evm/header-committee.js` | 模拟 Header Committee 的 header update 构造和验证 |
| `shared/evm/sync-committee-light-client.js` | Sepolia/Ethereum sync committee light-client 验证；验证 bootstrap、finality branch、execution branch 和 sync committee 聚合签名 |
| `shared/env.js` | 轻量 `.env` 加载器，用于脚本和 Hardhat 配置读取本地 Sepolia 参数 |
| `shared/xmsg.js` | 业务 payload ABI 编码与规范化 |
| `shared/utils.js` | runtime 目录和 JSON 写入辅助函数 |

### `tee-verifier/`

TEE 模拟服务和链适配器。实际部署到 TEE 服务器时，主要迁移和加固这个目录。

| 路径 | 作用 |
|---|---|
| `server.js` | TEE HTTP 服务、Raft 风格共识、`/attest`、`/attest-response`、`/raft/status` |
| `adapters/index.js` | 按 h-xmsg verification method 分发链适配器 |
| `adapters/fabric-hfsv-adapter.js` | Fabric h-FSV 验证：peer view、endorsement、MSP、block、tx、rwset、策略绑定 |
| `adapters/evm-melv-adapter.js` | EVM MELV-EF 验证：sync-committee 或 committee header、header window、receipt MPT proof、log、策略绑定 |
| `adapters/fabric-block.js` | Fabric protobuf block / tx / rwset 解码和验证 |
| `shared/tee/quorum-certificate.js` | TEE quorum 证书封装；生成 `ECDSA_QUORUM_V1` 签名集合、signer bitmap 和 selected signer hash |
| `msp-certs/` | 本地实验用 MSP 根证书和 orderer 证书 |

### `scripts/`

部署、测试和实验脚本。

| 文件 | 作用 |
|---|---|
| `deploy.js` | 部署 EVM 合约并写入 `runtime/deployment.json` |
| `request-evm-fabric-call.js` | 通过统一 `submitHXMsgRequest(..., policy)` 发起 EVM -> Fabric 请求 |
| `run-automation-fabric-evm-e2e.js` | 经 scanner、Relayer、TEE 与 Watcher 策略登记完成 Fabric -> EVM 测试 |
| `run-automation-evm-fabric-e2e.js` | 经 scanner、finality、proof、Relayer、TEE 与 Watcher 策略登记完成 EVM -> Fabric 测试 |
| `run-automation-ethereum-fabric-batch-experiments.js` | 双向 TEE 批签名与真实批量转账实验；禁止绕过 automation |
| `run-automation-ethereum-avalanche-batch-experiments.js` | Ethereum/Avalanche 双向 TEE 批签名与真实 Token 批量转账实验；强制使用 `executeAssetBatch`，禁用高 gas 通用业务批实验 |
| `run-sepolia-sync-committee-check.js` | Sepolia 真实 sync committee/finality 验证检查，不发交易 |
| `run-challenge-response-tests.js` | EVM 源链挑战响应状态机单元测试 |
| `run-lifecycle-checkpoint-tests.js` | watcher 授权、真实退款终态和 checkpoint 批量清理测试 |
| `run-fabric-evm-challenge-e2e.js` | Fabric -> EVM RESPONSE 端到端闭环 |
| `run-evm-fabric-challenge-e2e.js` | EVM -> Fabric RESPONSE 端到端闭环 |
| `run-asset-transfer-refund-tests.js` | 真实资产锁定、跨链 mint 和超时退款测试 |
| `run-hxmsg-forgery-attack-tests.js` | 自洽伪造攻击测试；攻击者同时篡改 h-xmsg、hmsgDigest 和链下传输材料，验证 TEE 是否会被源链事实证明拦下 |
| `run-raft-cluster-tests.js` | TEE Raft 集群主路径测试 |
| `run-automation-evm-evm-e2e.js` | 可配置 EVM 源链与目标链的事件驱动自动转账闭环，覆盖本地 Ethereum、Sepolia 与 Avalanche C-Chain 目标 |
| `run-sepolia-four-direction-tests.js` | 经 Automation 串行执行 Ethereum/Avalanche 与 Sepolia 的四方向实验，分别核验 Relayer、Watcher、真实转账、gas 和 finality 时间 |
| `run-automation-evm-fabric-e2e.js` | 事件驱动 Ethereum -> Fabric receipt proof 与真实入账闭环 |
| `run-automation-fabric-evm-e2e.js` | 事件驱动 Fabric -> Ethereum h-FSV 与真实转账闭环 |
| `run-automation-watcher-escrow-e2e.js` | Watcher 自动 challenge 和 EVM token escrow 真实退款闭环 |
| `export-fabric-wallet.js` | 导出 Fabric wallet 身份 |

### `test-data/`

测试用例数据。

| 文件 | 作用 |
|---|---|
| `fabric-real-cases.json` | 当前 8 条 Fabric -> EVM 主线测试用例 |
| `README.md` | 测试数据说明 |

### `docs/`

设计文档和阶段性说明。

| 文件 | 主题 |
|---|---|
| `hxmsg-project-refactor-plan.md` | 项目重构总体方案 |
| `stage4-melv-ef-evm-to-fabric-implementation.md` | 第四阶段 EVM -> Fabric 实现说明 |
| `hxmsg-challenge-response-design.md` | 挑战响应和通用原子性设计 |
| `avalanche-fabric-alignment.md` | Avalanche/Fabric 统一消息语义、生命周期与两两启动说明 |
| `adapter-decoupling-phase1-plan.md` | adapter 解耦第一阶段方案 |
| `tee-lightweight-verification.md` | TEE 轻客户端式验证说明 |
| `evm-receipt-mpt-proof-and-header-window.md` | EVM receipt MPT proof 与 header window |
| `mercury-tee-upgrade.md` | Mercury 风格 TEE 升级说明 |
| `mercury-batch-signing-optimization.md` | 批量签名优化方案 |
| `mercury-style-asset-batch-implementation.md` | Mercury-style 真实资产批量转账实现、安全边界和 gas 对比 |
| `raft-tee-cluster-implementation.md` | Raft TEE 集群实现说明 |
| `gas-optimization-analysis.md` | gas 开销分析 |
| `gas-optimization-stage3-implementation.md` | gas 优化第三阶段实现说明 |
| `security-gap-review-against-design-goals.md` | 对设计初衷的安全差距审查 |
| `paper-readiness-gaps.md` | 论文发表视角下的不足 |
| `project-improvement-review-2026-05-29.md` | 按设计初衷梳理当前实现和后续改进项 |
| `business-execution-logic.md` | 目标链真实业务执行逻辑说明 |
| `persistent-automation-and-lifecycle-checkpoint.md` | 事件驱动 Relayer/Watcher、持久游标、开放 RESPONSE 与 checkpoint 边界 |
| `event-driven-relayer-watcher-refactor.md` | 多链监听、状态机重构、旧路径清理和验证结果 |
| `automation-completion-requirements.md` | Automation 当前完成度和剩余生产化工作 |

### `runtime/`

运行时输出目录。这里存放部署结果、测试结果、TEE 状态、临时 payload、proof artifact 等。

常用文件：

| 文件 | 作用 |
|---|---|
| `deployment.json` | 当前本地 EVM 合约地址 |
| `hxmsg-fabric-evm-results.json` | Fabric -> EVM 主线测试 JSON 结果 |
| `hxmsg-test-summary.md` | Fabric -> EVM 主线测试 Markdown 汇总 |
| `hxmsg-evm-fabric-results.json` | EVM -> Fabric 主线测试 JSON 结果 |
| `hxmsg-evm-fabric-summary.md` | EVM -> Fabric 主线测试 Markdown 汇总 |
| `hxmsg-challenge-response-results.json` | 挑战响应状态机测试结果 |
| `hxmsg-evm-fabric-challenge-e2e-results.json` | EVM -> Fabric RESPONSE 端到端结果 |
| `hxmsg-fabric-evm-challenge-e2e-results.json` | Fabric -> EVM RESPONSE 端到端结果 |
| `tee-chain-state-*.json` | TEE 本地链状态，包括 EVM header window |
| `tee-consensus-*.json` | TEE Raft 日志和 commit 状态 |
| `sepolia-sync-committee-result.json` | Sepolia sync committee light-client 验证 JSON 结果 |
| `sepolia-sync-committee-summary.md` | Sepolia sync committee light-client 验证 Markdown 摘要 |
| `automation-tasks.json` | 常驻自动化服务的持久任务状态 |
| `automation-evm-avalanche-e2e-result.json` | 事件驱动 Ethereum -> Avalanche 真实转账结果 |
| `automation-evm-fabric-e2e-result.json` | 事件驱动 Ethereum -> Fabric 真实入账结果 |
| `automation-fabric-evm-e2e-result.json` | 事件驱动 Fabric -> Ethereum h-FSV 真实转账结果 |
| `automation-watcher-escrow-e2e-result.json` | Watcher 自动 challenge 和真实退款结果 |
| `lifecycle-checkpoint-test-result.json` | watcher 授权和 checkpoint 清理测试结果 |

`runtime/` 是实验输出，不是核心源码。重新部署或重新测试后内容会变化。

## 一条跨链交易的具体流程

下面以两种方向分别说明。

### Fabric -> EVM 普通消息

1. 应用调用 Fabric 链码 `EmitXCall`。
2. `EmitXCall` 生成 `requestID`，写入 `crosschainEvents:{requestID}`。
3. 链码记录目标 EVM chainID、目标合约、函数选择器、`callDataHash`、业务 payload hash、feedback/atomicity 策略哈希。
4. Fabric scanner 从持久 block cursor 接收 `XCALL`，把事件与 cursor 原子写入 Automation store。
5. Source material 到齐后，Relayer 的 Fabric proof builder 调用 `hxmsg-builder/fabric-to-evm.js` 构造完整 h-xmsg。
6. h-xmsg 的 `sourceRef` 指向 Fabric h-FSV view，即 `QueryCrosschainEvent(requestID)`。
7. h-xmsg 的 `verification` 指定 `H_FSV` adapter 和 Fabric policy hash。
8. Relayer worker 把 h-xmsg 发送给当前 TEE Raft leader 的 `/attest`；leader 只在日志提交后形成 quorum certificate。
9. TEE Fabric adapter 根据 `sourceRef` 主动向 Fabric peers 查询 h-FSV view。
10. TEE 检查 peer 返回 payload 是否一致。
11. TEE 验证 peer endorsement 签名、MSP 证书归属和 h-FSV 策略。
12. TEE 通过 QSCC 获取包含该 txId 的 Fabric block。
13. TEE 解码 Fabric block，确认目标交易存在、交易状态 VALID、写集包含 `crosschainEvents:{requestID}`。
14. TEE 重新计算 `sourcePayloadHash / businessPayloadHash / targetExecutionHash / feedbackHash / atomicityHash`。
15. TEE 集群通过 Raft 风格复制提交该验证结果，形成 quorum certification。
16. Target submit worker 向 EVM 提交 `HXMsgMinimal`、强类型 `CompactCall` 和 TEE certificate；单消息场景使用 `executeHXMsgMinimalCompactCluster`。
17. `HXMsgGateway` 检查防重放、过期时间、目标链、目标合约、`callDataHash`、`targetExecutionHash` 和 TEE quorum。
18. 验证通过后，`HXMsgGateway` 调用 `TargetContract.execute(requestID, callData)`。
19. 目标合约解码 `op / recordId / actor / amount / metadata / requireAck`，写入 `businessRecords` 和业务索引。
20. 普通消息流程结束。

### EVM -> Fabric 普通消息

1. 应用调用 `EvmSourceContract.submitHXMsgRequest(..., policy)`。
2. 普通消息传入空策略：`feedback.required = false`、`atomicity.required = false`。
3. `EvmSourceContract` 生成 `requestID` 并发出 `CrossChainCallRequested` 事实事件。普通单向消息不重复写入请求状态；需要 response/challenge/compensation 的消息才记录紧凑 `Pending` 生命周期。
4. 事件中包含目标 Fabric chainID/domain、chaincode target、函数选择器、payload hash、feedback 字段和 `atomicityHash`。
5. Ethereum/Sepolia scanner 按持久 block cursor 发现事件，并记录区块 hash checkpoint；发生 reorg 时撤销 orphan event 的未完成任务。
6. Finality worker 在本地等待 header committee，在 Sepolia 等待真实 Beacon finalized checkpoint。
7. Proof worker 使用 `shared/evm/receipt-proof.js` 构造 receipt MPT proof；本地构造 committee header update，Sepolia 获取并验证真实 light-client update。
8. `hxmsg-builder/evm-to-fabric.js` 根据 receipt/log 和内容寻址业务材料构造完整 h-xmsg，并重新核对 payload hash。
9. Relayer worker 把 h-xmsg、receipt proof 和 header 证明发送到 TEE `/attest`。
10. TEE EVM adapter 验证 header 证明，并把认证 header 写入本地有限 header window。Sepolia 模式会验证 bootstrap current sync committee branch、finality branch、execution payload branch、Ethereum sync committee 聚合签名，并检查目标交易区块到 finalized execution header 的 parentHash 链。
11. TEE 使用本地可信 header 的 `receiptsRoot` 验证 receipt MPT proof。
12. TEE 检查 receipt/log 指向可信 `EvmSourceContract` 和 `CrossChainCallRequested` 事件。
13. TEE 检查事件参数、feedback 策略、`atomicityHash` 与 h-xmsg 完全一致。
14. TEE 重新计算 `sourcePayloadHash` 和 `targetExecutionHash`。
15. TEE 集群形成 quorum certification。
16. Target submit worker 调用 Fabric `ExecuteHXMsgCompact(delivery, compactCall, businessPayload, cert)`，不向目标链提交完整 h-xmsg。
17. Fabric 链码检查防重放、过期时间、目标 Fabric chainID、目标 chaincode、`callDataHash`、`targetExecutionHash`、compact payload 语义绑定和 TEE quorum。
18. Fabric 链码写入 `crosschainExec:{requestID}` 和 `inbound:{requestID}`。
19. Fabric 链码解码业务 payload，写入 `business:{op}:{recordId}` 和 `businessByRequest:{requestID}`。
20. 普通消息流程结束。

### 需要 RESPONSE 的消息

需要 RESPONSE 的消息不换路径，只换策略字段：

```text
feedback.required = true
feedback.expectedMsgType = RESPONSE
atomicity.required = true
atomicity.mode = COMMIT_OR_COMPENSATE
```

在目标链完成执行后，会增加 RESPONSE 闭环：

1. 目标链执行完成后产生目标执行事实。
2. 任意 relayer 可从目标链事实构造 `ResponseProof` 和对应证明材料；系统不依赖固定 responder。
3. 对 Fabric -> EVM，TEE 用 EVM receipt proof 验证目标 EVM 执行存在。
4. 对 EVM -> Fabric，TEE 用 Fabric View/执行记录证明目标 Fabric 执行存在。
5. TEE 检查 `requestID`、原始 `hmsgDigest`、目标执行哈希和 proof reference 绑定后，由 quorum 对 `responseDigest` 签名。
6. 源链调用 `CompleteWithResponse`。
7. 源链验证 RESPONSE 与原始请求绑定、目标执行哈希匹配、TEE quorum 有效。
8. 验证通过后，源链状态进入 `Completed`。

如果 feedback timeout 后仍没有 RESPONSE：

1. 已授权的常驻 watcher 调用 `StartChallenge(requestID)`；普通用户不能直接推进挑战状态。
2. 请求进入 `Challenged`，同时设置 `challengeDeadline`。
3. 在 challengeWindow 内，仍可提交有效 RESPONSE 并进入 `Completed`。
4. challengeWindow 结束仍无有效 RESPONSE 时，可调用 `CompensateAfterChallenge`。
5. 请求进入 `Compensated`。

## 运行方式

### 1. 安装依赖

```bash
npm install
```

### 2. 按链对启动实验环境

本地资源有限时，不需要同时启动三条链。以下命令会停掉第三条链和无关 TEE 子网，只保留两条实验链及各自的 5 节点证明子网；Fabric 数据卷不会被删除：

```bash
npm run pair:up -- evm-fabric
npm run pair:up -- evm-avalanche
npm run pair:up -- fabric-avalanche
npm run pair:down
```

切换链对后应重新部署对应的 EVM/Avalanche 合约或 Fabric chaincode，避免旧 Registry、nonce 和业务状态污染实验。实验脚本不应绕过该入口同时启动三条链。

### 3. 启动 Fabric

```bash
npm run fabric:up
npm run fabric:channel
npm run fabric:cc:deploy
```

### 4. 部署 EVM 合约

```bash
npm run compile
npm run deploy
```

### 5. 运行主线测试

事件驱动 Automation 闭环测试：

```bash
# evm-fabric 链对
npm run automation:test:evm-fabric
npm run automation:test:fabric-evm
npm run automation:test:watcher-escrow

# evm-avalanche 链对
npm run automation:test:evm-avalanche
```

这些脚本只发布 source material 和发出源链请求；事件发现、finality、proof、TEE 和目标提交由常驻 Automation 完成。下面的批量脚本是论文 benchmark driver，用于固定批大小、并发度和计时边界，不是另一套生产 Relay API。

Fabric -> EVM：

```bash
npm run automation:test:fabric-evm
```

EVM -> Fabric：

```bash
npm run automation:test:evm-fabric
```

Fabric -> Avalanche 与 Avalanche -> Fabric：

```bash
npm run automation:test:ethereum-avalanche
npm run automation:test:avalanche-ethereum
```

Ethereum <-> Avalanche 双向批处理：

```bash
npm run automation:test:ethereum-avalanche
```

Automation Relayer 使用同一套 adapter 主流程覆盖本地和 Sepolia：

| 模式 | header/finality 来源 | 源链发交易 |
|---|---|---|
| 本地默认 | 模拟 header committee | Hardhat 默认账户；由于 Hardhat automine 不支持同一账户排队 nonce，源链发交易默认串行 |
| Sepolia | 真实 Ethereum sync committee finalized header | `.env` 中的 `SEPOLIA_PRIVATE_KEY`；可限流并发发起多笔测试交易 |

并发参数：

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `HXMSG_CASE_TOTAL` | 64 | 自动生成的 EVM -> Fabric 主线测试用例总数；由 8 类既有业务操作重复扩展，不新增 op |
| `HXMSG_CASE_LIMIT` | 64 | 本轮实际运行的用例数量 |
| `HXMSG_SOURCE_CONCURRENCY` | 本地 1 / Sepolia 2 | 源链发交易并发度 |
| `HXMSG_PROOF_CONCURRENCY` | 本地 4 / Sepolia 2 | receipt proof 构造并发度 |
| `HXMSG_TEE_CONCURRENCY` | 1 | TEE attest 并发度；当前 Raft 主路径建议保守限流 |
| `HXMSG_FABRIC_CONCURRENCY` | 2 | Fabric 目标执行并发度 |
| `HXMSG_ALLOW_LOCAL_PARALLEL_SOURCE` | false | 是否允许本地 Hardhat 源链并发发交易；默认关闭 |
| `TEE_EVM_RPC` | 本地 `http://evm-node:8545` | 传给 TEE 容器使用的 EVM RPC |

Sepolia 模式下，脚本会等待目标源链交易进入 finalized execution block，再使用真实 sync committee 数据验证 finalized header，并用该 header 或其 parentHash 链覆盖目标交易区块的 receipt MPT proof 验证。这里的并发只影响实验调度，不代表 TEE 对交易进行批量签名。

Mercury-style TEE 批量签名当前覆盖六个有向方向。每个源链 adapter 仍逐条验证源链事实，批处理只聚合验证通过后的 delivery leaf：

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `HXMSG_TEE_BATCH_SIZE` | 8 | 每次提交给 TEE quorum 的 h-xmsg 数量 |

验证通过后，TEE 对这一批 h-xmsg 的 Merkle root、batchID、batchSize 和目标链 ID 形成一个 batch signing digest，并通过 5 节点 TEE quorum 形成一组 ECDSA quorum 签名。EVM 与 Avalanche C-Chain 使用 compact batch 入口，一次验证 TEE quorum 后逐条执行真实业务；Fabric 侧链码使用同一个 batch certificate，并通过每条消息的 Merkle proof 验证批次成员关系。

因此，TEE 批量签名优化的是目标链重复验证 TEE quorum 的成本。EVM -> Fabric 与 Avalanche -> Fabric 的目标链没有 gas 指标，批签名主要降低 Fabric 重复证书验证和传输成本；它不会降低源链请求交易本身的 gas。完整实测见 `docs/all-directions-gas-optimization.md`。

纯资产批次会自动进入 `TargetContract.executeAssetBatch`。其中 `asset_lock`、`mint_confirm`、`subsidy_confirm` 执行真实 mint；`token_transfer` 从目标链 `CrossChainAssetService` 的预置流动性储备向接收账户调用真实 ERC20 `transfer`，不再用 mint 近似转账。部署变量 `INITIAL_ASSET_RESERVE_UNITS` 控制实验储备，默认 `10000000000000` 个 token 基础单位。部署和储备初始化属于系统初始化成本，不计入 Mercury-style 每消息 gas。

本地双向资产批量测试：

```bash
npm run pair:up -- evm-avalanche
npm run deploy
npm run deploy:avalanche
npm run automation:test:ethereum-avalanche
```

测试会比较 reserve 与接收账户执行前后的 ERC20 余额；只有 reserve 等额减少且接收账户等额增加才判定通过。

Sepolia sync committee / finalized header 验证：

```bash
npm run sepolia:sync-committee
```

该命令不会发交易，只会读取 Sepolia execution finalized block、Beacon bootstrap、`LightClientUpdate` 和 `LightClientFinalityUpdate`，并在本地验证 current sync committee Merkle branch、跨 period 的 next sync committee 更新链、finality branch、execution payload branch、Ethereum sync committee 聚合签名和 2/3 参与阈值。验证通过后，它还会从已签名 finalized Beacon header 沿 `parent_root` 哈希链证明到该 finalized epoch 的可 bootstrap checkpoint；`runtime/sepolia-sync-committee-state.json` 和 `.env` 的 `SEPOLIA_TRUSTED_BLOCK_ROOT` 只写入这个 checkpoint root，不再误写普通 finalized head root。当前 Alchemy Sepolia execution RPC 继续用于普通 EVM 读写；Alchemy Beacon endpoint 不支持 `/eth/v1/beacon/light_client/*`，因此 `.env` 中的 `SEPOLIA_LIGHT_CLIENT_BEACON_API_URL` 默认使用支持 light-client API 的 PublicNode Sepolia Beacon endpoint。

`SEPOLIA_TRUSTED_BLOCK_ROOT` 是 TEE light client 的弱主观 bootstrap checkpoint：首次配置应由实验者从可信渠道确认，之后独立 Sync Committee 检查、Sepolia -> Fabric、Sepolia -> 本地 Ethereum/Avalanche 测试只会在完整验证后将其推进为最新可信 checkpoint。写回保持 `.env` 其他字段和文件权限不变。设置 `SEPOLIA_UPDATE_ENV_TRUSTED_ROOT=false` 可以关闭自动写回，用于需要固定 bootstrap 根的重复实验。代码默认要求该字段或 `runtime/sepolia-sync-committee-state.json` 存在；只有显式设置 `SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT=true` 时，脚本才会为了临时调试从 Beacon API 动态读取 finalized root。TEE 在验证 Sepolia 证明时不会信任 relayer 自带的任意 trusted root，而是使用自身 `chain-state` 中保存的 root 或 `.env` 中经过验证后轮换的 checkpoint，验证成功后再推进本地 trusted state。

Sepolia 与本地 Ethereum/Avalanche 四方向 Automation 实验：

```bash
npm run sepolia:test:four-directions:preflight
npm run sepolia:test:four-directions
```

完整命令会自动切换到 `evm-avalanche` 链对，启动本地 Ethereum、5 节点 Avalanche、两个 5 节点 TEE 子网和 Automation。每轮实验都会创建两个仅用于本轮本地链的部署账户并充值，然后重新部署真实合约；新源合约地址会形成新的防重放 scope，避免本地临时链重启、源 nonce 归零后与 Sepolia 网关保留的历史位图冲突。脚本只重置 `runtime/automation-tasks.json` 中的本轮实验任务，不删除 Sync Committee 信任状态或 Sepolia 链上状态。随后它以 `ethereum,avalanche,sepolia` 三个 profile 重建 Automation 容器，执行 preflight，并串行运行本地 Ethereum -> Sepolia、本地 Avalanche -> Sepolia、Sepolia -> 本地 Ethereum、Sepolia -> 本地 Avalanche。每个方向都必须经过持久 Scanner、Relayer、源链 finality、证明构造、TEE quorum、目标提交和 Watcher 策略检查。两个 Sepolia 源方向分别等待真实 Beacon finality，默认单方向上限为 40 分钟；最终结果写入 `runtime/sepolia-four-direction-automation-result.json`，其中 finality 等待时间与其他执行时间分开统计。

只验证完整命令的环境准备、部署、TEE、Automation 和 Sync Committee，而不发送四笔跨链交易：

```bash
SEPOLIA_FOUR_DIRECTION_PREFLIGHT_ONLY=true npm run sepolia:test:four-directions
```

Sepolia Ethereum -> Fabric 自动测试：

```bash
npm run sepolia:test:evm-fabric
```

该命令会临时把 `runtime/deployment.sepolia.json` 切换为当前部署文件，默认只跑 1 条 EVM -> Fabric 用例，等待 finality 的默认上限为 40 分钟，结束后自动恢复本地 `runtime/deployment.json`。可通过 `HXMSG_CASE_LIMIT`、`HXMSG_CASE_TOTAL`、`SEPOLIA_FINALITY_TIMEOUT_MS` 调整测试规模和等待时间。

Ethereum -> Fabric 的 Sepolia 实验需要等待 finality：源链交易先真实发送到 Sepolia，TEE 不能只相信最新区块或 RPC 返回值，而是要等该交易所在执行层区块被 Beacon finalized checkpoint 覆盖。之后脚本才会获取 `LightClientFinalityUpdate`、sync committee updates、execution header parentHash 链和 receipt MPT proof，并交给 TEE 验证。因此该方向的耗时通常由 finality 等待主导，可能需要十几分钟；若超过 `SEPOLIA_FINALITY_TIMEOUT_MS`，脚本会放弃本轮测试。

Sepolia Fabric -> Ethereum 测试：

```bash
set -a
. ./.env
set +a
cp runtime/deployment.sepolia.json runtime/deployment.json
EVM_RPC="$SEPOLIA_RPC_URL" \
DEPLOYER_PRIVATE_KEY="$SEPOLIA_PRIVATE_KEY" \
HXMSG_CASE_TOTAL=1 \
HXMSG_CASE_LIMIT=1 \
AUTOMATION_EVM_TARGET_PROFILE=sepolia \
npm run automation:test:fabric-evm
cp runtime/deployment.local-before-sepolia-run.json runtime/deployment.json
```

该方向的源链是本地 Fabric，TEE 通过 h-FSV / Fabric View-like 证明验证 Fabric 事件存在性；目标链是 Sepolia，因此会真实提交 EVM 目标执行交易并消耗 Sepolia ETH。与 Ethereum -> Fabric 不同，Fabric -> Ethereum 不需要等待 Sepolia 源链 finality，因为 Sepolia 在该实验中是目标链；主要耗时来自 TEE quorum、TEE signer 注册和 Sepolia 目标链交易确认。

真实资产锁定、EVM token 发放和 Fabric 退款：

```bash
npm run hxmsg:test:asset
```

EVM 源链挑战响应状态机：

```bash
npm run hxmsg:test:challenge
```

两端 RESPONSE 端到端闭环：

```bash
npm run hxmsg:test:challenge:fabric-evm
npm run hxmsg:test:challenge:evm-fabric
```

自洽伪造攻击测试：

```bash
npm run hxmsg:test:forgery
```

该测试会各构造一条 EVM -> Fabric 和 Fabric -> EVM 的真实源链请求，然后把链下 h-xmsg、`hmsgDigest`、`callDataHash`、`businessPayloadHash`、`targetExecutionHash`、`sourcePayloadHash` 等字段整体改成“内部自洽”的伪造版本。例如真实金额为 `10.0000`，伪造材料改成 `100.0000`。测试预期不是目标链执行失败，而是 TEE 在源链事实验证阶段拒绝该材料：EVM -> Fabric 由 receipt MPT proof 中真实 log 绑定的 `callDataHash` 拦截，Fabric -> EVM 由 h-FSV view / Fabric rwset 中真实 source record 绑定的 `sourcePayloadHash` 拦截。

## 最近一次验证结果

最近一次本地验证已通过：

| 测试 | 结果 |
|---|---|
| `npm run compile` | PASS |
| `npm run raft:test` | 6/6 PASS |
| `npm run automation:test:batch:ethereum-fabric` | 双向四组 batch 实验 PASS |
| `npm run automation:test:batch:ethereum-avalanche` | 双向四组优化 batch 实验 PASS；每批 8 次真实转账、TEE quorum 3/3、单目标交易 |
| `npm run automation:test:evm-fabric` | PASS |
| `npm run hxmsg:test:asset` | 2/2 PASS |
| `npm run hxmsg:test:challenge` | 7/7 PASS |
| `npm run hxmsg:test:challenge:fabric-evm` | PASS |
| `npm run hxmsg:test:challenge:evm-fabric` | PASS |
| `npm run hxmsg:test:forgery` | 2/2 PASS |
| `npm run automation:test:evm-avalanche` | PASS，真实 ERC-20 transfer |
| `npm run automation:test:evm-fabric` | PASS，真实 Fabric XCST 入账 |
| `npm run automation:test:fabric-evm` | PASS，4 Peer h-FSV + 真实 ERC-20 transfer |
| `npm run automation:test:watcher-escrow` | PASS，自动 challenge + 真实 ERC-20 refund |

对应结果文件位于：

| 文件 | 内容 |
|---|---|
| `runtime/raft-cluster-test-results.json` | 5 TEE Raft 集群故障测试 |
| `runtime/raft-cluster-test-summary.md` | 5 TEE Raft 集群测试汇总 |
| `runtime/hxmsg-fabric-evm-results.json` | Fabric -> EVM 主线测试 |
| `runtime/hxmsg-test-summary.md` | Fabric -> EVM 汇总 |
| `runtime/hxmsg-evm-fabric-results.json` | EVM -> Fabric 主线测试 |
| `runtime/hxmsg-evm-fabric-summary.md` | EVM -> Fabric 汇总 |
| `runtime/real-asset-transfer-refund-results.json` | 真实资产锁定、发放和退款测试 |
| `runtime/real-asset-transfer-refund-summary.md` | 真实资产测试汇总 |
| `runtime/hxmsg-challenge-response-results.json` | 挑战响应状态机测试 |
| `runtime/hxmsg-challenge-response-summary.md` | 挑战响应状态机汇总 |
| `runtime/hxmsg-fabric-evm-challenge-e2e-results.json` | Fabric -> EVM RESPONSE 端到端 |
| `runtime/hxmsg-evm-fabric-challenge-e2e-results.json` | EVM -> Fabric RESPONSE 端到端 |
| `runtime/hxmsg-forgery-attack-results.json` | 自洽伪造攻击测试 JSON 结果 |
| `runtime/hxmsg-forgery-attack-summary.md` | 自洽伪造攻击测试 Markdown 汇总 |
| `runtime/local-evm-avalanche-asset-transfer-batch-results.json` | Ethereum/Avalanche 双向真实 reserve transfer、余额断言和 gas 结果 |
| `runtime/local-evm-avalanche-asset-transfer-batch-steady-results.json` | 同一部署稳态复测；排除首次接收账户零到非零写入和 TEE 注册影响 |
| `runtime/mercury-style-avax-evm-batch20-gas-optimized.json` | batch=20 的 Mercury-style 优化前后对比实验结果 |
| `runtime/automation-evm-avalanche-e2e-result.json` | 事件驱动 Ethereum -> Avalanche 结果 |
| `runtime/automation-evm-fabric-e2e-result.json` | 事件驱动 Ethereum -> Fabric 结果 |
| `runtime/automation-fabric-evm-e2e-result.json` | 事件驱动 Fabric -> Ethereum 结果 |
| `runtime/automation-watcher-escrow-e2e-result.json` | Watcher 自动挑战和真实退款结果 |

最近一次本地 Fabric -> EVM TEE 批签名主线测试结果：

| 指标 | 结果 |
|---|---|
| 运行模式 | `local-mock-committee` |
| 通过率 | 8/8 PASS |
| TEE 批大小 | `HXMSG_TEE_BATCH_SIZE=8` |
| TEE batch quorum | 3/3（5 节点，门限 3） |
| EVM batch tx gas | 3861604 |
| 平均 gas/message | 482701 |
| 结果文件 | `runtime/hxmsg-fabric-evm-results.json` |
| 汇总文件 | `runtime/hxmsg-test-summary.md` |

最近一次本地 EVM -> Fabric 主线回归测试结果：

| 指标 | 结果 |
|---|---|
| 运行模式 | `local-mock-committee` |
| 通过率 | 8/8 PASS |
| 并发配置 | source=1, proof=4, tee=1, fabric=2 |
| 总耗时 | 21841 ms |
| TEE quorum | 3/3 |
| EVM source tx gas | 总计 332000，平均 41500/message |
| Fabric 目标提交压缩 | legacy avg=23.12 KiB，compact avg=10.55 KiB，减少 54.36% |
| Fabric 状态 | 每条均为 `executed` |
| 结果文件 | `runtime/hxmsg-evm-fabric-results.json` |
| 汇总文件 | `runtime/hxmsg-evm-fabric-summary.md` |

### Sepolia Ethereum -> Fabric 验证结果

最近一次 Sepolia Ethereum -> Fabric 端到端测试已通过。该测试不是本地 Hardhat 模拟：源链交易真实发送到 Sepolia，TEE 通过真实 Beacon light-client 数据验证 sync committee finality，并使用 receipt MPT proof 验证源链事件存在性，再由 5 个 TEE 模拟节点形成 3/5 quorum 后提交到 Fabric。

| 指标 | 结果 |
|---|---|
| 测试命令 | `npm run sepolia:test:evm-fabric`（要求 automation 启用 `sepolia,fabric`） |
| 测试结果 | 1/1 PASS |
| EVM tx | `0xccdcfde3d8b1ad3d5e9d20bcc2933905fc5d56c45f63577f10a750903ee4a3e1` |
| EVM gas | 292254 |
| Source tx 时间 | 25904 ms |
| Finality 等待时间 | 1098822 ms |
| Proof 构造时间 | 185258 ms |
| TEE quorum 时间 | 11285 ms |
| Fabric 执行时间 | 2119 ms |
| 总耗时 | 1337975 ms |
| TEE quorum | 5/3 |
| Fabric 状态 | `executed` |
| Sync committee period | 1274 |
| Committee update | 1273 -> 1274 |

结果文件：

| 文件 | 内容 |
|---|---|
| `runtime/hxmsg-evm-fabric-results.json` | 完整 JSON 结果，包含 tx、gas、finality、proof、TEE、Fabric 和业务执行记录 |
| `runtime/hxmsg-evm-fabric-summary.md` | Markdown 汇总表 |

### Sepolia Fabric -> Ethereum 验证结果

最近一次 Sepolia Fabric -> Ethereum 端到端测试已通过。该测试中 Fabric 作为源链，本地 Fabric 链码真实发出跨链事件；TEE 使用 h-FSV / Fabric View-like 证明验证该事件存在性和背书写集，再由 5 个 TEE 模拟节点形成 3/5 quorum；目标链交易真实提交到 Sepolia 的 `HXMsgGateway` 和目标业务合约。

| 指标 | 结果 |
|---|---|
| 测试命令 | `npm run sepolia:test:fabric-evm`（要求 automation 启用 `sepolia,fabric`） |
| 测试结果 | 1/1 PASS |
| Fabric 用例 | `FABRIC-001` |
| Fabric 区块 | 1617 |
| h-xmsg requestID | `0x637f3689207817b685340d9363441d8ad076f675b463b04dd230ebb48df1ec31` |
| Sepolia tx | `0x25a4c32e8b372006ebe2444a1b6e14abf06ada0f0cfab6edb33dd8d0fe220f3d` |
| Sepolia gas | 702017 |
| TEE 验证 | `fabric-hfsv` |
| TEE quorum | 5/3 |
| Fabric peer 背书 | 4 |
| MSP | `Org1MSP` |
| 目标执行 | `service-action` |

结果文件：

| 文件 | 内容 |
|---|---|
| `runtime/hxmsg-fabric-evm-results.json` | 完整 JSON 结果，包含 Fabric tx、h-FSV/TEE 验证、Sepolia tx、gas 和目标业务执行记录 |
| `runtime/hxmsg-test-summary.md` | Markdown 汇总表 |

## 安全设计要点

### Fabric -> EVM

- TEE 不只是查询 Fabric 区块再自己找交易。
- TEE 按 h-FSV view 方式向 Fabric peers 查询 `QueryCrosschainEvent(requestID)`。
- TEE 验证 peer endorsement、MSP 身份、策略、状态 payload 一致性。
- TEE 再用 Fabric block 验证具体交易存在、VALID 状态和写集。
- 目标 EVM 不直接验证 Fabric 复杂证明，而是验证 TEE quorum 和目标执行绑定。

### EVM -> Fabric

- TEE 不信任 relayer 随便给出的 RPC 返回值。
- relayer 提供 receipt MPT proof 和 header 证明。
- 本地回归测试中，TEE 只接受模拟 committee 认证过的 header。
- Sepolia 模式中，TEE 只接受真实 Ethereum sync committee/finality 认证过的 finalized header；若目标交易区块不是 checkpoint 区块，TEE 会验证从目标区块到 finalized header 的执行层 parentHash 链。
- TEE 用本地 header 的 `receiptsRoot` 验证 receipt MPT proof。
- TEE 检查 log、事件参数、feedback/atomicity 策略与 h-xmsg 绑定一致。

### 抵抗自洽伪造

攻击者可以修改所有经过自己之手的链下材料，使 h-xmsg 内部字段、`hmsgDigest`、`callDataHash` 和业务哈希彼此一致。但 TEE 的判断锚点不是链下材料本身，而是源链不可篡改事实：

- EVM -> Fabric：TEE 先用可信 header 的 `receiptsRoot` 验证 receipt MPT proof，再从 receipt log 中取出源链合约真实发出的 `CrossChainCallRequested` 事件。伪造材料即使内部自洽，只要与 log 中的 `callDataHash / businessPayloadHash / feedback / atomicityHash` 不一致，就会被拒绝。
- Fabric -> EVM：TEE 先验证 h-FSV view 的 peer endorsement、MSP、策略和 payload 一致性，再检查 Fabric block 中对应交易、VALID 状态和 rwset 写入。伪造材料即使重新计算了 `sourcePayloadHash`，只要与 Fabric 状态中的真实 source record 不一致，就会被拒绝。

对应回归命令为 `npm run hxmsg:test:forgery`，当前结果为 2/2 PASS。

### TEE quorum

- 当前默认 5 个 TEE 节点。
- 默认阈值为 3/5，对应 `2f+1=5`、`f+1=3` 的实验配置。
- TEE 节点通过 Raft 风格复制提交验证结果。
- 只有提交后的验证结果才会形成 certification。

### 原子性

- 项目不是只面向换币，也支持一般消息交换。
- 需要 RESPONSE 的消息通过 `feedback + atomicity` 开启挑战响应。
- 成功条件是 TEE quorum RESPONSE，而不是 HTLC preimage。
- 失败收束是 `timeout + challengeWindow + compensation`。

### 业务执行

- 目标链不再只是记录 request/hash。
- EVM 目标合约会写入 `businessRecords[requestID]`，并提供 `getBusinessRecord` / `getBusinessRecordByKey` 查询。
- EVM compact 路径会进一步写入 `compactReceivables`、`compactWaybills`、`compactConsents`、`compactLatestRound` 或 `compactDecisions`；测试必须读取领域服务状态，不能只检查通用成功哈希。
- EVM 目标合约会部署实验 ERC20 `CrossChainToken`；资产类 op 可真实 mint token 到目标地址。
- Fabric 目标链码会写入 `business:{op}:{recordId}` 和 `businessByRequest:{requestID}`。
- Fabric 源链码支持 `LockAssetXCall`，会真实扣减余额并写入 `assetEscrow:{requestID}`。
- Fabric `CompensateAfterChallenge` 会在 `TOKEN_ESCROW` 超时后自动分发到 escrow refund handler，真实把资产退回 owner。
- EVM `EvmSourceContract.submitTokenEscrowHXMsgRequest` 会真实锁定 ERC20，超时补偿时自动退回用户。
- 有效 RESPONSE 会把 EVM/Fabric 的 `TOKEN_ESCROW` 标记为 `Settled`，锁定资产继续作为目标链资产的源链支撑且不能再次退款。
- 当前业务执行覆盖 `asset_lock`、`mint_confirm`、`receivable_attest`、`logistics_sync`、`medical_consent`、`oracle_update`、`approval_commit`、`subsidy_confirm` 等测试用例。
- 当前 `TOKEN_ESCROW` 自动补偿和成功锁仓结算均已实现；Fabric 与 EVM 都会真实退款或最终锁定。授权撤销、Oracle 回滚等非资产补偿仍需先定义可逆资源和前状态，系统会拒绝不支持的 commitment，而不会只修改状态冒充补偿。

## 当前最重要的改进项

完整梳理见 `docs/project-improvement-review-2026-05-29.md`。当前优先级最高的改进是：

1. 真实 TEE remote attestation：当前 TEE key 只是模拟服务生成的签名 key，后续需要与 TEE measurement 绑定。
2. 正式 Header Committee：当前 EVM header update 由模拟委员会签名，后续需要 epoch、轮换、成员证明和 finalized checkpoint 来源。
3. 生产级 Raft 增强：当前实现已覆盖主路径，但还缺少 WAL、snapshot、log compaction、动态成员变更和复杂网络分区恢复测试。
4. 自动化服务高可用：当前 Relayer/Responder/Watcher 已常驻化，后续服务器实验可把单机任务存储替换为复制数据库并部署多个实例。
5. 多组织 Fabric 实验：当前网络是单组织 `Org1MSP`，后续需要验证多组织 endorsement policy 和 peer view 不一致拒绝路径。
6. TEE membership governance：当前 EVM 和 Fabric 已按已注册 TEE 成员数自动推导 `floor(n/2)+1` quorum，但成员注册仍由实验环境管理；后续需要和 TDX attestation、epoch、成员轮换委员会绑定。
7. 业务补偿扩展：当前 `TOKEN_ESCROW` 已实现真实退款，其他可补偿业务仍需要 escrow / unlock / custom executor。

## 后续扩展

接入新链时，建议新增三类代码，而不是修改旧链路径：

1. 新链 source builder：负责把新链源事实转换为 h-xmsg `sourceRef / sourcePayloadHash / verification`。
2. 新链 target builder：负责描述新链目标执行动作。
3. 新链 TEE adapter：负责在 TEE 内独立验证该链的源链事实证明。

旧链与新链交互时，应尽量只通过 h-xmsg 的 `source / target / verification / sourceRef / targetAction` 字段组合完成路由和验证，不改旧链 adapter 的安全逻辑。

## 注意事项

- `fabric-network/wallet/appUser.id` 包含 Fabric 私钥材料，不应提交到 GitHub。
- `runtime/` 和 `fabric-network/runtime/` 是运行态输出，可随测试和部署变化。
- 修改 EVM 合约后需要重新 `npm run deploy`。
- 修改 Fabric 链码后需要重新 `npm run fabric:cc:deploy`。
- 修改 TEE adapter 后需要重启 TEE 容器。
