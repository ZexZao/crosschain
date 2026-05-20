# 基于 h-xmsg / h-FSV / MELV-EF 的项目改造方案

## 1. 改造目标

本次改造的目标是将当前项目从以 `XMsg + validator threshold signatures + TEE attestation` 为中心的实验原型，升级为以 `h-xmsg + TEE 链适配器验证 + 目标链轻验证` 为中心的异构跨链调用框架。

核心原则如下：

1. `h-xmsg` 只描述跨链语义、源链事实定位、目标执行摘要和验证策略，不直接携带完整 Merkle proof、Fabric View、Receipt proof、MSP 证书或背书原文。
2. Fabric 源链验证采用 `h-FSV`：Fabric 链码将跨链事件状态化，TEE 查询并验证状态视图、背书、MSP 和策略。
3. EVM 源链验证采用 `MELV-EF`：TEE 验证 EVM receipt、event log、最终性和事件参数绑定，Fabric 目标链只验证 TEE 签名。
4. TEE 当前继续模拟实现，但代码结构要为后续真实 TEE 服务部署预留清晰边界。
5. 项目要从“脚本驱动实验原型”逐步整理为“模块可替换、链适配器可扩展、消息结构稳定”的工程结构。
6. 当前项目已从 Windows 克隆到 Ubuntu，后续运行入口应优先使用 Bash / Node / Docker Compose，PowerShell 保留兼容但不作为主路径。

参考文件：

- `/home/zex/codex-work/修改文件/h-xmsg.md`
- `/home/zex/codex-work/修改文件/h-FSV方案.md`
- `/home/zex/codex-work/修改文件/MELV-EF方案.md`
- `/home/zex/codex-work/修改文件/tee_hxmsg_crosschain_overall_scheme.md`
- `/home/zex/codex-work/修改文件/Mercury_Practical_Cross-Chain_Exchange_via_Trusted_Hardware.pdf`

## 2. 当前项目现状

当前项目主要组件如下：

| 模块 | 当前职责 | 改造方向 |
|---|---|---|
| `shared/xmsg.js` | 仅保留业务 payload ABI 编码 | h-xmsg 主结构已迁移到 `shared/hxmsg/` |
| `proof-builder/` | 从 Fabric/EVM event 构造旧 XMsg 和 V3 proof | 改为 `hxmsg-builder/`，只构造 h-xmsg，不直接构造链上证明 |
| `tee-verifier/server.js` | 模拟 TEE，查询 Fabric/EVM 并签名 | 拆为 TEE HTTP 层、dispatcher、Fabric adapter、EVM adapter、policy store |
| `contracts/VerifierContractV3.sol` | ECDSA threshold + TEE 双路径验证 | 改为轻量 `HXMsgGateway`，只验证 TEE 证明、防重放、过期和执行摘要 |
| `fabric-chaincode/xcall` | 发 Fabric event、处理 ACK | 增加状态化跨链记录、h-xmsg 入站执行、TEE 证明验证 |
| `validator-node/` / `consensus-aggregator/` | 旧多签验证者签名路径 | 已从当前项目删除 |
| `source-chain/*-listener.js` | 监听源链并写 runtime 文件 | 改为链监听器 + h-xmsg builder + relayer 队列，减少文件耦合 |
| `relayer/` | 提交旧 XMsg 到目标链或 Fabric | 改为通用 router，根据 target.chainType 选择提交器 |
| `scripts/` | 部署、测试、实验脚本 | 增加 Ubuntu 主路径脚本，收敛重复 V3/MPC/legacy 脚本 |

一个重要现状是：README 描述 V3 为主线，但默认 listener 仍有 `hybrid-v1` / BLS 残留；测试脚本绕过默认 builder 直接走 V3。改造时应先统一主线，避免继续出现“文档主线、测试主线、服务主线”不一致。

## 3. 目标总体架构

改造后的主流程如下：

```text
Source Chain
  |
  | emits cross-chain request / writes cross-chain state
  v
Listener
  |
  | builds h-xmsg
  v
Relayer / Router
  |
  | sends h-xmsg + optional helper data
  v
TEE Verifier
  |
  | dispatch by verificationMethod / adapterID
  v
Chain Adapter
  |-- Fabric adapter: h-FSV verification
  |-- EVM adapter: MELV-EF verification
  |-- future adapters: Cosmos / Corda / Solana
  |
  | returns TEECertification
  v
Target Gateway
  |
  | verifies TEE signature, replay, expiry, targetExecutionHash
  v
Target Application
```

