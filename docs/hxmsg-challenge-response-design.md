# h-xmsg 挑战响应与通用原子性设计方案

本文档整理适合当前项目的挑战响应机制设计。该机制参考 Mercury 的 challenge-response 思想，但不把项目限定为换币协议，也不强制引入统一的 `AtomicCommitmentManager`。

本项目的核心目标是通用异构链消息交互。因此，挑战响应机制应以 `TEE quorum RESPONSE` 作为完成证明，以 `timeout + challengeWindow` 作为补偿触发条件，由源链业务合约或 Fabric chaincode 自己维护 commitment 状态并执行补偿。

## 0. 当前实现状态

当前项目已经实现挑战响应基础闭环：

1. `shared/hxmsg` 已增加 `atomicity` 规范化与摘要计算，`atomicity` 参与 `hmsgDigest`。
2. `shared/hxmsg` 已增加 `ResponseProof` 摘要计算。
3. `contracts/EvmSourceContract.sol` 已实现 `submitAtomicRequest / startChallenge / completeWithResponse / compensateAfterChallenge`。
4. `fabric-chaincode/xcall/index.js` 已实现 `commitment:{requestID}`、`StartChallenge / CompleteWithResponse / CompensateAfterChallenge / QueryCommitment`。
5. `tee-verifier/server.js` 已增加 `/attest-response`，对 `ResponseProof` 进行 TEE quorum certification。
6. `scripts/run-challenge-response-tests.js` 已覆盖 EVM 侧核心状态机路径，结果保存到 `runtime/hxmsg-challenge-response-results.json`。
7. `scripts/run-fabric-evm-challenge-e2e.js` 已覆盖 Fabric -> EVM 完整闭环：Fabric h-FSV view -> TEE quorum -> EVM target execution -> EVM receipt proof -> TEE RESPONSE quorum -> Fabric commitment Completed，结果保存到 `runtime/hxmsg-fabric-evm-challenge-e2e-results.json`。
8. `scripts/run-evm-fabric-challenge-e2e.js` 已覆盖 EVM -> Fabric 完整闭环：EVM receipt MPT proof -> TEE quorum -> Fabric ExecuteHXMsg -> Fabric execution record -> TEE RESPONSE quorum -> EVM source Completed，结果保存到 `runtime/hxmsg-evm-fabric-challenge-e2e-results.json`。

Fabric 源端 atomic commitment 还会通过 `BindCommitmentHXMsg` 绑定 TEE quorum 证明过的完整 `hmsgDigest`。因此 Fabric -> EVM 的 RESPONSE 完成条件不只检查 `requestID / targetExecutionHash / responseDigest`，还要求 `response.originHmsgDigest` 与源端已绑定的 `hmsgDigest` 一致。

当前仍未实现常驻 watcher / responder。状态机由链上合约/链码最终检查 deadline，测试脚本或后续 watcher 负责触发调用。

## 1. 设计原则

完成条件不应是 HTLC 的 secret / preimage，而应是：

```text
TEE quorum 证明目标链执行事实
```

源链只有收到有效 `RESPONSE` h-xmsg 后，才能把请求从 `Pending` 改为 `Completed`。

如果反馈超时，源链不能直接退款或补偿，因为目标链可能已经执行，只是 RESPONSE 在传输中丢失。正确路径是：

```text
Pending -> Challenged -> Completed
Pending -> Challenged -> Compensated
```

也就是：

```text
超时后先进入 challenge；
challengeWindow 内允许补交 RESPONSE；
仍无有效 RESPONSE 时才执行补偿。
```

## 2. 与 HTLC 的区别

HTLC 的核心是：

```text
hashlock + timelock
```

完成条件通常是：

```text
某方在时间窗口内揭示 secret / preimage
```

本项目的完成条件是：

```text
TEE quorum RESPONSE
```

即：

```text
TEE 验证目标链确实执行了指定 h-xmsg；
TEE quorum 对 RESPONSE 签名；
源链验证 RESPONSE 后完成。
```

