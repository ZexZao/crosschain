# 多 TEE 与 Raft 设计注意点

> 更新：当前项目已经实现本地 Docker 环境下的 Raft 风格 TEE 集群主路径，包括 RequestVote、AppendEntries、leader election、heartbeat、日志复制、commitIndex 和提交后签名。本文保留为此前的设计注意点；最新实现见 `docs/raft-tee-cluster-implementation.md`。

## 1. 背景

当前项目已经在 Fabric -> EVM 方向实现了 h-FSV / Weaver-like 的验证路径：

```text
Fabric peers endorse state view
        |
        v
single TEE verifies h-FSV
        |
        v
TEE signs hmsgDigest
        |
        v
EVM verifies TEE signature
```

这个实现能够证明 Fabric 状态视图真实存在，并且能够验证 peer endorsement、MSP 身份、验证策略、交易存在性、交易有效性和写集内容。

但是，本项目的初衷不是只完成 Fabric -> EVM 单一方向，而是构建面向异构区块链之间互通的通用跨链调用框架。因此，即使某些具体链适配场景只需要一个 TEE 完成验证，从系统一般性和可扩展性角度看，后续仍应引入多 TEE 与 Raft 层。

## 2. 当前实现与 Mercury 的关系

当前项目借鉴了 Mercury 的核心思想：

1. 将复杂源链验证逻辑放入 TEE。
2. 目标链不直接验证完整异构链证明。
3. TEE 对跨链消息摘要进行签名。
4. 目标链只验证 TEE 身份、TEE 签名、防重放和目标调用绑定。

但当前项目尚未实现 Mercury 中更强的多 TEE 共识结构：

1. 当前只有一个 `tee-verifier` 服务实例。
2. 当前只有一个 TEE 私钥和一个 TEE 签名结果。
3. `HXMsgGateway` 只要求一个可信 TEE 签名即可执行。
4. 当前没有 TEE leader / follower。
5. 当前没有 Raft log、term、commitIndex 或状态机复制。
6. 当前没有多 TEE quorum 或 threshold signature。

因此，准确表述应为：

> 当前项目实现了 Mercury 风格的 TEE 辅助轻量验证思想，但尚未实现 Mercury 风格的多 TEE + Raft 共识机制。

## 3. 为什么仍然需要多 TEE + Raft

虽然 h-FSV 在 Fabric -> EVM 场景下可以由单个 TEE 完成完整验证，但单 TEE 会带来一般性不足：

1. 单 TEE 是可用性单点。
2. 单 TEE 私钥泄露后会影响整个系统。
3. 单 TEE 本地维护的 policy、checkpoint、processed request 状态无法复制。
4. 不同链适配器的验证结果缺少 TEE 集群级一致性。
5. 未来 EVM -> Fabric、Cosmos、Corda、Solana 等方向可能需要维护链头、最终性 checkpoint、challenge-response 状态或批量验证状态。
6. 真实部署时，TEE 节点可能升级、重启、迁移或临时不可用，需要一个一致性层来保证验证服务状态不丢失、不分叉。

因此，多 TEE + Raft 不应被视为 h-FSV 的替代，而应被视为 TEE 验证服务的一致性增强层。

## 4. 分层定位

推荐分层如下：

```text
h-xmsg
  通用跨链消息层

h-FSV / MELV-EF / future adapters
  链适配验证层

TEE Cluster + Raft
  TEE 服务一致性层

TEE signature / threshold signature
  目标链可验证证明层

Target Gateway
  目标链轻量验证与执行层
```

各层职责如下：

| 层 | 职责 |
|---|---|
| Fabric peer endorsement | 证明 Fabric 状态视图由 Fabric peer 背书 |
| h-FSV adapter | 在 TEE 内验证 Fabric view、MSP、policy、payload、tx、rwset |
| MELV-EF adapter | 在 TEE 内验证 EVM receipt、event、finality 和参数绑定 |
| Raft among TEEs | 让多个 TEE 对请求顺序、策略版本、验证结果和 checkpoint 状态达成一致 |
| TEE signature / threshold signature | 向目标链证明 TEE 集群认可该结果 |
| Target Gateway | 验证 TEE 证明、防重放、过期时间和目标执行摘要 |

## 5. Raft 应该复制什么

后续引入 Raft 时，建议复制的状态包括：

1. `requestID`
2. `hmsgDigest`
3. `sourceRef`
4. `targetExecutionHash`
5. `policyID`
6. `policyHash`
7. `adapterID`
8. `verificationMethod`
9. `verificationResult`
10. `verifiedLocator`
11. `source chain checkpoint`
12. `processed request state`
13. `TEE program version`
14. `policy/config version`

