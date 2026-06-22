# h-xmsg 三层结构设计说明

本文档描述当前项目中重构后的 h-xmsg 设计。新的设计不再把协议承诺字段、证明材料、执行数据和调试信息全部混在一个顶层对象中，而是拆分为四类对象：

```text
Canonical h-xmsg  -> 被哈希承诺、被 TEE 验证的核心跨链消息
HxmsgEnvelope     -> 链下传递给 TEE / relayer 的证明与执行材料包
DeliveryMessage   -> 提交给目标链的 minimal 执行消息
AuditRecord       -> 实验、审计和调试信息
```

核心原则是：

```text
h-xmsg 只描述并承诺安全语义。
Envelope 承载证明材料和执行数据。
DeliveryMessage 面向目标链最小化执行。
AuditRecord 保存 txId、高度、proofMeta 等调试和实验信息。
```

## 1. 为什么重构

旧结构把以下字段放在同一个顶层对象中：

```text
header / source / target / sourceRef / targetAction / verification / payloadBinding / feedback / atomicity
callData / compactCall / callDataDecoded / txId / srcHeight / sourceRecord / proofMeta / hmsgDigest
```

其中前一组是协议安全语义，后一组是链下执行、证明、调试或目标链 delivery 数据。混在一起会造成三个问题：

1. 论文表述不清：读者难以区分哪些字段被 TEE 承诺，哪些只是运行时材料。
2. 工程边界不清：未进入 digest 的字段如果被误用，可能形成实现层漏洞。
3. 字段冗余：例如 `targetExecutionHash` 可由 `requestID + target + targetAction` 派生，不应作为 canonical 输入字段。

重构后，Canonical h-xmsg 是唯一的核心协议对象；其他材料通过 envelope、delivery 和 audit 分层承载。

## 2. Canonical h-xmsg

Canonical h-xmsg 是被计算 `hmsgDigest` 的对象。它只包含安全承诺字段。

```json
{
  "header": {
    "version": 1,
    "requestID": "bytes32",
    "msgType": 1,
    "nonce": 0,
    "nonceScope": "bytes32",
    "sourceTimestamp": 0,
    "deliveryExpireAt": 0
  },
  "source": {
    "chainType": 1,
    "chainID": "bytes32",
    "domainID": "bytes32"
  },
  "target": {
    "chainType": 2,
    "chainID": "bytes32",
    "domainID": "bytes32"
  },
  "sourceRef": {
    "refType": 2,
    "refHash": "bytes32"
  },
  "targetAction": {
    "actionType": 1,
    "targetObject": "bytes32",
    "functionSelector": "bytes4",
    "callDataHash": "bytes32",
    "receiver": "bytes32"
  },
  "verification": {
    "verificationMethod": 3,
    "finality": {
      "model": 2,
      "confirmations": 1,
      "checkpointRoot": "bytes32",
      "epoch": 0,
      "committeePolicyHash": "bytes32"
    },
    "policyRef": {
      "policyType": 1,
      "policyHash": "bytes32"
    },
    "verifierProfileHash": "bytes32"
  },
  "payloadBinding": {
    "sourcePayloadHash": "bytes32",
    "businessPayloadHash": "bytes32"
  },
  "feedback": {
    "required": false,
    "expectedMsgType": 0,
    "timeout": 0,
    "callbackRefHash": "bytes32"
  },
  "atomicity": {
    "required": false,
    "mode": 0,
    "commitmentType": 0,
    "commitmentRefHash": "bytes32",
    "successActionHash": "bytes32",
    "failureActionHash": "bytes32",
    "challengeWindow": 0
  }
}
```

`hmsgDigest` 是 Canonical h-xmsg 的计算结果，不是 canonical 输入字段：

```text
hmsgDigest = H(canonicalHxmsg)
```

## 3. Canonical 字段含义

### header

| 字段 | 含义 |
| --- | --- |
| `version` | 协议版本 |
| `requestID` | 跨链请求全局标识 |
| `msgType` | 消息类型，例如 `CONTRACT_CALL`、`RESPONSE` |
| `nonce` | 源链侧序号 |
| `nonceScope` | nonce 作用域，避免不同账户、合约或业务域的 nonce 语义混淆 |
| `sourceTimestamp` | 源链事实中的时间戳，不应是链下 builder 随意生成时间 |
| `deliveryExpireAt` | 目标链最晚可接受执行的时间 |