TEE 之外的 relayer、listener、proof helper 均不可信。目标链不理解源链的完整证明结构，只接受 TEE 对 `hmsgDigest` 的签名结果。

## 4. h-xmsg 数据模型落地

建议在代码中将 h-xmsg 拆成稳定的结构模块：

```text
shared/hxmsg/
  constants.js          # chainType/refType/msgType/actionType/finalityModel 枚举
  schema.js             # HXMsg、HXMsgOnChain、TEECertification 的 JS 结构约定
  codec.js              # ABI/JSON canonical encode/decode
  hash.js               # hmsgDigest、refHash、binding hash、targetExecutionHash
  binding.js            # Fabric/EVM 业务绑定摘要计算
  validators.js         # 字段完整性和类型校验
```

推荐逻辑结构：

```text
HXMsg {
  header: {
    version,
    requestID,
    msgType,
    nonce,
    createdAt,
    expireAt
  },
  source: {
    chainType,
    chainID,
    domainID
  },
  target: {
    chainType,
    chainID,
    domainID
  },
  sourceRef: {
    refType,
    refHash,
    encodedRef
  },
  targetAction: {
    actionType,
    targetObject,
    functionSelector,
    callDataHash,
    receiver
  },
  verification: {
    verificationMethod,
    finalityModel,
    requiredConfirmations,
    policyRef,
    adapterID
  },
  payloadBinding: {
    sourcePayloadHash,
    businessPayloadHash,
    targetExecutionHash
  },
  feedback: {
    required,
    expectedMsgType,
    timeout,
    callbackRefHash
  }
}
```

链上压缩版不保存 `encodedRef`、完整 proof、完整 policy、完整 callData，只保存可校验摘要：

```text
HXMsgOnChain = header core
             + source/target endpoint
             + sourceRef.refType/refHash
             + targetAction
             + verification policy hash
             + payloadBinding
             + feedback
             + nonce/expireAt
```

TEE 签名必须覆盖完整执行摘要：

```text
hmsgDigest = hash(
  header,
  source,
  target,
  sourceRef.refType,
  sourceRef.refHash,
  targetAction,
  verification,
  payloadBinding,
  feedback
)
```

目标链验证 `hmsgDigest == proof.hmsgDigest`，再验 TEE 签名。

## 5. Fabric → EVM：h-FSV 改造方案

### 5.1 Fabric 链码状态化

当前 `fabric-chaincode/xcall/index.js` 的 `EmitXCall` 主要写入 `xcall:{txId}` 和 `outbound:{txId}`，并发出 `XCALL` 事件。改造后应以 `requestID` 为核心写入可查询状态：

```text
crosschainEvents:{requestID} = CrossChainEventRecord
```

建议记录：

```json
{
  "requestID": "0x...",
  "sourceTxID": "fabric-tx-id",
  "fabricCaller": "Org1MSP:UserA",
  "targetChainType": "EVM",
  "targetChainID": "0x...",
  "targetObject": "0x...",
  "functionSelector": "0x...",
  "callDataHash": "0x...",
  "businessPayloadHash": "0x...",
  "receiver": "0x...",
  "nonce": 10001,
  "expireAt": 1710000000,
  "status": "COMMITTED"
}
```

新增查询函数：

```text
QueryCrosschainEvent(requestID)
```

事件仍可保留，用于 listener 发现请求，但 TEE 验证的对象应是 Fabric world state，而不是单纯 event log。

### 5.2 h-FSV 获取与验证

TEE Fabric adapter 负责获取或接收 h-FSV：

```text
HFSV {
  viewMeta,
  payload,
  payloadHash,
  endorsements[]
}
```

验证步骤：

1. 检查 `h-xmsg.header.expireAt` 未过期。
2. 检查 `source.chainType = Fabric`，`verificationMethod = H_FSV/FABRIC_VIEW`。
3. 检查 `sourceRef.refHash == hash(encodedRef)`。
4. 根据 `encodedRef` 查询 `QueryCrosschainEvent(requestID)`。
5. 检查 view address、requestID、nonce 与 h-xmsg 一致。
6. 计算 `payloadHash` 并匹配 `payloadBinding.sourcePayloadHash`。
7. 验证 Fabric peer endorsement 签名。
8. 验证 peer 证书属于允许 MSP。
9. 按 `policyRef.policyID/policyHash` 加载 TEE 本地策略并校验策略哈希。
10. 检查背书组织集合满足策略，例如 `AND(Org1MSP, Org2MSP)` 或 `t-of-n`。
11. 检查 payload 中目标 EVM 链、目标合约、函数、callDataHash、receiver 与 `targetAction` 一致。
12. 生成 `TEECertification`。

