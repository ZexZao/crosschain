# Avalanche 接入 h-xmsg 方案

## 目标

将 Avalanche C-Chain / Avalanche L1 融入当前 h-xmsg 跨链系统，用来体现系统可以兼容不同证明模型的异构区块链。

Avalanche 的接入不应把它简单当作普通 EVM 链，也不应把 Avalanche 验证抽象成项目自定义的全局验证者集合签名。推荐方式是新增一种源链验证 profile：

```text
AvalancheICM-BLS
```

该 profile 由 TEE adapter 验证 Avalanche Warp / ICM message、签名者位图、P-Chain 高度下的 validator set、签名者权重和 BLS aggregate signature，再输出当前项目统一使用的 TEE quorum certification。

## 设计结论

Avalanche 可以接入当前 h-xmsg，不需要改变 h-xmsg 的核心结构。

当前项目的 canonical h-xmsg 仍保持：

```text
header
source
target
sourceRef
targetAction
verification
payloadBinding
feedback
atomicity
```

Avalanche 特有材料不应直接塞进 h-xmsg 顶层，而应放入：

```text
hxmsgEnvelope.sourceEvidence
helperData
```

并通过下列哈希字段绑定进 canonical h-xmsg：

```text
sourceRef.refHash
payloadBinding.sourcePayloadHash
payloadBinding.businessPayloadHash
payloadBinding.targetExecutionHash
verification.policyRef.policyHash
verification.verifierProfileHash
```

这样目标链仍然只需要验证 h-xmsg minimal delivery 和 TEE quorum certification，不需要理解 Avalanche P-Chain、signer bitmap 或 BLS 聚合签名。

## h-xmsg 字段映射

建议新增枚举：

```text
ChainType.AVALANCHE
RefType.AVALANCHE_WARP_MESSAGE
VerificationMethod.AVALANCHE_ICM_BLS
PolicyType.AVALANCHE_VALIDATOR_SET
```

Avalanche 作为源链时，h-xmsg 字段建议映射如下：

| h-xmsg 字段 | Avalanche 含义 |
|---|---|
| `source.chainType` | `AVALANCHE` |
| `source.chainID` | Avalanche `blockchainID` 的 bytes32/hash 表示 |
| `source.domainID` | `networkID + subnetID/l1ID` 的 domain hash |
| `sourceRef.refType` | `AVALANCHE_WARP_MESSAGE` |
| `sourceRef.refHash` | unsigned Warp message / messageID / source proof summary 的 hash |
| `verification.verificationMethod` | `AVALANCHE_ICM_BLS` |
| `verification.finality.model` | `APPLICATION`，或后续新增 `WEIGHTED_SIGNATURE` |
| `verification.policyRef.policyHash` | validator set ref、quorum rule、canonical ordering 的 hash |
| `verification.verifierProfileHash` | `hash("AvalancheICM-BLS/V1")` |
| `payloadBinding.sourcePayloadHash` | TEE 可重算的 Avalanche source record hash |
| `payloadBinding.businessPayloadHash` | 规范化业务 payload hash |
| `payloadBinding.targetExecutionHash` | 目标链、目标对象、函数、参数 hash 的绑定 |

## Avalanche 证明材料

TEE adapter 输入应包含：

```text
unsignedWarpMessage
warpMessageID
aggregateSignature
signerBitmap
validatorSetRef
validatorSetSnapshot 或 P-Chain validator-set proof
networkID
blockchainID
subnetID/l1ID
quorumNumerator/quorumDenominator
```

这些材料不应进入目标链 calldata，也不应成为目标链必须理解的结构。

## TEE 验证流程

TEE 的 Avalanche adapter 应执行：

1. 检查 h-xmsg 指定的 `ChainType.AVALANCHE` 和 `VerificationMethod.AVALANCHE_ICM_BLS`。
2. 解析 `unsignedWarpMessage`。
3. 重新计算 `unsignedWarpMessageHash` 和 `warpMessageID`。
4. 检查 `source.chainID`、`source.domainID`、`networkID`、`blockchainID`、`subnetID/l1ID` 一致。
5. 根据 `validatorSetRef` 获取或验证 P-Chain 高度下的 validator set。
6. 按确定的 canonical ordering 解释 `signerBitmap`。
7. 计算 signer weight，检查是否达到 quorum。
8. 聚合或选择 signer public keys，验证 BLS aggregate signature。
9. 从 Warp / ICM message payload 中解析业务绑定内容。
10. 重算并检查：
    - `sourcePayloadHash`
    - `businessPayloadHash`
    - `targetExecutionHash`
    - `targetObject`
    - `targetAction`
    - `destinationDomain`
    - `nonce`
    - `expiry`
