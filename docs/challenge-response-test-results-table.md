# 挑战响应测试结果汇总表

更新时间：2026-05-25T10:28:29.415Z

## 1. EVM 源端状态机测试

| 用例编号 | 测试内容 | 最终状态 | 是否通过 | 耗时(ms) | submitHXMsgRequest Gas | startChallenge Gas | completeWithResponse Gas | compensateAfterChallenge Gas | 总 Gas |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| CR-EVM-001 | Pending -> Completed | 3 | PASS | 15 | 367624 | - | 81979 | - | 449603 |
| CR-EVM-002 | Pending -> Challenged -> Completed | 3 | PASS | 15 | 350536 | 32504 | 82115 | - | 465155 |
| CR-EVM-003 | Pending -> Challenged -> Compensated | 4 | PASS | 11 | 350536 | 32504 | - | 33839 | 416879 |
| CR-EVM-004 | insufficient TEE quorum rejected | - | PASS | 11 | 350512 | - | reverted | - | 350512 |
| CR-EVM-005 | late RESPONSE after compensation rejected | - | PASS | 14 | 350524 | 32504 | rejected | 33839 | 416867 |

状态说明：`3 = Completed`，`4 = Compensated`。

状态机测试汇总：

| 测试类型 | 用例数 | 通过 | 失败 | 总耗时(ms) | 累计 Gas |
|---|---:|---:|---:|---:|---:|
| EVM challenge-response state machine | 5 | 5 | 0 | 386 | 2099016 |

## 2. 双向端到端闭环测试

| 方向 | 测试内容 | 是否通过 | RequestID | 源链交易 | 目标链交易 | TEE Quorum | 总耗时(ms) | EVM Gas | Fabric Gas |
|---|---|---|---|---|---|---:|---:|---:|---|
| Fabric -> EVM | h-FSV view -> TEE h-xmsg quorum -> EVM 执行 -> EVM receipt proof -> TEE RESPONSE quorum -> Fabric Completed | PASS | `0x4657fab404efce9fbbc7789391558a6b922b4722a3eff18509281ba209e0e271` | Fabric tx `967e751945bf4e7db4d57a296f492864aad6ff61c60d7c52d7b6296dbf254074` | EVM tx `0x20c3a6abd33ef23559367b36509def09eaca5e5a8d733502bad4c1b204e8e915` | 4/3 | 23914 | 127753 | N/A |
| EVM -> Fabric | EVM receipt MPT proof -> TEE h-xmsg quorum -> Fabric ExecuteHXMsg -> Fabric execution record -> TEE RESPONSE quorum -> EVM Completed | PASS | `0x3981ba28c732040ab4f57f3e81d9c6e973a8532910607b530204ecafbcd045ad` | EVM tx `0x0c37dcb71d8357f0c0aa7a08c03bbf5c4f160d05accd435a1b9910cb2b586ddc` | Fabric tx `f9a3236f45003f91b4f66e40be88875ae59f8ad39ea9db8088ec8f5d993222bf` | 4/3 | 11155 | 455579 | N/A |

说明：Hyperledger Fabric 交易不使用 EVM gas，因此 Fabric Gas 记为 `N/A`。端到端测试中的 `EVM Gas` 只统计路径中实际发生的 EVM 链上交易。

## 3. 端到端阶段耗时

### Fabric -> EVM

| 阶段 | 耗时(ms) |
|---|---:|
| resolveTeeLeader | 11 |
| fabricEmitXCall | 2139 |
| fabricQueryBlock | 5 |
| fabricQueryCrosschainEvent | 6 |
| teeAttestHXMsg | 332 |
| evmTargetExecution | 120 |
| fabricRegisterTEE | 8359 |
| fabricBindCommitmentHXMsg | 2116 |
| evmGetTargetReceipt | 14 |
| buildEvmReceiptProof | 28 |
| teeAttestResponse | 105 |
| fabricRegisterResponseTEE | 8388 |
| fabricCompleteWithResponse | 2086 |
| fabricQueryCommitment | 6 |

### EVM -> Fabric

| 阶段 | 耗时(ms) |
|---|---:|
| resolveTeeLeader | 11 |
| evmSubmitAtomicRequest | 122 |
| evmGetSourceBlock | 12 |
| buildEvmReceiptProof | 28 |
| teeAttestHXMsg | 100 |
| fabricRegisterTEE | 8415 |
| fabricExecuteHXMsg | 2097 |
| fabricGetInboundStatus | 6 |
| teeAttestResponse | 36 |
| evmCompleteWithResponse | 109 |

## 4. 结果文件

| 文件 | 内容 |
|---|---|
| `runtime/hxmsg-challenge-response-results.json` | EVM 状态机测试完整 JSON 结果 |
| `runtime/hxmsg-challenge-response-summary.md` | EVM 状态机测试摘要 |
| `runtime/hxmsg-fabric-evm-challenge-e2e-results.json` | Fabric -> EVM 端到端闭环完整 JSON 结果 |
| `runtime/hxmsg-fabric-evm-challenge-e2e-summary.md` | Fabric -> EVM 端到端闭环摘要 |
| `runtime/hxmsg-evm-fabric-challenge-e2e-results.json` | EVM -> Fabric 端到端闭环完整 JSON 结果 |
| `runtime/hxmsg-evm-fabric-challenge-e2e-summary.md` | EVM -> Fabric 端到端闭环摘要 |