当前阶段可以模拟 endorsement/MSP 验证，但接口和策略结构必须先按真实验证预留。

### 5.3 EVM 目标合约

新增或替换为轻量网关合约，例如：

```text
contracts/HXMsgGateway.sol
contracts/TEERegistry.sol
contracts/HXMsgLib.sol
```

EVM 侧只验证：

1. `requestID` 未处理。
2. `expireAt >= block.timestamp`。
3. `target.chainType == EVM`。
4. `target.chainID == bytes32(block.chainid)` 或配置链 ID。
5. `targetAction.targetObject` 是当前合约或白名单目标。
6. `keccak256(actualCallData) == callDataHash`。
7. 重新计算 `hmsgDigest`。
8. 验证 TEE 签名且 TEE 在 registry 中。
9. 执行目标调用。

不再让 EVM 合约验证 FabricView、Fabric block、validator threshold signatures。

## 6. EVM → Fabric：MELV-EF 改造方案

### 6.1 EVM 源合约

当前 `EvmSourceContract.sol` 应升级为标准源网关，事件字段必须能与 h-xmsg 一一绑定：

```solidity
event CrossChainCallRequested(
    bytes32 indexed requestID,
    address indexed sender,
    bytes32 indexed targetChainID,
    bytes32 targetDomainID,
    bytes32 targetObject,
    bytes4 functionSelector,
    bytes32 callDataHash,
    bytes32 businessPayloadHash,
    bytes32 receiver,
    uint64 nonce,
    uint64 expireAt
);
```

如果后续涉及资产锁定或状态锁定，增加 Mercury 风格状态机：

```text
None -> Pending -> Completed
Pending -> Challenged -> Completed
Pending -> Challenged -> Refunded
```

并提供：

```text
submitRequest(...)
startChallenge(requestID)
respondChallenge(requestID, teeResponse)
refund(requestID)
markCompleted(requestID, teeExecutionCert)
```

普通通知型调用可以先不启用挑战响应，只保留接口扩展点。

### 6.2 TEE EVM adapter

TEE EVM adapter 输入：

```text
h-xmsg
EVMEventRef
receipt / block header / finality info
verification policy
```

当前模拟阶段可以通过 RPC 查询 receipt 和 block；后续真实实验再加入 receipt inclusion proof、checkpoint 或 finalized header 验证。

验证步骤：

1. 检查 h-xmsg 版本、过期时间和 policyHash。
2. 根据 `sourceRef.encodedRef` 定位 `txHash/blockHash/logIndex/sourceContract/eventSignature`。
3. 获取交易 receipt 和区块。
4. 检查 receipt 存在，blockHash/blockNumber 匹配。
5. 检查确认数或 finalized 条件满足 `requiredConfirmations`。
6. 解析 `receipt.logs[logIndex]`。
7. 检查 log address 是可信 `EVMSourceContract`。
8. 检查 topic0 是 `CrossChainCallRequested`。
9. 解析事件参数并与 h-xmsg 的 header、target、targetAction、payloadBinding 对齐。
10. 重新计算 `sourcePayloadHash`、`businessPayloadHash`、`targetExecutionHash`。
11. 生成 `TEECertification`。

### 6.3 Fabric 目标链码

Fabric 目标链码只做轻量验证：

1. 检查 TEE 公钥或 teeID 已注册。
2. 检查 TEE 签名覆盖 `hmsgDigest`。
3. 检查 `requestID` 未处理。
4. 检查 `expireAt` 未过期。
5. 检查 `target.chainType == Fabric`。
6. 检查 `target.chainID/domainID` 匹配当前 Fabric 网络、channel 或安全域。
7. 检查 `targetAction.targetObject` 匹配目标 chaincode/service。
8. 检查 `hash(actualArgs) == callDataHash`。
9. 写入执行记录：

```text
crosschainExec:{requestID} = FabricExecutionRecord
```

该记录用于后续 ACK 或 EVM challenge-response 查询。

