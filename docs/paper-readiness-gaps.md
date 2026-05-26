# Paper Readiness Gaps

本文档整理当前项目作为论文系统发表前仍需补齐的不足。当前项目已经实现 h-xmsg / h-FSV / MELV-EF 双向主线、4 节点模拟 TEE Raft quorum、EVM receipt MPT proof、模拟 Header Committee 认证 header window，以及挑战响应原子性闭环。但若作为论文发表，仍需清晰界定实验边界，并补齐若干安全和评估缺口。

## 1. 当前可作为论文贡献的部分

当前系统可以定位为：

```text
一个面向异构区块链消息互通的 TEE-assisted prototype。
它实现了 h-xmsg 通用消息格式、Fabric h-FSV 源事实验证、EVM MELV-EF receipt proof 验证、TEE Raft quorum、目标链轻量执行验证，以及 challenge-response 原子性闭环。
```

当前已经具备的论文贡献点：

1. h-xmsg 链无关消息结构。
2. Fabric -> EVM 方向的 h-FSV 验证。
3. EVM -> Fabric 方向的 receipt MPT proof 验证。
4. 目标链轻量验证，只验证 TEE quorum 和 h-xmsg 绑定摘要。
5. 4 节点模拟 TEE Raft quorum。
6. challenge-response 原子性状态机。
7. 普通消息与需要 RESPONSE 的原子消息分离。
8. 删除旧 listener / relayer / validator 多签路径，避免误用旧安全模型。

## 2. 必须在论文中说明的实验边界

以下内容目前不能被描述为生产级安全实现，只能作为实验原型边界：

1. 当前 TEE 是 Node.js 模拟服务，不是真实 SGX / TDX / SEV 等硬件 TEE。
2. 当前 Header Committee 是本地模拟实现，不是真实 EVM finalized checkpoint / beacon light client。
3. 当前 Fabric 网络是本地单组织 `Org1MSP` 实验网络，多组织 Fabric 背书策略仍待实验。
4. 当前 Raft 是项目内实验实现，不是生产级共识库。
5. 当前常驻 watcher / responder 尚未实现，测试脚本负责触发 challenge、response 和 compensation。

论文中应避免声称：

```text
已实现生产级 TEE；
已完整实现 Ethereum finality light client；
已完全等价 Mercury；
已完整支持任意新链即插即用；
已实现严格无妥协生产级原子性。
```

## 3. 高优先级安全缺口

### 3.1 TEE quorum threshold 仍由调用者提供

当前 EVM 侧：

```solidity
executeHXMsgMinimalCluster(..., uint256 threshold)
completeWithResponse(..., uint256 threshold)
```

Fabric 侧：

```javascript
const threshold = Number(certEnvelope.threshold || 1)
```

问题：

1. relayer 可以尝试提交较低 threshold。
2. 测试中使用 3/4，但目标链和 Fabric chaincode 没有从可信配置中强制读取阈值。
3. 这不满足 `2f+1` TEE 中至少 `f+1` 或项目指定 3/4 quorum 的固定安全模型。

整改建议：

1. EVM `TEERegistry` 存储 cluster 配置和固定 threshold。
2. Fabric chaincode 存储 cluster 配置和固定 threshold。
3. certification envelope 可以携带 reached / total / clusterID，但不能决定验签阈值。
4. 目标链只接受来自可信 cluster 的 TEE 地址集合。

### 3.2 EVM -> Fabric 的 RESPONSE 验证对 Fabric 执行事实仍偏弱

当前 `/attest-response` 对 EVM execution receipt 验证较强，使用 receipt MPT proof 和 committee-certified header。

但对 Fabric execution record 路径，目前主要检查：

```javascript
helperData.fabricExecutionRecord
record.requestID
record.status === 'executed'
hash(JSON.stringify(record))
```

问题：