### source / target

| 字段 | 含义 |
| --- | --- |
| `chainType` | 链技术类型，例如 EVM、Fabric、Cosmos |
| `chainID` | 共识域或账本域，例如 EVM chainId、Fabric channel |
| `domainID` | 应用域、跨链协议实例或子网域 |

Fabric 目标链中，`target.chainID` 绑定 channel，`targetAction.targetObject` 只绑定 chaincode 名称，避免把 channel 重复编码进 targetObject。

### sourceRef

| 字段 | 含义 |
| --- | --- |
| `refType` | 源链事实类型，例如 `EVM_RECEIPT`、`FABRIC_VIEW` |
| `refHash` | 源链事实引用的摘要 |

`encodedRef` 不属于 canonical h-xmsg，而是放在 envelope 中。TEE 验证时必须检查：

```text
H(encodedRef) == sourceRef.refHash
```

### targetAction

| 字段 | 含义 |
| --- | --- |
| `actionType` | 目标动作类型，例如 EVM contract call 或 Fabric chaincode invoke |
| `targetObject` | 目标对象，例如 EVM 合约地址或 Fabric chaincodeName 的 hash |
| `functionSelector` | 目标函数选择器 |
| `callDataHash` | 目标执行参数摘要 |
| `receiver` | 目标接收方或业务接收对象 |

### verification

| 字段 | 含义 |
| --- | --- |
| `verificationMethod` | TEE 采用的源链事实验证方法 |
| `finality.model` | 终局性模型 |
| `finality.confirmations` | 确认数要求 |
| `finality.checkpointRoot` | checkpoint / finalized root，未使用时为零 |
| `finality.epoch` | checkpoint 或 committee 所属 epoch，未使用时为零 |
| `finality.committeePolicyHash` | 区块头委员会或 sync committee 策略摘要 |
| `policyRef.policyType` | 策略类型 |
| `policyRef.policyHash` | 策略内容摘要 |
| `verifierProfileHash` | TEE verifier profile 摘要，绑定验证方法、证明格式和 verifier 版本 |

`policyID` 和 `adapterID` 不再是 canonical 字段。工程上仍可在 envelope/runtime 或 audit 中保存 adapterID 用于本地路由。

### payloadBinding

| 字段 | 含义 |
| --- | --- |
| `sourcePayloadHash` | 源链事实记录摘要 |
| `businessPayloadHash` | 完整业务语义摘要 |

`targetExecutionHash` 不再是 canonical 输入字段。它由 delivery 阶段根据 `requestID + target + targetAction` 派生。

### feedback

| 字段 | 含义 |
| --- | --- |
| `required` | 是否需要反馈 |
| `expectedMsgType` | 期望反馈类型 |
| `timeout` | 反馈截止时间或当前实现中的反馈时间参数 |
| `callbackRefHash` | 回调引用摘要 |

当前代码仍保留 `timeout` 字段名，以兼容已有挑战响应逻辑。协议语义上，它表示反馈策略中的时间约束。

### atomicity

| 字段 | 含义 |
| --- | --- |
| `required` | 是否启用原子性状态收束 |
| `mode` | 原子性模式，例如 commit-or-compensate |
| `commitmentType` | 承诺类型，例如 state lock、token escrow |
| `commitmentRefHash` | 源链承诺引用摘要 |
| `successActionHash` | 成功动作摘要 |
| `failureActionHash` | 失败补偿动作摘要 |
| `challengeWindow` | challenge 窗口 |

## 4. HxmsgEnvelope

`HxmsgEnvelope` 是链下传递给 TEE/relayer 的材料包。它不直接作为 `hmsgDigest` 的输入。

```json
{
  "hxmsg": "canonical h-xmsg",
  "sourceEvidence": {
    "encodedRef": "0x...",
    "sourceRecord": {},
    "proof": {},
    "helperData": {}
  },
  "executionData": {
    "callData": "0x...",
    "businessPayload": {},
    "compactCall": {}
  },
  "runtime": {
    "adapterID": "tee-adapter-xxx"
  },
  "auditRecord": {
    "txId": "0x...",
    "srcHeight": 0,
    "proofMeta": {}
  }
}
```

TEE 必须检查 envelope 与 canonical h-xmsg 的绑定关系：

```text
H(encodedRef) == sourceRef.refHash
H(callData) == targetAction.callDataHash
H(canonicalBusinessPayload) == payloadBinding.businessPayloadHash
```