## 7. TEE 模拟服务的解耦设计

当前暂时模拟 TEE，但建议立即按真实部署形态重构边界：

```text
tee-verifier/
  server.js
  routes/
    attest.js
    health.js
    registry.js
  core/
    dispatcher.js
    digest.js
    certification.js
    replay-cache.js
  adapters/
    fabric-hfsv-adapter.js
    evm-melv-adapter.js
  policies/
    policy-store.js
    policies.local.json
  identity/
    simulated-key-store.js
    remote-attestation-placeholder.js
```

HTTP 接口建议：

```text
POST /attest
  input:  { hxmsg, helperData? }
  output: { teeCertification, verificationResult }

GET /pubkey
GET /health
GET /policy/:policyID
POST /admin/mode   # only for experiments: normal/tamper/unavailable
```

`helperData` 只是辅助材料，TEE 不能默认信任。真实 TEE 部署后替换 identity 和 attestation 层，adapter 与 h-xmsg 逻辑尽量不变。

## 8. Relayer 与 Listener 解耦

建议将监听、构造、验证请求、提交四步拆开：

```text
source-chain/
  fabric-listener.js     # 只监听并产出 source event envelope
  evm-listener.js

hxmsg-builder/
  fabric-to-evm.js       # Fabric event/state -> h-xmsg
  evm-to-fabric.js       # EVM event -> h-xmsg
  ack.js

relayer/
  router.js              # target.chainType 分发
  submitters/
    evm-submit.js
    fabric-submit.js
  tee-client.js
```

运行时数据也建议从“共享 latest 文件”改为可追踪的 requestID 文件或轻量队列：

```text
runtime/requests/{requestID}/source-event.json
runtime/requests/{requestID}/hxmsg.json
runtime/requests/{requestID}/tee-cert.json
runtime/requests/{requestID}/relay-result.json
```

这样可以避免 `latest-xmsg.json` 被并发覆盖，也方便实验复现。

## 9. 合约与链码改造清单

### 9.1 EVM 合约

新增：

| 文件 | 作用 |
|---|---|
| `contracts/HXMsgGateway.sol` | EVM 目标侧 h-xmsg 轻量验证与执行入口 |
| `contracts/HXMsgLib.sol` | h-xmsg 链上压缩结构和 digest 计算 |
| `contracts/TEERegistry.sol` | TEE 公钥、状态、版本哈希管理 |
| `contracts/EVMSourceGateway.sol` | EVM 源链请求、事件、可选 challenge/refund |

保留：

| 文件 | 保留原因 |
|---|---|
| `TargetContract.sol` | 可继续作为目标业务合约 |
| `VerifierContractV3.sol` | 保留用于旧 V3 对比实验 |
| `VerifierContractV3MPC.sol` | 保留用于 MPC 对比实验 |

### 9.2 Fabric 链码

改造 `fabric-chaincode/xcall/index.js`：

1. `EmitXCall` 生成 h-xmsg 所需字段并写入 `crosschainEvents:{requestID}`。
2. 增加 `QueryCrosschainEvent(requestID)`。
3. 增加 `InvokeHXMsg(hxmsgCompactJson, actualArgsJson, teeCertJson)`。
4. 增加 TEE registry 状态，例如 `trustedTEE:{teeID}`。
5. 增加 `crosschainExec:{requestID}` 执行记录。
6. 不保留旧 `ConfirmAckXMsg` ACK 路径；后续 ACK/RESPONSE 统一走 h-xmsg 入站执行模型。

## 10. 策略与配置管理

新增统一策略目录：

```text
config/
  chains.local.json
  tee-registry.local.json
  policies/
    fabric-hfsv.mychannel.local.json
    evm-melv.localhost.local.json
```

策略示例：

```json
{
  "policyType": "FabricEndorsementPolicy",
  "policyID": "fabric-mychannel-hfsv-v1",
  "securityDomain": "fabric-local",
  "channelID": "mychannel",
  "chaincodeName": "xcall",
  "requiredOrgs": ["Org1MSP"],
  "rule": "THRESHOLD",
  "threshold": 1,
  "mspRootHash": "0x...",
  "allowedQueryFunctions": ["QueryCrosschainEvent"]
}
```

本地 Fabric 目前只有 Org1，可以先用 `1-of-1` 策略；设计上保留多组织扩展。

EVM 策略示例：