1. TEE 没有重新查询 Fabric peers 获取目标执行 view。
2. 没有验证 Fabric peer endorsement。
3. 没有验证目标执行记录的写集。
4. 因此 EVM -> Fabric 挑战响应闭环中的 RESPONSE 事实证明弱于 Fabric -> EVM 源事实证明。

整改建议：

1. 为 Fabric target execution record 设计 h-FSV-like RESPONSE view。
2. TEE 查询 `GetInboundStatus(requestID)` 或 `crosschainExec:{requestID}`。
3. 验证 peer endorsement、MSP、policyHash。
4. 通过 QSCC 或等价方式验证目标执行交易确实写入 execution record。

### 3.3 EVM finalized checkpoint 仍是模拟边界

当前 EVM -> Fabric 已经使用：

```text
receipt MPT proof + committee-certified header window
```

但 Header Committee 仍是本地模拟实现。

问题：

1. 不能声称已实现真实 Ethereum finalized checkpoint proof。
2. Hardhat 本地环境无法代表 PoS finality。
3. 若未来开启 confirmation fallback，必须明确其仅为 local-dev。

整改建议：

1. 将模拟 Header Committee 抽象为正式 `HeaderCommittee` 接口。
2. 后续实现区块头管理委员会。
3. 委员会验证 beacon light client update 或等价 finalized checkpoint。
4. TEE 只接受委员会签名的 finalized header update。
5. 严格模式下禁用 confirmation fallback。

### 3.4 真实 TEE 部署和 attestation 尚未实现

当前 TEE 是普通 Node.js 进程。

论文安全模型中仍缺：

1. remote attestation。
2. TEE key generation / sealing。
3. TEE crash recovery。
4. TEE enclave measurement。
5. TEE 内外通信边界。
6. 真实 TEE 内存限制下的 header window / proof cache 评估。

整改建议：

1. 至少选择一种 TEE 平台做最小部署实验。
2. 给出 attestation 报告与 TEE 公钥绑定方式。
3. 明确模拟 TEE 与真实 TEE 的差异。
4. 若短期不部署真实 TEE，论文必须把当前实现定位为 prototype。

### 3.5 Raft 是实验级实现

当前 Raft 已实现：

1. RequestVote。
2. AppendEntries。
3. leader election。
4. heartbeat。
5. commitIndex。
6. committed signing。

但仍缺：

1. WAL。
2. snapshot。
3. log compaction。
4. InstallSnapshot。
5. network partition recovery 测试。
6. crash recovery 测试。
7. Byzantine TEE 行为边界说明。

论文中应说明：

```text
leader 是日志复制协调者，不是安全根。
节点只在 entry committed 后签名。
```

若要进一步增强论文可信度，应补充 Raft 故障实验。

## 4. 设计论证仍需补齐的内容

### 4.1 形式化安全模型不足

论文需要补充：

1. 系统模型。
2. 攻击者模型。
3. relayer 不可信假设。
4. TEE 信任假设。
5. Fabric peer / endorsement policy 假设。
6. EVM finality 假设。
7. Header Committee 信任假设。
8. liveness 假设。

建议定义的安全性质：

| 性质 | 含义 |
|---|---|
| Authenticity | 目标链只接受真实源链事实对应的 h-xmsg |
| Integrity | h-xmsg 字段、payload、target action 不能被 relayer 篡改 |
| Non-replay | 同一 requestID / responseDigest 不能重复执行 |
| Source existence | TEE 证明具体源交易存在，而不是只证明区块存在 |
| Target execution binding | 目标链执行必须绑定 targetExecutionHash |
| Atomic completion | 需要 RESPONSE 的消息最终进入 Completed 或 Compensated |
| TEE quorum safety | 少于阈值的 TEE 不能伪造 certification |

### 4.2 h-FSV 与 Fabric Cacti Fabric View 的关系需要更形式化

当前 h-FSV 实现包括：

1. peer endorsed query view。
2. MSP certificate / endorsement signature verification。
3. policyHash verification。
4. QSCC block / txId / VALID / rwset cross-check。

论文中需要讲清楚：