因此，即使项目不引入统一的 `AtomicCommitmentManager`，只要完成条件仍是 TEE quorum 对目标链执行事实的证明，就不是 HTLC。

HTLC 可以作为 `TOKEN_ESCROW` 场景下的一种业务 handler，但不应成为整个 h-xmsg 挑战响应机制。

## 3. feedback 与 atomicity

保留 `feedback` 字段，不建议删除。

`feedback` 负责通信语义：

```text
是否需要反馈
期望反馈类型
反馈超时时间
回调引用哈希
```

建议新增或规范 `atomicity` 字段，负责状态收束语义：

```text
是否要求原子性
源链锁定或记录的 commitment 是什么
成功时如何提交
失败时如何补偿
挑战窗口多长
```

两者关系：

```text
atomicity.required = true => feedback.required = true
atomicity.required = true => feedback.expectedMsgType = RESPONSE
feedback.required = true 不要求 atomicity.required = true
```

推荐结构：

```json
{
  "feedback": {
    "required": true,
    "expectedMsgType": "RESPONSE",
    "timeout": 1234567890,
    "callbackRefHash": "0x..."
  },
  "atomicity": {
    "required": true,
    "mode": "COMMIT_OR_COMPENSATE",
    "commitmentType": "STATE_LOCK",
    "commitmentRefHash": "0x...",
    "successActionHash": "0x...",
    "failureActionHash": "0x...",
    "challengeWindow": 300
  }
}
```

`atomicity` 只绑定策略和动作摘要，不直接携带完整业务逻辑。真正的退款、解锁、恢复状态、取消订单等动作由源链业务合约或 chaincode 执行。

## 4. 原子性模式

当前项目建议优先采用：

```text
Application-managed atomicity
```

也就是由具体源链业务合约或 Fabric chaincode 自己实现：

```text
submitRequest / createCommitment
completeWithResponse
startChallenge
compensateAfterChallenge
queryCommitment
```

这种方式更适合当前项目，因为：

1. 不强制所有业务都接入统一管理器。
2. 改造范围更小。
3. 普通消息、状态锁、换币 escrow 可以分别实现自己的业务语义。
4. 不会把项目过早绑定到某个单一原子性管理合约。

后续如果需要多业务复用和标准化，可以再扩展为：

```text
Protocol-managed atomicity
```

即引入统一 `AtomicCommitmentManager`。但它应作为推荐扩展，而不是当前挑战响应机制的必要条件。

## 5. commitment 类型

不同业务可以使用不同的 commitment 类型：

| 类型 | 场景 | 成功动作 | 失败补偿 |
|---|---|---|---|
| `INTENT_ONLY` | 普通消息、通知、审计记录 | 标记 completed | 标记 failed/cancelled |
| `STATE_LOCK` | 状态同步、订单状态、供应链状态 | 提交状态变更 | 解锁或恢复状态 |
| `TOKEN_ESCROW` | 换币、资产锁定 | 释放或确认资产交换 | refund |
| `PERMISSION_LOCK` | 权限、额度、配额 | 消耗权限 | 释放权限 |
| `CUSTOM` | 业务自定义 | 调用业务 handler | 调用业务 handler |

对于换币场景，通常需要中间账户或 escrow：

```text
EVM: escrow smart contract
Fabric: escrow chaincode state
```

但 escrow 只属于 `TOKEN_ESCROW` 场景，不应成为所有 h-xmsg 消息的必需结构。

## 6. 源链状态机

源链业务合约或 chaincode 应维护如下状态：

```text
None
Pending
Challenged
Completed
Compensated
Failed
Cancelled
```

核心状态转移：

```text
None -> Pending
源链创建 commitment，并发出 CONTRACT_CALL h-xmsg。

Pending -> Completed
源链在 feedback timeout 前收到有效 RESPONSE。

Pending -> Challenged
feedback timeout 后，用户、watcher、relayer 或业务服务发起 challenge。

Challenged -> Completed
challengeWindow 内提交有效 RESPONSE。

Challenged -> Compensated
challengeWindow 结束后仍无有效 RESPONSE，源链执行 failureAction。
```