```json
{
  "policyType": "EVMFinalityPolicy",
  "policyID": "evm-localhost-melv-v1",
  "sourceChainID": "eip155:31337",
  "trustedSourceContracts": ["0x..."],
  "allowedEventSignatures": ["CrossChainCallRequested"],
  "requiredConfirmations": 1,
  "finalityMode": "confirmation-based",
  "receiptProofRequired": false
}
```

本地 Hardhat 可先设 `requiredConfirmations = 1`，后续公网或私链实验再开启 receipt proof / checkpoint。

## 11. Ubuntu 迁移与运行入口

当前 `package.json` 和 README 仍以 Windows PowerShell 为主。Ubuntu 主路径建议：

1. 将 `fabric-network/scripts/*.sh` 作为主入口。
2. 新增 `scripts/start-linux.sh` 或 `Makefile`。
3. `package.json` 新增 Linux 命令：

```text
fabric:bootstrap:linux
fabric:channel:linux
fabric:cc:deploy:linux
fabric:cc:invoke:linux
start:linux
start:linux:forward
```

4. 保留 `.ps1` 文件，但 README 标注为 Windows legacy。
5. 删除 `npm.cmd`、PowerShell 语法在 Ubuntu 主流程中的依赖。
6. 检查 Docker Compose 网络名和容器名，避免硬编码 Windows 路径行为。

## 12. 迁移阶段建议

### 阶段 0：方案冻结与基线测试

目标：确认当前 V3 测试能跑通，记录 gas、延迟、成功率作为对比基线。

产出：

- 当前 V3 正向和闭环测试结果。
- 当前可运行命令清单，区分 Ubuntu / Windows。

### 阶段 1：引入 h-xmsg 结构，不改变验证语义

目标：新增 `shared/hxmsg/` 和 `hxmsg-builder/`，让 listener/test 能生成 h-xmsg，同时保留旧 XMsg。

产出：

- h-xmsg JSON 示例。
- hmsgDigest 与 targetExecutionHash 单元测试。
- 旧 XMsg 到 h-xmsg 的字段映射文档。

### 阶段 2：TEE 服务适配器化

目标：把 `tee-verifier/server.js` 拆成 dispatcher + adapters，先用模拟验证通过原有测试。

产出：

- `fabric-hfsv-adapter` 模拟版。
- `evm-melv-adapter` 模拟版。
- `TEECertification` 统一输出。

### 阶段 3：Fabric→EVM 切到 h-FSV 主线

目标：Fabric 链码状态化，TEE 按 h-FSV 查询状态并签名，EVM `HXMsgGateway` 执行。

产出：

- `QueryCrosschainEvent(requestID)`。
- h-FSV policy。
- EVM 轻量网关。
- Fabric→EVM 正向测试。

### 阶段 4：EVM→Fabric 切到 MELV-EF 主线

目标：EVM source gateway 发标准事件，TEE 验证 receipt/log/finality，Fabric chaincode 轻量执行。

产出：

- `EVMSourceGateway.sol`。
- `InvokeHXMsg` Fabric 入口。
- EVM→Fabric 测试。

### 阶段 5：ACK / RESPONSE 与挑战响应

目标：将旧 ACK 统一建模为 `msgType = RESPONSE/ACK` 的 h-xmsg；对资产锁定类场景加入 challenge/refund。

产出：

- ACK h-xmsg builder。
- Fabric execution record 查询。
- EVM challenge-response 实验脚本。

### 阶段 6：实验与论文支撑

目标：形成功能、安全、性能、对比实验。

实验项：

- 正常 Fabric→EVM。
- 正常 EVM→Fabric。
- 篡改 targetAction。
- 篡改 callData。
- 重放 requestID。
- 未注册 TEE。
- EVM 确认数不足。
- Fabric 状态不存在。
- Fabric 策略不满足。
- TEE unavailable + challenge/refund。

## 13. 旧文件处理建议

以下文件先不要删除，可标记为 legacy 或 comparison：

