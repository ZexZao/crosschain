# Crosschain h-xmsg Trusted Transport Prototype

本项目是一个面向异构区块链消息互通的可信跨链原型。当前支持两条主线：

- Fabric -> EVM：参考 Fabric Cacti Weaver 的 Fabric View 思路，用 h-FSV view 证明 Fabric 链上跨链事件真实存在。
- EVM -> Fabric：参考 Mercury 的 TEE 轻客户端思路，由 TEE 维护有限 EVM header window，并用 receipt MPT proof 证明 EVM 交易和事件真实存在。

项目的核心不是简单转发消息，而是让目标链只接受经过 TEE quorum 证明的 `h-xmsg`。普通跨链消息和需要 RESPONSE 的跨链消息共用同一套构造、验证和投递路径，差异只由 `h-xmsg.feedback` 与 `h-xmsg.atomicity` 策略字段决定。

当前 TEE 仍是 Node.js 模拟实现，便于本地实验。代码结构已经按后续真实 TEE 部署预留：链适配器、h-xmsg builder、TEE quorum、目标链执行入口和挑战响应状态机彼此解耦。

## 当前实现程度

已实现：

| 能力 | 状态 |
|---|---|
| h-xmsg 通用消息结构 | 已实现，`shared/hxmsg/` |
| Fabric -> EVM | 已实现，h-FSV view + TEE quorum + EVM gateway |
| EVM -> Fabric | 已实现，receipt MPT proof + TEE header window + Fabric chaincode；本地默认使用模拟 committee header，Sepolia 模式支持真实 Ethereum sync committee / finalized header 验证 |
| 多 TEE quorum | 已实现 5 个模拟 TEE 节点，默认 3/5 quorum |
| Raft 风格复制 | 已实现 leader election、heartbeat、AppendEntries、commitIndex |
| 普通消息与 RESPONSE 消息统一入口 | 已实现，策略字段驱动分支 |
| 目标链业务执行 | 已实现，EVM 和 Fabric 目标侧按业务类别执行真实动作 |
| 资产转账和退款 | 已实现实验闭环：Fabric escrow 锁定扣款、EVM ERC20 发放、Fabric challenge timeout 自动退款、EVM token escrow 自动退款 |
| 挑战响应 | 已实现基础闭环，支持 Completed / Challenged / Compensated |
| EVM gas 优化 | 已实现 `HXMsgMinimal` 目标链提交，完整 h-xmsg 由 TEE digest 绑定 |
| 测试结果落盘 | 已实现，输出到 `runtime/` |

当前仍保留的边界：

- TEE 是模拟服务，还没有部署到真实 TEE 服务器。
- 本地 Hardhat 回归测试仍使用模拟 EVM header committee；Sepolia 路径已接入真实 Beacon light-client 数据，TEE adapter 会验证 sync committee BLS 聚合签名、finality branch、execution payload branch，并把目标交易区块通过执行层 hash 链锚定到 finalized header。
- Fabric 网络当前是本地单组织多 peer 环境，策略按 `Org1MSP` 配置，接口保留多组织扩展。
- 常驻 watcher / responder 尚未实现，当前由测试脚本触发 RESPONSE、challenge 和 compensation。
- EVM 合约和 Fabric chaincode 当前仍从调用参数或 certification envelope 读取 quorum threshold；后续应改为从链上/链码可信 cluster 配置读取。

## 整体架构

