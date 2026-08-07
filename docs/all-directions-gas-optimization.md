# 三链六方向 Gas 优化实现

## 优化范围

本轮覆盖 Ethereum、Hyperledger Fabric、Avalanche 三条链形成的六个有向方向。所有方向继续传输 canonical h-xmsg 的链下完整语义；目标链只接收经 TEE 验证并由 `hmsgDigest` 绑定的 minimal/compact delivery。

主要改动：

1. `HXMsgGateway` 部署时固定本链类型。Ethereum 使用 `ChainType.EVM=1`，Avalanche 使用 `ChainType.AVALANCHE=3`，避免把 Avalanche 伪装成普通 EVM 目标。
2. EVM-compatible 目标链增加 compact batch 执行。目标链重新计算 batch Merkle root，一次验证 TEE quorum certificate，再逐条执行业务动作。
3. Ethereum -> Avalanche 和 Avalanche -> Ethereum 改为 `CompactCall`，不再向目标链提交字符串业务 ABI。
4. Fabric -> Avalanche 复用真实 h-FSV、Fabric TEE 子网和 compact batch gateway。
5. Avalanche -> Fabric 使用真实 AvalancheGo Warp message、5 validator 权重签名、Avalanche TEE batch certificate 和 Fabric compact execution。
6. 删除使用固定 validator set 和随机聚合签名的旧 `run-avalanche-crosschain-tests.js` 模拟路径。
7. Fabric h-FSV adapter 新增源链状态中的 `targetChainType/targetChainID` 与 canonical h-xmsg 的交叉绑定检查。
8. `EvmSourceContract` 采用按策略分层存储：普通单向消息的事实字段只进入 `CrossChainCallRequested` event，需要反馈或原子性的消息才保存紧凑生命周期记录。
9. `TEERegistry` 只遍历证书 signer bitmap 的有效长度，不再固定扫描 256 个 signer 位；门限、参与者集合和每个 ECDSA 签名仍逐一验证。

## 本地结果

测试时间：2026-08-03。TEE 批大小均为 8；TEE 注册 gas 单独统计，不计入稳定态每消息 gas。

| 方向 | 用例 | 结果 | 源链 gas/message | 目标链 batch gas | 目标 gas/message |
|---|---:|---:|---:|---:|---:|
| Fabric -> Ethereum | 8 | 8/8 | N/A | 3,861,604 | 482,701 |
| Ethereum -> Fabric | 8 | 8/8 | 41,500 | N/A | N/A |
| Fabric -> Avalanche | 8 | 8/8 | N/A | 2,975,245 | 371,906 |
| Avalanche -> Fabric | 8 | 8/8 | 114,075 | N/A | N/A |
| Ethereum -> Avalanche | 8 | 8/8 | 40,872 | 3,269,152 | 408,644 |
| Avalanche -> Ethereum | 8 | 8/8 | 115,801 | 3,269,184 | 408,648 |

Fabric 不采用 gas 计费，因此 Fabric 目标方向记录执行时间、TEE quorum 和业务状态变化，不伪造 gas 数值。普通 Ethereum 源请求不再为事件中已有的事实字段重复支付持久化写入成本；需要反馈或原子性的请求仍保留完整状态机所需数据。

2026-08-03 的后续审计发现，旧 EVM compact opCode 3-7 只返回状态哈希。该路径现已改为写入五个领域服务的真实状态，因此 Fabric -> Ethereum 的最新可发表口径由 `394,556` 上调为 `482,701 gas/message`。表中其余以 EVM-compatible 链为目标的混合业务结果是在该修复前采集的历史值，必须重跑后才能作为最终论文数据；纯资产批量结果不受该问题影响。

## 与优化前对比

Ethereum/Avalanche 旧单消息目标执行约为 725,000 到 848,000 gas/message。本轮批大小 8 后：

- Ethereum -> Avalanche 目标平均为 413,805 gas/message。
- Avalanche -> Ethereum 目标平均为 362,153 gas/message。
- Avalanche 源请求使用 compact Warp payload 后约为 113,664 gas/message，旧结果约为 127,000 gas/message。
- Ethereum 普通源请求从约 291,000-294,000 gas/message 降至约 40,000-42,000 gas/message，下降约 86%。

下降主要来自：批次只验证一次 3/5 ECDSA quorum、只支付一次交易基础成本、使用固定宽度 `CompactCall`、省去重复动态字符串 calldata，以及普通 EVM 源消息不再把 event 中已有的 19 字段请求记录复制到 storage。

## 源链分层存储的安全边界

普通单向消息没有后续状态迁移，因此链上只保留 canonical `CrossChainCallRequested` event。TEE 仍必须用本地区块头验证 receipt MPT proof，再从已证明的 receipt log 提取 `requestID`、目标链、调用哈希、反馈策略哈希和原子性哈希；链下 relayer 自行构造的自洽数据不能替代该事实。

需要 response、challenge 或 compensation 的消息继续保存：

- `targetExecutionHash`，用于把响应绑定到原目标执行；
- `failureActionHash`，用于验证补偿参数；
- feedback timeout、challenge window/deadline；
- commitment type 和生命周期状态。

挑战状态机 `7/7` 回归通过，包括真实 ERC-20 escrow 锁定与退款、成功 RESPONSE 后永久锁仓结算、quorum 不足拒绝和补偿后迟到响应拒绝。

## 两两启动

```bash
npm run pair:up -- evm-fabric
npm run pair:up -- evm-avalanche
npm run pair:up -- fabric-avalanche
npm run pair:down
```

编排脚本只停止容器和本地 Avalanche 网络，不删除 Fabric volume。每组实验只启动两条链和对应的两个 5 节点 TEE 子网。

## 保留成本

优化没有删除防重放写入、目标业务状态写入、TEE 注册、源链事实证明或完整 h-xmsg 的 digest 绑定。目标链 gas 的下限仍由真实业务动作、`processed[requestID]`、目标状态写入和 TEE quorum 验证构成。