必须禁止：

```text
Completed -> Compensated
Compensated -> Completed
同一 requestID 重复完成
同一 requestID 重复补偿
```

## 7. RESPONSE h-xmsg

`RESPONSE` 必须绑定原始请求。

推荐 RESPONSE payload 至少包含：

```json
{
  "msgType": "RESPONSE",
  "originRequestID": "0x...",
  "originHmsgDigest": "0x...",
  "responseStatus": "EXECUTED",
  "targetExecutionHash": "0x...",
  "targetProofRefHash": "0x...",
  "responsePayloadHash": "0x..."
}
```

建议支持以下状态：

| 状态 | 含义 | 源链处理 |
|---|---|---|
| `EXECUTED` | 目标链执行成功 | `Completed` |
| `FAILED` | 目标链执行失败且结果可证明 | 按业务策略 `Failed` 或 `Compensated` |
| `REVERTED` | 目标链交易回滚且结果可证明 | 按业务策略 `Failed` 或 `Compensated` |

TEE 不应签发“目标链未执行”作为事实证明。未执行通常难以严格证明。没有有效 RESPONSE 时，应由源链基于 `timeout + challengeWindow` 进入补偿。

## 8. RESPONSE 丢失场景

挑战响应机制必须覆盖以下情况：

```text
1. 源链请求进入 Pending。
2. 目标链已经执行成功。
3. TEE 已生成 RESPONSE。
4. RESPONSE 在 TEE / relayer / watcher 到源链的传输过程中丢失。
5. 源链没有收到 RESPONSE。
```

正确处理：

```text
1. feedback.timeout 到期。
2. 源链进入 Challenged。
3. challengeWindow 内允许任意角色补交 RESPONSE。
4. RESPONSE 验证通过后，源链进入 Completed。
5. challengeWindow 结束仍无有效 RESPONSE，源链进入 Compensated。
```

源链不应信任提交者身份，而应只验证 RESPONSE：

```text
originRequestID 是否匹配
originHmsgDigest 是否匹配
TEE quorum 是否有效
目标链执行事实是否已被 TEE 证明
request 当前状态是否允许完成
RESPONSE 是否未重放
```

## 9. 谁可以提交 RESPONSE

不应只允许原用户或原 relayer 提交 RESPONSE。

建议允许：

```text
用户
relayer
watcher
TEE responder
业务后端服务
任何第三方
```

这不等于必须保证用户离线可完成，但可以避免系统安全性依赖某个单一转发者。

源链验证的是：

```text
RESPONSE 的密码学有效性和状态机合法性
```

而不是：

```text
提交者是谁
```

## 10. TEE 职责

TEE 不负责决定业务补偿。TEE 只负责证明链上事实：

```text
源链请求确实存在
目标链执行结果确实存在
RESPONSE 与原始 requestID 绑定
RESPONSE 未被篡改或重放
```

Fabric -> EVM 的 RESPONSE：

```text
TEE 验证 EVM execution receipt
TEE 验证 receipt MPT proof
TEE 检查 event/log 与 originRequestID 绑定
TEE quorum 签名 RESPONSE
```

EVM -> Fabric 的 RESPONSE：

```text
TEE 验证 Fabric crosschainExec:{requestID}
TEE 验证 h-FSV / Fabric View-like endorsement
TEE 检查执行结果与 originRequestID 绑定
TEE quorum 签名 RESPONSE
```

## 11. TEE 缓存设计

真实 TEE 内存受限，不应长期缓存完整 h-xmsg。

推荐：

```text
完整 h-xmsg 存在 TEE 外部 durable storage；
TEE 内只保存 digest、索引和最小状态；
challenge 时重新提交完整 h-xmsg；
TEE 重新计算 digest 并与内部状态比对。
```

