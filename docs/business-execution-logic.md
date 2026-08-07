# Business Execution Logic

Date: 2026-05-29

本文档说明当前项目如何从“跨链消息被记录”升级为“目标链真实执行业务状态变更”，并进一步支持资产类场景中的真实锁定、发放和退款。

## 1. 设计原则

业务执行层不改变跨链可信验证路径：

```text
h-xmsg -> TEE source fact verification -> TEE quorum -> target gateway / chaincode -> business executor
```

h-xmsg、h-FSV、MELV-EF、TEE Raft quorum、challenge-response 状态机仍然是协议层。业务逻辑只发生在目标链已经验证 TEE quorum 和目标绑定之后。

## 2. 统一业务 payload

当前跨链业务 payload 由 `shared/xmsg.js` 规范化为：

```text
op
recordId
actor
amount
metadata
requireAck
```

其中 `metadata` 保存原始业务 payload 的 JSON 字符串，目标链业务执行器会记录 `metadataHash`，避免在链上重复解析所有行业字段。

## 3. EVM 目标链业务执行

`contracts/TargetContract.sol` 已从轻量记录合约升级为业务路由器。真实业务动作由 `contracts/BusinessServiceContracts.sol` 中的分类服务合约执行。

执行入口仍然是：

```solidity
execute(bytes32 requestID, bytes calldata payload)
```

只有 `HXMsgGateway` 可以调用该入口。合约会：

1. ABI 解码业务 payload。
2. 根据 `op` 分发到对应业务服务合约。
3. 业务服务执行真实动作，例如 mint token、登记应收账款、更新 oracle feed。
4. `TargetContract` 记录服务地址、业务状态和索引，作为审计入口。
5. 发出 `BusinessActionApplied` 事件。

可查询接口：

```solidity
getBusinessRecord(bytes32 requestID)
getBusinessRecordByKey(string op, string recordId)
```

同时，`TargetContract` 会在构造时部署实验 ERC20：

```text
CrossChainToken name = CrossChain Settlement Token
symbol = XCST
decimals = 4
```

当前 EVM 目标侧业务分类：

| 分类 | op | 服务合约 | 真实动作 |
|---|---|---|---|
| 资产结算 | `asset_lock`, `mint_confirm`, `subsidy_confirm` | `CrossChainAssetService` | 给目标 EVM 地址真实 mint `CrossChainToken` |
| 储备转账 | `token_transfer` | `CrossChainAssetService` | 从目标链预置储备真实调用 ERC20 `transfer` |
| 应收账款 | `receivable_attest` | `ReceivableRegistryService` | 登记应收账款、金额、供应商和证明哈希 |
| 物流状态 | `logistics_sync` | `LogisticsTrackerService` | 更新 waybill 读数和检查方 |
| 授权许可 | `medical_consent` | `ConsentRegistryService` | 创建带到期时间的 consent grant |
| Oracle | `oracle_update` | `OracleFeedService` | 更新 feed 最新价格轮次 |
| 多方审批 | `approval_commit` | `ApprovalWorkflowService` | 登记审批人、阈值和通过结果 |

资产类 op 不再接受非 EVM 地址作为接收方；测试脚本会在构造 payload 时填入可验证的目标地址。因此“转账/发放”不是状态文字变化，而是 ERC20 balance 的真实变化。

compact 路径不会只写 `CompactBusinessRecord`。应收账款、物流、授权、Oracle 和审批分别调用对应服务的 compact 方法，并写入：

```text
compactReceivables[requestID]
compactWaybills[requestID]
compactConsents[requestID]
compactLatestRound[feedIdHash]
compactDecisions[requestID]
```

这些记录保存 h-xmsg 已绑定的 `recordIdHash / actorHash / amount / metadataHash`，既避免恢复链下明文，也形成可由其他合约消费的领域状态。

可查询：

```text
TargetContract.token()
TargetContract.assetAmountByRequest(requestID)
TargetContract.assetRecipientByRequest(requestID)
CrossChainToken.balanceOf(account)
```

## 4. Fabric 目标链业务执行

`fabric-chaincode/xcall/index.js` 中的 `ExecuteHXMsg` 在验证 h-xmsg、TEE quorum、防重放、目标绑定后，会调用 Fabric 侧业务服务分发逻辑。

链码会写入：

```text
business:{op}:{recordId}
businessByRequest:{requestID}
businessOp:{op}:{requestID}
```

并保留已有的：

```text
hxmsg-consumed:{requestID}
crosschainExec:{requestID}
inbound:{requestID}
```

新增查询接口：

```text
QueryBusinessRecord(op, recordId)
QueryBusinessRecordByRequest(requestID)
```

当前 Fabric 目标侧业务分类：

| 分类 | op | Fabric 状态键 | 真实动作 |
|---|---|---|---|
| 资产入账 | `asset_lock`, `mint_confirm`, `subsidy_confirm` | `fabricSettlement:{recordId}` | 给目标 Fabric 账户真实增加 `assetBalance` |
| Fabric 内部转账 | `token_transfer` | `fabricTransfer:{recordId}` | 从 `from` 扣款并给 `to` 加款 |
| 应收账款 | `receivable_attest` | `receivable:{recordId}` | 登记应收账款证明 |
| 物流状态 | `logistics_sync` | `logistics:{recordId}` | 更新 waybill 状态 |
| 授权许可 | `medical_consent` | `consent:{recordId}` | 创建带到期时间的授权记录 |
| Oracle | `oracle_update` | `oracle:{recordId}` | 更新 feed 价格 |
| 多方审批 | `approval_commit` | `approval:{recordId}` | 登记审批阈值和通过结果 |