```text
Source Chain
  |
  | emits or stores source fact
  v
h-xmsg builder
  |
  | builds chain-neutral h-xmsg
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
  | signs deliveryDigest bound to hmsgDigest
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
  | signs hmsgDigest for Fabric execution
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

### `contracts/`

EVM 侧智能合约。

| 文件 | 作用 |
|---|---|
| `EvmSourceContract.sol` | EVM 源链请求合约；统一入口 `submitHXMsgRequest(..., policy)`；维护请求状态机和挑战响应 |
| `submitTokenEscrowHXMsgRequest` | `EvmSourceContract` 中的资产请求入口；真实锁定 ERC20，超时补偿时自动退款 |
| `HXMsgGateway.sol` | EVM 目标链网关；验证 `HXMsgMinimal`、TEE quorum、目标绑定、防重放和过期时间 |
| `HXMsgLib.sol` | 链上 h-xmsg 压缩结构、delivery digest、response digest、atomicity hash |
| `TEERegistry.sol` | EVM 侧可信 TEE 地址注册表 |
| `TargetContract.sol` | EVM 目标业务路由器；只接受 gateway 调用，解码业务 payload 并分发到分类服务合约 |
| `BusinessServiceContracts.sol` | EVM 分类业务服务；资产结算、应收账款、物流、授权、Oracle、多方审批 |
| `CrossChainToken.sol` | 实验 ERC20；资产类跨链消息可在目标 EVM 发放真实 token |

### `fabric-chaincode/`

Fabric 链码。

| 路径 | 作用 |
|---|---|
| `fabric-chaincode/xcall/index.js` | Fabric xcall 链码；发起 Fabric -> EVM、执行 EVM -> Fabric、维护 commitment、处理 RESPONSE/challenge/compensation，并按业务类别执行真实 Fabric 状态变化 |
| `fabric-chaincode/xcall/package.json` | Fabric 链码 Node.js 依赖 |

关键链码接口：

| 接口 | 作用 |
|---|---|
| `EmitXCall` | Fabric 源链发起跨链请求，写入 `crosschainEvents:{requestID}` |
| `QueryCrosschainEvent` | h-FSV view 查询入口 |
| `ExecuteHXMsg` | Fabric 目标链执行 EVM -> Fabric h-xmsg |
| `QueryBusinessRecord` | 按 `op / recordId` 查询目标链业务状态 |
| `QueryBusinessRecordByRequest` | 按 `requestID` 查询目标链业务状态 |
| `InitAssetBalance` | 初始化 Fabric 实验资产余额 |
| `LockAssetXCall` | Fabric 源链真实扣减余额并创建 escrow 后发起跨链请求 |
| `RefundAssetEscrow` | Fabric 源链真实退回 escrow 锁定资产 |
| `CompensateAfterChallenge` | challenge timeout 后按 commitment type 自动分发补偿；`TOKEN_ESCROW` 会触发 escrow refund |
| `ExecuteHXMsg` | EVM -> Fabric 目标执行入口；验证 TEE quorum 后分发到资产、应收账款、物流、授权、Oracle、审批等业务服务 |
| `QueryAssetBalance` / `QueryAssetEscrow` | 查询 Fabric 资产余额和 escrow |
| `BindCommitmentHXMsg` | Fabric 源链把 atomic commitment 与 TEE 证明过的 `hmsgDigest` 绑定 |
| `CompleteWithResponse` | 源链收到 TEE quorum RESPONSE 后完成请求 |
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
| `shared/evm/sync-committee-light-client.js` | Sepolia/Ethereum sync committee light-client 验证；验证 bootstrap、finality branch、execution branch 和 BLS 聚合签名 |
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
| `core/certification.js` | TEE 对 h-xmsg、deliveryDigest、ResponseProof 的签名封装 |
| `msp-certs/` | 本地实验用 MSP 根证书和 orderer 证书 |

### `scripts/`

部署、测试和实验脚本。

| 文件 | 作用 |
|---|---|
| `deploy.js` | 部署 EVM 合约并写入 `runtime/deployment.json` |
| `request-evm-fabric-call.js` | 通过统一 `submitHXMsgRequest(..., policy)` 发起 EVM -> Fabric 请求 |
| `run-hxmsg-forward-tests.js` | 8 条 Fabric -> EVM 主线测试 |
| `run-evm-fabric-tests.js` | EVM -> Fabric 主线测试；统一支持本地 mock committee 与 Sepolia sync committee，并按阶段进行并发调度 |
| `run-sepolia-sync-committee-check.js` | Sepolia 真实 sync committee/finality 验证检查，不发交易 |
| `run-challenge-response-tests.js` | EVM 源链挑战响应状态机单元测试 |
| `run-fabric-evm-challenge-e2e.js` | Fabric -> EVM RESPONSE 端到端闭环 |
| `run-evm-fabric-challenge-e2e.js` | EVM -> Fabric RESPONSE 端到端闭环 |
| `run-asset-transfer-refund-tests.js` | 真实资产锁定、跨链 mint 和超时退款测试 |
| `run-raft-cluster-tests.js` | TEE Raft 集群主路径测试 |
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
| `adapter-decoupling-phase1-plan.md` | adapter 解耦第一阶段方案 |
| `tee-lightweight-verification.md` | TEE 轻客户端式验证说明 |
| `evm-receipt-mpt-proof-and-header-window.md` | EVM receipt MPT proof 与 header window |
| `mercury-tee-upgrade.md` | Mercury 风格 TEE 升级说明 |
| `mercury-batch-signing-optimization.md` | 批量签名优化方案 |
| `raft-tee-cluster-implementation.md` | Raft TEE 集群实现说明 |
| `gas-optimization-analysis.md` | gas 开销分析 |
| `gas-optimization-stage3-implementation.md` | gas 优化第三阶段实现说明 |
| `security-gap-review-against-design-goals.md` | 对设计初衷的安全差距审查 |
| `paper-readiness-gaps.md` | 论文发表视角下的不足 |
| `project-improvement-review-2026-05-29.md` | 按设计初衷梳理当前实现和后续改进项 |
| `business-execution-logic.md` | 目标链真实业务执行逻辑说明 |

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

`runtime/` 是实验输出，不是核心源码。重新部署或重新测试后内容会变化。

### 当前空目录

| 路径 | 状态 |
|---|---|
| `proof-builder/` | 当前为空，旧 proof builder 已不在主路径 |
| `relayer/` | 当前为空，后续常驻 watcher/router 可放这里 |
| `source-chain/` | 当前为空，旧 source-chain 实验代码已不在主路径 |

## 一条跨链交易的具体流程

下面以两种方向分别说明。

### Fabric -> EVM 普通消息

1. 应用调用 Fabric 链码 `EmitXCall`。
2. `EmitXCall` 生成 `requestID`，写入 `crosschainEvents:{requestID}`。
3. 链码记录目标 EVM chainID、目标合约、函数选择器、`callDataHash`、业务 payload hash、feedback/atomicity 策略哈希。
4. 测试脚本读取 Fabric 交易 ID、区块号和 `QueryCrosschainEvent(requestID)` 返回的源链状态。
5. `hxmsg-builder/fabric-to-evm.js` 构造完整 h-xmsg。
6. h-xmsg 的 `sourceRef` 指向 Fabric h-FSV view，即 `QueryCrosschainEvent(requestID)`。
7. h-xmsg 的 `verification` 指定 `H_FSV` adapter 和 Fabric policy hash。
8. relayer 把 h-xmsg 发送给任意 TEE 节点 `/attest`。
9. TEE Fabric adapter 根据 `sourceRef` 主动向 Fabric peers 查询 h-FSV view。
10. TEE 检查 peer 返回 payload 是否一致。
11. TEE 验证 peer endorsement 签名、MSP 证书归属和 h-FSV 策略。
12. TEE 通过 QSCC 获取包含该 txId 的 Fabric block。
13. TEE 解码 Fabric block，确认目标交易存在、交易状态 VALID、写集包含 `crosschainEvents:{requestID}`。
14. TEE 重新计算 `sourcePayloadHash / businessPayloadHash / targetExecutionHash / feedbackHash / atomicityHash`。
15. TEE 集群通过 Raft 风格复制提交该验证结果，形成 quorum certification。
16. EVM 侧提交 `HXMsgMinimal`、`callData` 和 TEE certifications 到 `HXMsgGateway.executeHXMsgMinimalCluster`。
17. `HXMsgGateway` 检查防重放、过期时间、目标链、目标合约、`callDataHash`、`targetExecutionHash` 和 TEE quorum。
18. 验证通过后，`HXMsgGateway` 调用 `TargetContract.execute(requestID, callData)`。
19. 目标合约解码 `op / recordId / actor / amount / metadata / requireAck`，写入 `businessRecords` 和业务索引。
20. 普通消息流程结束。

### EVM -> Fabric 普通消息

1. 应用调用 `EvmSourceContract.submitHXMsgRequest(..., policy)`。
2. 普通消息传入空策略：`feedback.required = false`、`atomicity.required = false`。
3. `EvmSourceContract` 生成 `requestID`，记录请求状态为 `Pending`，并发出 `CrossChainCallRequested` 事件。
4. 事件中包含目标 Fabric chainID/domain、chaincode target、函数选择器、payload hash、feedback 字段和 `atomicityHash`。
5. 测试脚本获取该交易 receipt、区块 header 和 log。
6. `shared/evm/receipt-proof.js` 构造 receipt MPT proof。
7. 本地回归由 `shared/evm/header-committee.js` 构造模拟 committee header update；Sepolia 模式由 `shared/evm/sync-committee-light-client.js` 获取并验证真实 Beacon light-client finality update。
8. `hxmsg-builder/evm-to-fabric.js` 根据 receipt/log 构造完整 h-xmsg。
9. relayer 把 h-xmsg、receipt proof 和 header 证明发送到 TEE `/attest`。
10. TEE EVM adapter 验证 header 证明，并把认证 header 写入本地有限 header window。Sepolia 模式会验证 bootstrap current sync committee branch、finality branch、execution payload branch、sync committee BLS 聚合签名，并检查目标交易区块到 finalized execution header 的 parentHash 链。
11. TEE 使用本地可信 header 的 `receiptsRoot` 验证 receipt MPT proof。
12. TEE 检查 receipt/log 指向可信 `EvmSourceContract` 和 `CrossChainCallRequested` 事件。
13. TEE 检查事件参数、feedback 策略、`atomicityHash` 与 h-xmsg 完全一致。
14. TEE 重新计算 `sourcePayloadHash` 和 `targetExecutionHash`。
15. TEE 集群形成 quorum certification。
16. Fabric 侧调用 `ExecuteHXMsg(hxmsg, callData, cert)`。
17. Fabric 链码检查防重放、过期时间、目标 Fabric chainID/domain、目标 chaincode、`callDataHash`、`targetExecutionHash` 和 TEE quorum。
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
2. 对 Fabric -> EVM，TEE 用 EVM receipt proof 证明目标 EVM 执行存在。
3. 对 EVM -> Fabric，TEE 用 Fabric 执行记录证明目标 Fabric 执行存在。
4. TEE 构造 `ResponseProof`，包含原始 `requestID`、原始 `hmsgDigest`、目标执行哈希、目标证明引用哈希、response payload hash。
5. TEE quorum 对 `responseDigest` 签名。
6. 源链调用 `CompleteWithResponse`。
7. 源链验证 RESPONSE 与原始请求绑定、目标执行哈希匹配、TEE quorum 有效。
8. 验证通过后，源链状态进入 `Completed`。

如果 feedback timeout 后仍没有 RESPONSE：

1. 任意角色可调用 `StartChallenge(requestID)`。
2. 请求进入 `Challenged`，同时设置 `challengeDeadline`。
3. 在 challengeWindow 内，仍可提交有效 RESPONSE 并进入 `Completed`。
4. challengeWindow 结束仍无有效 RESPONSE 时，可调用 `CompensateAfterChallenge`。
5. 请求进入 `Compensated`。

## 运行方式

### 1. 安装依赖

```bash
npm install
```

### 2. 启动 EVM 和 TEE

```bash
npm run evm:up
```

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

Fabric -> EVM：

```bash
npm run hxmsg:test:forward
```

EVM -> Fabric：

```bash
npm run hxmsg:test:evm-fabric
```

`run-evm-fabric-tests.js` 使用同一套主流程覆盖本地和 Sepolia：

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

Mercury-style TEE 批量签名当前用于 Fabric -> EVM 方向：

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `HXMSG_TEE_BATCH_SIZE` | 8 | 每次提交给 TEE quorum 的 h-xmsg 数量 |

该路径中，每个 TEE 节点仍会逐条验证 h-FSV Fabric View-like 证明。验证通过后，TEE 对这一批 h-xmsg 的 Merkle root、batchID、batchSize 和目标链 ID 形成一个 batch signing digest，并通过 5 节点 TEE quorum 提交一组批签名。EVM 侧 `HXMsgGateway.executeHXMsgMinimalBatchCluster` 只验证一次 TEE quorum，再用每条消息的 Merkle proof 证明其属于该批次，然后逐条执行目标业务合约。

因此，TEE 批量签名优化的是“多条 Fabric -> EVM 消息在 EVM 目标链上重复验证 TEE quorum”的成本。EVM -> Fabric 方向的 EVM gas 主要发生在源链业务请求提交，目标链是 Fabric，因此不会因为 TEE 批签名直接降低源链 gas。

Sepolia sync committee / finalized header 验证：

```bash
npm run sepolia:sync-committee
```

该命令不会发交易，只会读取 Sepolia execution finalized block、Beacon bootstrap、`LightClientUpdate` 和 `LightClientFinalityUpdate`，并在本地验证 current sync committee Merkle branch、跨 period 的 next sync committee 更新链、finality branch、execution payload branch、sync committee BLS 聚合签名和 2/3 参与阈值。验证通过后会更新 `runtime/sepolia-sync-committee-state.json`，保存下一次实验可继续使用的 trusted beacon root。当前 Alchemy Sepolia execution RPC 继续用于普通 EVM 读写；Alchemy Beacon endpoint 不支持 `/eth/v1/beacon/light_client/*`，因此 `.env` 中的 `SEPOLIA_LIGHT_CLIENT_BEACON_API_URL` 默认使用支持 light-client API 的 PublicNode Sepolia Beacon endpoint。

`SEPOLIA_TRUSTED_BLOCK_ROOT` 是 TEE light client 的弱主观 bootstrap checkpoint，应由实验者从可信渠道固定。代码默认要求该字段或 `runtime/sepolia-sync-committee-state.json` 存在；只有显式设置 `SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT=true` 时，脚本才会为了临时调试从 Beacon API 动态读取 finalized root。TEE 在验证 Sepolia 证明时不会信任 relayer 自带的任意 trusted root，而是使用自身 `chain-state` 中保存的 root 或 `.env` 中的初始 root，验证成功后再自动推进本地 trusted state。

Sepolia Ethereum -> Fabric 自动测试：

```bash
npm run sepolia:test:evm-fabric
```

该命令会临时把 `runtime/deployment.sepolia.json` 切换为当前部署文件，默认只跑 1 条 EVM -> Fabric 用例，等待 finality 的默认上限为 20 分钟，结束后自动恢复本地 `runtime/deployment.json`。可通过 `HXMSG_CASE_LIMIT`、`HXMSG_CASE_TOTAL`、`SEPOLIA_FINALITY_TIMEOUT_MS` 调整测试规模和等待时间。

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
HXMSG_TEE_BATCH_SIZE=1 \
HXMSG_FABRIC_EMIT_DELAY_MS=0 \
npm run hxmsg:test:forward
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

## 最近一次验证结果

最近一次本地验证已通过：

| 测试 | 结果 |
|---|---|
| `npm run compile` | PASS |
| `npm run raft:test` | 6/6 PASS |
| `HXMSG_TEE_BATCH_SIZE=8 npm run hxmsg:test:forward` | 8/8 PASS |
| `HXMSG_CASE_LIMIT=8 npm run hxmsg:test:evm-fabric` | 8/8 PASS |
| `npm run hxmsg:test:asset` | 2/2 PASS |
| `npm run hxmsg:test:challenge` | 6/6 PASS |
| `npm run hxmsg:test:challenge:fabric-evm` | PASS |
| `npm run hxmsg:test:challenge:evm-fabric` | PASS |

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

最近一次本地 Fabric -> EVM TEE 批签名主线测试结果：

| 指标 | 结果 |
|---|---|
| 运行模式 | `local-mock-committee` |
| 通过率 | 8/8 PASS |
| TEE 批大小 | `HXMSG_TEE_BATCH_SIZE=8` |
| TEE batch quorum | 5/3 |
| EVM batch tx gas | 3703239 |
| 平均 gas/message | 462905 |
| 结果文件 | `runtime/hxmsg-fabric-evm-results.json` |
| 汇总文件 | `runtime/hxmsg-test-summary.md` |

最近一次本地 EVM -> Fabric 主线回归测试结果：

| 指标 | 结果 |
|---|---|
| 运行模式 | `local-mock-committee` |
| 通过率 | 8/8 PASS |
| 并发配置 | source=1, proof=4, tee=1, fabric=2 |
| 总耗时 | 21147 ms |
| TEE quorum | 每条均为 5/3 |
| Fabric 状态 | 每条均为 `executed` |
| 结果文件 | `runtime/hxmsg-evm-fabric-results.json` |
| 汇总文件 | `runtime/hxmsg-evm-fabric-summary.md` |

### Sepolia Ethereum -> Fabric 验证结果

最近一次 Sepolia Ethereum -> Fabric 端到端测试已通过。该测试不是本地 Hardhat 模拟：源链交易真实发送到 Sepolia，TEE 通过真实 Beacon light-client 数据验证 sync committee finality，并使用 receipt MPT proof 验证源链事件存在性，再由 5 个 TEE 模拟节点形成 3/5 quorum 后提交到 Fabric。

| 指标 | 结果 |
|---|---|
| 测试命令 | `npm run sepolia:test:evm-fabric` 或 `USE_SEPOLIA_SYNC_COMMITTEE=true HXMSG_CASE_LIMIT=1 SEPOLIA_FINALITY_TIMEOUT_MS=1500000 npm run hxmsg:test:evm-fabric` |
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
| 测试命令 | `EVM_RPC="$SEPOLIA_RPC_URL" DEPLOYER_PRIVATE_KEY="$SEPOLIA_PRIVATE_KEY" HXMSG_CASE_LIMIT=1 HXMSG_TEE_BATCH_SIZE=1 npm run hxmsg:test:forward` |
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
- EVM 目标合约会部署实验 ERC20 `CrossChainToken`；资产类 op 可真实 mint token 到目标地址。
- Fabric 目标链码会写入 `business:{op}:{recordId}` 和 `businessByRequest:{requestID}`。
- Fabric 源链码支持 `LockAssetXCall`，会真实扣减余额并写入 `assetEscrow:{requestID}`。
- Fabric `CompensateAfterChallenge` 会在 `TOKEN_ESCROW` 超时后自动分发到 escrow refund handler，真实把资产退回 owner。
- EVM `EvmSourceContract.submitTokenEscrowHXMsgRequest` 会真实锁定 ERC20，超时补偿时自动退回用户。
- 当前业务执行覆盖 `asset_lock`、`mint_confirm`、`receivable_attest`、`logistics_sync`、`medical_consent`、`oracle_update`、`approval_commit`、`subsidy_confirm` 等测试用例。
- 当前 `TOKEN_ESCROW` 自动补偿已实现；Fabric 侧 asset escrow refund 与 EVM 侧 token escrow refund 都会执行真实资产退回。解锁、撤销授权、handler registry、成功 RESPONSE 后的 release/burn/settlement 策略仍是下一步扩展点。

## 当前最重要的改进项

完整梳理见 `docs/project-improvement-review-2026-05-29.md`。当前优先级最高的改进是：

1. 真实 TEE remote attestation：当前 TEE key 只是模拟服务生成的签名 key，后续需要与 TEE measurement 绑定。
2. 正式 Header Committee：当前 EVM header update 由模拟委员会签名，后续需要 epoch、轮换、成员证明和 finalized checkpoint 来源。
3. 生产级 Raft 增强：当前实现已覆盖主路径，但还缺少 WAL、snapshot、log compaction、动态成员变更和复杂网络分区恢复测试。
4. 常驻 relayer / watcher / responder：当前由测试脚本驱动完整闭环，后续需要独立进程负责监听、构造 proof、投递、重试、challenge 和 response。
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