`sourcePayloadHash` 的计算由不同源链 adapter 负责，因为 Fabric h-FSV 和 EVM receipt event 的源链记录规范不同。

## 5. DeliveryMessage

`DeliveryMessage` 是目标链最小执行消息。目标链不需要完整 canonical h-xmsg 和完整 proof，只需要 TEE quorum 认证过的 delivery 摘要。

```json
{
  "requestID": "bytes32",
  "hmsgDigest": "bytes32",
  "target": {},
  "targetAction": {},
  "callData": "0x...",
  "callDataHash": "bytes32",
  "targetExecutionHash": "bytes32",
  "feedback": {},
  "deliveryExpireAt": 0
}
```

其中：

```text
targetExecutionHash = H(requestID, target.chainID, targetAction.targetObject,
                        targetAction.functionSelector, targetAction.callDataHash,
                        targetAction.receiver)
```

TEE 面向 EVM 目标链时签名的是 `deliveryDigest`，而不是裸 `hmsgDigest`：

```text
deliveryDigest = H(hmsgDigest + target + targetAction + targetExecutionHash + feedback + deliveryExpireAt)
```

这样可以防止 relayer 拿一条 TEE 认证过的 h-xmsg 替换目标链执行字段。

## 6. 不变量

### feedback

```text
if feedback.required == false:
    expectedMsgType = NONE
    timeout = 0
    callbackRefHash = 0x00
```

### atomicity

```text
if atomicity.required == true:
    feedback.required = true
    feedback.expectedMsgType = RESPONSE
    failureActionHash != 0x00
    challengeWindow > 0

if atomicity.required == false:
    mode = NONE
    commitmentType = NONE
    commitmentRefHash = 0x00
    successActionHash = 0x00
    failureActionHash = 0x00
    challengeWindow = 0
```

### delivery

```text
H(callData) == targetAction.callDataHash
targetExecutionHash == H(requestID, target, targetAction)
TEE quorum signature verifies hmsgDigest or deliveryDigest
requestID has not been executed before
current time <= deliveryExpireAt
```

## 7. Fabric -> EVM

Fabric -> EVM 中：

```text
sourceRef.refType = FABRIC_VIEW
verification.verificationMethod = H_FSV
sourceEvidence.encodedRef = QueryCrosschainEvent(requestID) 引用
sourceEvidence.proof = Fabric View-like proof / peer signatures
executionData.callData = compact ABI calldata
executionData.businessPayload = 完整业务语义
DeliveryMessage 提交给 EVM gateway
```

TEE 检查 Fabric View-like 证明、背书策略、sourcePayloadHash、businessPayloadHash、callDataHash 和 feedback/atomicity 策略。

## 8. EVM -> Fabric

EVM -> Fabric 中：

```text
sourceRef.refType = EVM_RECEIPT
verification.verificationMethod = EVM_LIGHT_CLIENT
sourceEvidence.encodedRef = txHash / blockNumber / blockHash / logIndex / sourceContract
sourceEvidence.proof = receipt MPT proof + block header + committee/sync committee update
executionData.callData = Fabric invoke compact args
executionData.businessPayload = 完整业务语义
DeliveryMessage 由 Fabric chaincode 验证 TEE quorum 后执行
```

TEE 不直接相信 RPC 返回值，而是用 receipt MPT proof 对本地维护的可信区块头 `receiptsRoot` 验证交易存在性。

## 9. 当前兼容策略

为了不破坏现有测试和链上接口，当前代码仍保留部分 legacy 镜像字段，例如：

```text
sourceRef.encodedRef
callData
compactCall
callDataDecoded
txId
srcHeight
sourceRecord
payloadBinding.targetExecutionHash
```

这些字段不再被视为 canonical h-xmsg 的输入，而是 envelope、delivery 或 audit 数据的兼容镜像。后续如果所有调用点都切换为 `hxmsgEnvelope` 和 `deliveryMessage`，可以再删除这些 legacy 镜像字段。

## 10. 小结

重构后的 h-xmsg 设计可以概括为：

```text
Canonical h-xmsg 承诺安全语义。
HxmsgEnvelope 承载证明和执行材料。
DeliveryMessage 面向目标链最小执行。
AuditRecord 保存实验与审计信息。
```

这个结构减少了字段冗余，使论文中的协议描述更清楚，也降低了工程实现中误用未签名字段的风险。