## 5. Fabric 资产锁定和退款

Fabric 链码新增真实资产账本和 escrow：

```text
assetBalance:{assetType}:{account}
assetEscrow:{requestID}
```

新增接口：

```text
InitAssetBalance(account, assetType, amount)
QueryAssetBalance(account, assetType)
LockAssetXCall(payloadJson)
QueryAssetEscrow(requestID)
RefundAssetEscrow(requestID)
```

`LockAssetXCall` 会真实执行：

1. 检查 Fabric 账户余额。
2. 扣减 owner 的可用余额。
3. 创建 `assetEscrow:{requestID}`。
4. 写入 `crosschainEvents:{requestID}`，使该锁定事实进入 h-FSV view。
5. 后续 TEE 按 h-FSV 验证该跨链请求。

`RefundAssetEscrow` 会真实执行：

1. 检查 escrow 存在且状态为 `Locked`。
2. 将 escrow 中的 `amountUnits` 加回 owner 余额。
3. 将 escrow 状态改为 `Refunded`。

当前退款已经接入 challenge timeout 的补偿分发。`CompensateAfterChallenge` 在发现 commitment type 为 `TOKEN_ESCROW` 时，会自动调用内部 escrow refund handler，恢复 owner 余额，并把 commitment 标记为 `Compensated`。

## 6. EVM token escrow and refund

`contracts/EvmSourceContract.sol` 新增 EVM 源链 token escrow：

```text
submitTokenEscrowHXMsgRequest(...)
tokenEscrows:{requestID}
```

流程：

1. 用户先 `approve(EvmSourceContract, amount)`。
2. 用户调用 `submitTokenEscrowHXMsgRequest`。
3. EVM 源合约真实 `transferFrom(user, sourceContract, amount)`。
4. 若目标链 RESPONSE 按时返回，请求可进入 `Completed`。
5. `TOKEN_ESCROW` 同时标记为 `settled`，资产继续锁在源链合约中作为目标链资产支撑，并永久退出退款路径。
6. 若 feedback timeout 后进入 challenge，且 challenge window 结束仍无 RESPONSE，则 `compensateAfterChallenge` 自动识别 `TOKEN_ESCROW`。
7. 源合约真实 `transfer(user, amount)` 退回 token，并把 escrow 标记为 `refunded`。

## 7. 测试变化

Fabric -> EVM 主线测试现在不再只检查：

```text
lastRequestID
lastPayloadHash
```

还会检查 EVM 目标合约中的业务状态：

```text
requestID
op
recordId
actor
amount
status
updatedAt
```

EVM -> Fabric 主线测试现在会检查 Fabric 链码中的业务记录：

```text
businessByRequest:{requestID}
```

并要求业务 `op / recordId / actor / amount / status` 与 inbound 执行记录一致。

新增真实资产测试：

```bash
npm run hxmsg:test:asset
```

该测试覆盖：

1. Fabric `InitAssetBalance` 初始化余额。
2. Fabric `LockAssetXCall` 真实扣减余额并写入 escrow。
3. TEE 通过 h-FSV 验证该跨链请求。
4. EVM `TargetContract` 真实 mint `CrossChainToken` 给目标地址。
5. Fabric `CompensateAfterChallenge` 在 timeout 后自动分发到 escrow refund handler，将另一笔 escrow 退回 owner。

EVM challenge-response 状态机测试新增：

```text
CR-EVM-006 TOKEN_ESCROW timeout -> ERC20 refund
CR-EVM-007 TOKEN_ESCROW RESPONSE -> permanent source lock settlement
```

该用例证明 EVM 源合约真实锁定 ERC20，并在 challenge timeout 后自动退回。

结果文件：

```text
runtime/real-asset-transfer-refund-results.json
runtime/real-asset-transfer-refund-summary.md
```

## 8. 当前边界

当前实现已经让 full/compact 测试用例中的业务动作在目标链形成领域状态，并让资产类实验具备真实锁定、发放、成功结算和自动退款。但仍有以下边界：

- 尚未实现可插拔 handler registry，当前分发逻辑按 `op` 和 `commitmentType` 内置处理。
- 成功 RESPONSE 当前采用 lock-and-mint 的永久锁仓结算；生产环境仍需设计独立 vault、储备审计和治理迁移规则。
- 当前补偿闭环只对具有真实 escrow 的 `TOKEN_ESCROW` 执行退款；授权撤销、Oracle 回滚等业务必须先定义前状态和可逆资源，不能用通用状态翻转冒充补偿。

后续如果要让补偿也具备通用业务执行能力，应增加：

```text
CompensationManager
ICompensationHandler
commitmentType -> handler
```

这样协议层负责 deadline、challenge、quorum 和防重放，业务 handler 负责具体补偿动作。
