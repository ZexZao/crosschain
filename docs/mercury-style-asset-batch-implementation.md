# Mercury-style 资产批量执行优化

## 目标

本次修改只优化资产目标执行形式，不改变 canonical h-xmsg、源链事实证明、TEE Raft/quorum、目标链身份绑定或逐条防重放。

旧 EVM `token_transfer` 与 mint 操作共用 `mintSettlementCompact`，虽然真实改变了 token 余额，但没有扣减已有资产，不能称为转账。旧通用目标路径还为每条资产消息重复写入 `CompactBusinessRecord`、业务索引、操作计数、Settlement 和辅助映射。

## 实现

1. `CrossChainAssetService` 在部署时获得可配置的目标链流动性储备。
2. `token_transfer` 调用 ERC20 `transfer`，从服务储备扣款并给接收账户加款。
3. `asset_lock`、`mint_confirm`、`subsidy_confirm` 仍执行真实 mint，语义与 transfer 分离。
4. `HXMsgGateway` 仍逐条验证 h-xmsg、目标链、目标合约、callDataHash、过期时间和 `processed[requestID]`。
5. 一批调用全部属于资产类型时，Gateway 一次调用 `TargetContract.executeAssetBatch`。
6. 快速路径只保留逐条防重放状态、真实 ERC20 状态和资产事件，不重复写通用业务记录。
7. 混合业务批次继续走原通用路径，不影响应收账款、物流、授权、Oracle 和审批消息。

流动性储备由 `INITIAL_ASSET_RESERVE_UNITS` 配置，默认值只用于本地和实验部署。生产部署应由资产发行/锁定协议确定储备来源，不能任意初始化无担保资产。

## 安全边界

- batch certificate 仍绑定 batchID、batchRoot、batchSize 和目标链 ID。
- 每条 batch leaf 仍绑定 requestID、hmsgDigest 和 delivery digest。
- 每条调用仍验证 callDataHash，relayer 无法替换接收人或金额。
- 每条消息的 selector 必须是受支持的 `executeCompact`；Gateway 只把语义相同的纯资产调用合并为受控 multicall，不能把任意 selector 重定向到资产批处理。
- `processed[requestID]` 没有删除，目标链仍独立防重放。
- 只有 Gateway 能调用 TargetContract，只有 TargetContract 能调用资产服务。
- 删除的是可由事件恢复的重复审计 storage，不是 token 余额、TEE 验签或证明绑定。

## 实测结果

测试均排除一次性 TEE 注册 gas。

| 实验 | 批大小 | 源 gas/message | 目标 batch gas | 目标 gas/message | 正常路径合计 |
|---|---:|---:|---:|---:|---:|
| Avalanche -> Ethereum 优化前 | 20 | 113,669 | 9,828,134 | 491,407 | 605,076 |
| Avalanche -> Ethereum 优化后 | 20 | 114,528 | 1,207,753 | 60,388 | 174,916 |
| Ethereum -> Avalanche 优化后 | 8 | 40,875 | 553,376 | 69,172 | 110,047 |
| Avalanche -> Ethereum 优化后 | 8 | 113,667 | 519,328 | 64,916 | 178,583 |
| Ethereum -> Avalanche 空壳修复后稳态复测 | 8 | 38,737 | 520,328 | 65,041 | 103,778 |
| Avalanche -> Ethereum 空壳修复后稳态复测 | 8 | 113,667 | 520,320 | 65,040 | 178,707 |

batch=20 的目标执行平均 gas 下降 87.71%，正常路径总 gas 下降 71.09%。目标 reserve 从 `10000000000000` 减少到 `9999996600000`，接收账户从 `0` 增加到 `3400000`，金额完全一致。

response-required 单条路径也改用相同 compact/batch 入口。实测 reserve 减少 `210000`，接收账户增加 `210000`，不计注册的 source、target、response complete 三段总计 `455726 gas`。

2026-08-03 在补全非资产 compact 领域动作后重新执行纯 `token_transfer`。全新部署的第一轮目标平均约为 `69,315 gas/message`，同一部署上的稳态轮次回落到约 `65,041 gas/message`；差异来自首个接收账户余额由零变为非零的 ERC20 `SSTORE`，不是 TEE 注册成本。与修复前稳态结果相比，Avalanche -> Ethereum 目标仅增加 `124 gas/message`（约 `0.19%`），说明非资产领域修复没有实质增加资产快速路径成本。

## 结果文件

- `runtime/mercury-style-avax-evm-batch20-gas.json`
- `runtime/mercury-style-avax-evm-batch20-gas-optimized.json`
- `runtime/local-evm-avalanche-asset-transfer-batch-results.json`
- `runtime/local-evm-avalanche-asset-transfer-batch-steady-results.json`
- `runtime/local-evm-avalanche-response-gas-results.json`

## 尚未解决

当前 reserve transfer 对应 Mercury vault 向目标接收方结算的模型，并非同一目标链上任意用户 A 向 B 的授权转账。若论文要研究任意账户转账，还需要引入用户授权、permit 或预存款模型，并单独评估其安全性和 gas。

项目目前也没有 Mercury 的 `UpdateCheckpoint`。普通无状态源消息无需清理，但 response-required 生命周期记录仍需要后续设计批量 checkpoint/归档机制。