TEE 内部建议保存：

```text
requestID
hmsgDigest
sourceChainID
targetChainID
targetExecutionHash
commitmentRefHash
status
createdAt
expireAt
responseDigest
responseStatus
lastVerifiedHeight / blockHash
```

RESPONSE cache 也应最小化：

```text
originRequestID
responseDigest
responseStatus
targetReceiptHash / targetViewHash
signedDigest
certification metadata
```

完整 RESPONSE h-xmsg 和完整证明材料可以放在外部存储。TEE 不信任外部存储，只通过摘要校验完整性。

## 12. Fabric -> EVM 流程

正常路径：

```text
Fabric 源链创建 Pending commitment
Fabric EmitXCall 写入 crosschainEvents
TEE quorum 验证 h-FSV View
TEE quorum 签名 CONTRACT_CALL h-xmsg
EVM HXMsgGateway 执行目标合约
EVM 产生 execution receipt/log
TEE quorum 使用 MELV-EF 验证 EVM receipt proof
TEE quorum 生成 RESPONSE h-xmsg
Fabric 源链 completeWithResponse
Fabric commitment -> Completed
```

挑战路径：

```text
Fabric feedback timeout
startChallenge
challengeWindow 内提交 EVM RESPONSE -> Completed
challengeWindow 结束仍无 RESPONSE -> Compensated
```

## 13. EVM -> Fabric 流程

正常路径：

```text
EVM 源链创建 Pending commitment
EVM 触发 CrossChainCallRequested
TEE quorum 使用 MELV-EF 验证 EVM receipt proof
TEE quorum 签名 CONTRACT_CALL h-xmsg
Fabric ExecuteHXMsg 执行目标 chaincode
Fabric 记录 crosschainExec:{requestID}
TEE quorum 验证 Fabric h-FSV response view
TEE quorum 生成 RESPONSE h-xmsg
EVM 源链 completeWithResponse
EVM commitment -> Completed
```

挑战路径：

```text
EVM feedback timeout
startChallenge
challengeWindow 内提交 Fabric RESPONSE -> Completed
challengeWindow 结束仍无 RESPONSE -> Compensated
```

## 14. 后续实现建议

第一阶段：协议结构。

```text
规范 h-xmsg atomicity 字段
规范 RESPONSE h-xmsg payload
规范 responseDigest / originRequestID 绑定
```

第二阶段：基础挑战响应。

```text
EVM SourceContract 增加 completeWithResponse / startChallenge / compensateAfterChallenge
Fabric chaincode 增加 CompleteWithResponse / StartChallenge / CompensateAfterChallenge
TEE 增加 RESPONSE builder
```

第三阶段：普通消息与状态锁。

```text
实现 INTENT_ONLY
实现 STATE_LOCK
补充 RESPONSE 丢失、伪造、重复、迟到测试
```

第四阶段：换币扩展。

```text
实现 TOKEN_ESCROW
可选接入 HTLC-style escrow handler
但完成条件仍应优先使用 TEE quorum RESPONSE
```

第五阶段：可选统一管理器。

```text
如需多业务复用，再引入 AtomicCommitmentManager
否则继续保持 application-managed atomicity
```

## 15. 结论

适合当前项目的挑战响应机制是：

```text
完成证明 = TEE quorum RESPONSE
失败收束 = timeout + challengeWindow + compensateAfterChallenge
状态管理 = 源链业务合约 / Fabric chaincode 自行维护
HTLC = TOKEN_ESCROW 的可选 handler，不是通用协议核心
AtomicCommitmentManager = 后续可选统一管理器，不是当前必要条件
```

这样可以同时支持：

```text
普通跨链消息
状态同步
权限或额度锁定
Fabric / EVM 双向调用
换币 escrow
未来自定义业务补偿
```

并保持项目以 h-xmsg 和 TEE quorum 为核心的异构链消息互通设计初衷。