11. 验证通过后，TEE 子网形成当前项目统一的 `ECDSA_QUORUM_V1` quorum certification。

## 防自洽伪造要求

攻击者可能伪造一套内部自洽的：

```text
h-xmsg
payload hash
sourcePayloadHash
targetExecutionHash
unsignedWarpMessageHash
signatureProof
```

TEE 不能只检查这些字段彼此一致。TEE 必须以 Avalanche validator set 对 `unsignedWarpMessage` 的真实签名为源链事实锚点。

因此，TEE 必须满足：

```text
Avalanche signed Warp/ICM message
    -> TEE 解析真实 signed payload
    -> TEE 重算 h-xmsg 绑定字段
    -> 与 relayer 提供的 h-xmsg 比较
```

只要攻击者不能获得足够权重 Avalanche validators 对篡改后 message 的签名，自洽伪造材料就会被 TEE 拒绝。

## 与普通 C-Chain 事件的边界

普通 Avalanche C-Chain 合约 event 不能直接声称拥有 Avalanche ICM BLS 证明。

有两种合法路径：

1. 源合约显式发送 Warp / ICM message，TEE 使用 `AvalancheICM-BLS` profile 验证。
2. 不使用 ICM 时，把 Avalanche C-Chain 当作 EVM 兼容链，走 EVM receipt / log proof 路径。

论文中应避免表述为“所有 Avalanche C-Chain event 都天然带有 validator BLS signature”。

## 对现有项目结构的影响

不需要大幅调整现有结构。建议新增：

```text
hxmsg-builder/source-builders/avalanche.js
tee-verifier/adapters/avalanche-icm-adapter.js
shared/avalanche/warp-message.js
shared/avalanche/validator-set.js
scripts/run-avalanche-evm-tests.js
scripts/run-avalanche-fabric-tests.js
```

需要扩展：

```text
shared/hxmsg/constants.js
tee-verifier/adapters/index.js
TEE registry / subnet routing policy
```

现有 EVM/Fabric builder、adapter 和目标链 gateway/chaincode 不需要推倒重构。

## 现有源链合约是否需要修改

现有 Ethereum/Fabric 源链合约一般不需要为 Avalanche 修改。

原因是当前源链合约已经通过下列字段表达跨链目标和业务绑定：

```text
targetChainID
targetDomainID
targetObject
functionSelector
callDataHash
businessPayloadHash
receiver
feedback/atomicity policy
```

如果 Avalanche 作为目标链，只需要部署兼容的目标合约或目标执行入口，并配置新的 chainID/domainID。

如果 Avalanche 作为源链，则需要新增 Avalanche 源合约或 ICM/Warp 发送逻辑。这个新增逻辑负责把 h-xmsg 业务绑定内容放入 Warp / ICM message，使 Avalanche validators 实际签名该绑定。

## 原型阶段与论文阶段

原型阶段可以先由 relayer 提供 validator set snapshot，TEE 检查：

```text
validatorSetHash
signerBitmap
signedWeight
aggregateSignature
payloadBinding
```

但论文安全论证中必须说明：如果 TEE 直接信任外部 RPC 返回的 validator set，安全性会依赖 RPC 正确性。

更严谨路线是：

1. TEE 维护 P-Chain checkpoint。
2. relayer 提供 validator set proof 或 authenticated snapshot。
3. TEE 根据 P-Chain 状态验证指定高度下的 validator set。
4. TEE 缓存 validator set hash，降低重复验证成本。

## 推荐实施阶段

| 阶段 | 内容 | 目标 |
|---|---|---|
| Phase 1 | 新增 Avalanche source builder 和 TEE adapter，使用 RPC/snapshot 原型验证 | 打通 Avalanche -> EVM/Fabric |
| Phase 2 | 引入 validatorSetHash 缓存和 replay cache | 降低 TEE 重复开销 |
| Phase 3 | 加入 P-Chain checkpoint / authenticated validator set proof | 减少对 RPC 的信任 |
| Phase 4 | 配合 TEE 子网 registry，把 Avalanche 验证迁移到专用 TEE subnet | 适配真实 TEE 资源限制 |

## 结论

Avalanche 接入当前项目是合理的，且能增强论文中“异构证明模型统一承载”的贡献点。

关键约束是：

```text
Avalanche 特有证明材料进入 adapter/helperData
canonical h-xmsg 只保存可哈希绑定的通用字段
TEE 以真实 signed Warp/ICM message 为事实锚点
目标链只验证授权 TEE subnet 给出的 quorum certification
```