| 文件/目录 | 建议 | 原因 |
|---|---|---|
| `contracts/VerifierContract.sol` | legacy | V1 TEE 单约束合约 |
| `contracts/VerifierContractV2.sol` | legacy/comparison | BLS + TEE 旧路径 |
| `contracts/VerifierContractV3.sol` | comparison | 当前 V3 基线对比 |
| `contracts/VerifierContractV3MPC.sol` | comparison | MPC-TSS 对比实验 |
| `proof-builder/fabric-proof-builder.js` | legacy | 生成 `hybrid-v1` BLS proof |
| `proof-builder/evm-proof-builder.js` | legacy | 生成 `hybrid-v1` BLS proof |
| `proof-builder/v3-proof-builder.js` | migration baseline | 可迁移为 h-xmsg builder |
| `proof-builder/mpc-proof-builder.js` | comparison | MPC 实验路径 |
| `consensus-aggregator/` | deleted | 新主线不再依赖 validator 多签 |
| `validator-node/` | deleted | 新主线不再依赖 validator 多签 |
| `evm-validator-node/` | deleted | 新主线不再依赖 validator 多签 |
| `relayer/index.js` | deleted | 旧多分支 relayer 已删除，后续 router 基于 h-xmsg 主线重建 |
| `relayer/ack-to-fabric.js` | deleted | 旧 ACK relay 已删除，ACK 应统一为 h-xmsg msgType |
| `scripts/run-v3-test.js` | legacy/test-risk | ABI 可能已与 V3 合约不一致 |
| `scripts/run-mpc-*` | comparison | MPC 对比实验保留 |
| `start.ps1` | windows legacy | Ubuntu 不作为主入口 |
| `fabric-network/scripts/*.ps1` | windows legacy | 保留 Windows 兼容 |

## 14. 需要重点避免的耦合

1. 不要让 h-xmsg 模块直接依赖 Fabric SDK 或 ethers provider。
2. 不要让 TEE adapter 直接写 runtime 文件；文件读写放在测试 harness 或 relayer。
3. 不要让 Fabric adapter 和 EVM adapter 共享链特定解析逻辑。
4. 不要让目标合约知道 FabricView、receipt proof 或 MSP 细节。
5. 不要继续用 `latest-xmsg.json` 作为并发主路径。
6. 不要把 TEE 私钥管理、远程证明、验证逻辑全部塞在一个 `server.js`。
7. 不要把 Windows PowerShell 命令作为 Ubuntu 主流程。

## 15. 验收标准

改造完成后，至少应满足：

1. 同一套 `HXMsg` schema 支持 Fabric→EVM 和 EVM→Fabric。
2. Fabric→EVM 使用 h-FSV adapter，EVM→Fabric 使用 MELV-EF adapter。
3. 目标链只验证 TEE 证明、防重放、过期和执行摘要。
4. TEE 当前可模拟运行，未来能替换为远程服务器/真实 TEE，而不重写 relayer 和合约侧消息结构。
5. Ubuntu 下有完整启动、部署、测试命令。
6. 旧 V3 / BLS / MPC 路径可作为对比实验保留，但不再是默认主线。
7. 所有请求以 `requestID` 组织 runtime artifacts，避免并发覆盖。
8. 安全实验能覆盖篡改、重放、未注册 TEE、最终性不足、源链事实不存在等场景。

## 16. 推荐最终目录形态

```text
contracts/
  HXMsgGateway.sol
  HXMsgLib.sol
  TEERegistry.sol
  EVMSourceGateway.sol
  TargetContract.sol
  legacy/

fabric-chaincode/
  xcall/
    index.js

shared/
  hxmsg/
  crypto/
  config/

hxmsg-builder/
  fabric-to-evm.js
  evm-to-fabric.js
  ack.js

tee-verifier/
  server.js
  core/
  adapters/
  policies/
  identity/

relayer/
  router.js
  tee-client.js
  submitters/

source-chain/
  fabric-listener.js
  evm-listener.js

config/
  chains.local.json
  tee-registry.local.json
  policies/

scripts/
  start-linux.sh
  run-hxmsg-forward.js
  run-hxmsg-roundtrip.js
  run-security-suite.js
```

## 17. 总结

本次改造的主线不是继续强化现有 validator 多签证明，而是将项目抽象为：

```text
h-xmsg 描述跨链请求
TEE adapter 验证源链事实
TEE certification 绑定 h-xmsg digest
目标链轻量验证并执行
```

Fabric→EVM 通过 h-FSV 解决 Fabric 状态视图验证，EVM→Fabric 通过 MELV-EF 解决 EVM receipt/event/finality 验证。当前 TEE 可以继续模拟，但模块边界要按真实 TEE 服务部署设计。旧 V1/V2/V3/MPC/validator 多签路径先保留为对比实验，不在本轮删除。