1. h-FSV view 的字段结构。
2. endorsement 签名覆盖的对象。
3. 与 Fabric Cacti Weaver Fabric View 的相同点。
4. 与 Fabric Cacti Weaver Fabric View 的不同点。
5. 为什么额外 block/rwset cross-check 不违背 h-FSV 设计。
6. 项目最终是坚持纯 Fabric View，还是采用 View + block cross-check。

### 4.3 与 Mercury 的关系需要准确描述

当前项目参考 Mercury，但不完全等同 Mercury。

相同点：

1. TEE 作为轻客户端式验证者。
2. 多 TEE quorum。
3. challenge-response 思路。
4. TEE 不长期保存完整链历史，只保存有限 header/checkpoint。

不同点：

1. 当前 Header Committee 是模拟实现。
2. 当前 TEE 是 Node.js 模拟，不是真实 enclave。
3. 当前项目面向通用消息交互，不只面向换币。
4. 当前原子性由 application-managed commitment 实现，不强制统一 vault。
5. 当前 Raft 是实验实现。

论文中应避免把当前系统描述为 Mercury 的完整复现。

## 5. 实验评估不足

当前测试主要证明功能闭环跑通，还不足以支撑完整论文评估。

建议补充实验：

1. Gas 对比：
   - 完整 h-xmsg 上链。
   - `HXMsgMinimal` 上链。
   - 普通消息。
   - challenge-response 消息。
2. TEE 数量变化：
   - 1 / 2 / 3 / 4 / 5 / 7 个 TEE。
   - latency 与 quorum 成本。
3. Payload 大小变化：
   - callData size。
   - h-xmsg size。
   - receipt proof size。
4. Fabric peer 数量变化：
   - endorsement 数量。
   - h-FSV query latency。
5. EVM proof 开销：
   - receipt MPT proof 构造时间。
   - TEE verification time。
   - proof size。
6. Raft 开销：
   - log size 增长。
   - commit latency。
   - leader failure。
   - follower failure。
7. challenge-response 开销：
   - normal path。
   - challenged-completed path。
   - challenged-compensated path。
8. 与基线方案对比：
   - HTLC。
   - Fabric Cacti / Weaver。
   - Mercury-like TEE proof。
   - naive relayer / validator multisig。

## 6. 多链即插即用仍需第三链验证

当前 h-xmsg 字段和 TEE adapter 设计支持扩展，但实际实现链只有 Fabric 和 EVM。

如果论文声称支持异构多链即插即用，建议至少补充一个第三链 prototype，例如 Cosmos。

否则应表述为：

```text
当前实现验证 Fabric 与 EVM 两类异构链，协议结构和 adapter 框架支持扩展到其他链。
```

而不是：

```text
系统已经完整支持任意异构链即插即用。
```

## 7. 论文发表前建议优先级

建议按以下顺序推进：

1. 固定 TEE quorum threshold，不能由 relayer / caller 决定。
2. 补 Fabric target execution RESPONSE 的 h-FSV-like 验证。
3. 将模拟 Header Committee 抽象为清晰接口，并写明真实委员会替换方案。
4. 补充 threat model 和 security argument。
5. 补充系统性实验评估。
6. 完善 Raft 故障实验或明确其 prototype 边界。
7. 若论文重点是多链扩展，则补第三链实验。
8. 若论文重点是 TEE 安全，则补真实 TEE attestation 实验。

## 8. 推荐论文表述

推荐使用：

```text
We implement a prototype of a TEE-assisted heterogeneous cross-chain message transport protocol.
The prototype validates Fabric source facts through an h-FSV view, validates EVM source facts through receipt MPT proofs anchored to committee-certified headers, and uses a Raft-backed TEE quorum to certify h-xmsg delivery and response proofs.
```

避免使用：

```text
The system is production-ready.
The system fully implements Ethereum finality.
The system fully reproduces Mercury.
The system supports arbitrary blockchains plug-and-play without additional adapters.
```