这些状态用于保证多个 TEE 对以下问题达成一致：

1. 哪些 h-xmsg 已经被验证。
2. 每个 h-xmsg 的验证结果是什么。
3. 验证时使用的是哪个 policy 版本。
4. 验证时参考的是哪个源链 checkpoint。
5. 哪些 requestID 已经输出过可提交到目标链的证明。

## 6. 推荐执行流程

后续多 TEE 版本可以采用如下流程：

```text
Relayer submits h-xmsg to TEE leader
        |
        v
Leader appends VerifyRequest to Raft log
        |
        v
Followers replicate and commit the request
        |
        v
Each TEE verifies or checks verification result
        |
        v
Leader appends VerificationResult to Raft log
        |
        v
Raft commit reached
        |
        v
TEE cluster outputs proof
        |
        v
Target chain verifies quorum / threshold / registered TEE proof
```

TEE 集群输出可以有三种形式：

1. **Leader signature + Raft commit metadata**  
   实现简单，但目标链验证 Raft commit metadata 会比较复杂。

2. **Multi-TEE signatures**  
   多个 TEE 对同一个 `hmsgDigest` 或 `VerificationResultDigest` 签名，目标链要求达到阈值。

3. **TEE threshold signature**  
   TEE 集群生成一个门限签名，目标链只验证一个聚合签名或门限公钥。

从目标链轻量化角度看，长期更推荐 threshold signature；从工程实现和调试角度看，早期可以先实现 multi-TEE signatures。

## 7. Raft 的安全边界

需要明确：Raft 主要提供 crash fault tolerance，不提供 Byzantine fault tolerance。

这意味着：

1. Raft 可以处理 TEE 节点宕机、重启、网络短暂中断和 leader 切换。
2. Raft 可以保证 TEE 集群内日志顺序一致。
3. Raft 可以复制 policy、checkpoint 和 processed request 状态。
4. Raft 本身不能抵抗恶意 leader 或拜占庭 TEE 节点。

因此，如果论文或方案中采用 Raft，需要同时说明信任假设：

```text
TEE 程序由远程证明保证一致；
TEE 私钥受可信硬件保护；
Raft 节点被认为是 crash fault model，而不是 Byzantine model；
恶意 TEE 或 TEE 被攻破的问题需要通过远程证明、版本治理、TEE 白名单、阈值签名或 BFT 机制进一步缓解。
```

如果目标是抵抗恶意 TEE，则应考虑以下增强：

1. 多 TEE 阈值签名。
2. TEE 远程证明和程序哈希白名单。
3. TEE 公钥轮换和吊销机制。
4. 对高价值请求使用更高阈值策略。
5. 用 BFT 共识替代或增强 Raft。

## 8. 与当前 h-FSV 的关系

当前 h-FSV 验证路径不需要被推翻。

多 TEE + Raft 应作为外层增强：

```text
Current:
  h-xmsg -> single TEE -> h-FSV adapter -> TEE signature

Future:
  h-xmsg -> TEE cluster -> Raft -> h-FSV adapter(s) -> quorum / threshold proof
```

h-FSV 仍然负责 Fabric 源链事实验证；Raft 负责多个 TEE 对验证请求、验证状态和验证输出达成一致。

## 9. 后续改造建议

后续代码改造可以按以下阶段推进：

1. 将 `tee-verifier` 抽象为 `tee-node`，每个节点拥有独立 TEE 身份。
2. 增加 `tee-cluster` 配置，定义节点列表、Raft peer 地址、TEE 公钥和版本哈希。
3. 将当前 `/attest` 拆成：
   - `/submitVerifyRequest`
   - `/raftAppend`
   - `/raftVote`
   - `/raftCommit`
   - `/verificationResult`
4. 将 `verificationResult` 标准化为可复制、可签名的数据结构。
5. 增加 multi-TEE signature result：
   - `hmsgDigest`
   - `verificationResultDigest`
   - `signatures[]`
   - `teeAddresses[]`
   - `threshold`
6. 升级 `TEERegistry` 或新增 `TEEClusterRegistry`。
7. 升级 `HXMsgGateway`，从验证单 TEE 签名扩展为验证 TEE quorum 或 threshold proof。
8. 保留单 TEE 模式作为开发和低安全级别测试模式。

## 10. 结论

当前单 TEE h-FSV 实现适合验证 Fabric -> EVM 的核心链路，但从异构区块链通用互通框架的角度看，多 TEE + Raft 仍然是必要的系统层增强。

最终架构应表达为：

```text
h-xmsg describes what to verify;
adapters verify heterogeneous source-chain facts;
TEE cluster uses Raft to keep verification service state consistent;
target chains verify compact TEE cluster proof.
```
