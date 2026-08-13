# 当前代码路径与旧实现清理审计

## 1. 审计结论

当前跨链业务实验已经统一经过 `automation/`：源链 scanner、持久 cursor、finality、proof builder、TEE quorum、目标提交和 Watcher 策略登记构成唯一端到端主线。Sepolia 四方向脚本及单方向包装脚本也调用同一 Automation 实现，不再维护第二套 Sepolia relay。

专项测试允许直接访问被测边界，但不属于业务投递路径：

- `run-hxmsg-forgery-attack-tests.js` 直接调用 `/attest`，用于确认 TEE 拒绝自洽伪造材料。
- `run-raft-cluster-tests.js` 调用 Raft 内部接口，专门测试选举、复制和故障恢复。
- `run-challenge-response-tests.js` 与 `run-lifecycle-checkpoint-tests.js` 是合约状态机级回归，不声称经过 Relayer/Watcher E2E。
- `run-sepolia-sync-committee-check.js` 只验证 light-client 数据，不发送跨链业务交易。

## 2. 当前唯一业务路径

```text
Source contract/chaincode event
  -> chain adapter scanner + persistent cursor
  -> Relayer finality worker
  -> chain-specific proof builder
  -> canonical h-xmsg + compact execution material
  -> source-chain TEE subnet / Raft commit / ECDSA quorum certificate
  -> target submitter
  -> compact gateway or Fabric chaincode
  -> real target business action
  -> Watcher lifecycle registration
  -> optional RESPONSE or challenge/compensation
```

EVM-compatible 目标链只保留：

- `executeHXMsgMinimalCompactCluster`：单消息强类型 compact 投递。
- `executeHXMsgMinimalCompactBatchCluster`：目标链重算 batch root 的通用 compact 批次。
- `executeFabricEVMCompactBatchCluster`：Fabric 源消息的紧凑批次。

Fabric 目标链只保留：

- `ExecuteHXMsgCompact`：单消息 minimal delivery。
- `ExecuteHXMsgCompactBatch`：TEE 批签名投递。

## 3. 已删除代码

### 3.1 旧实验驱动

- `scripts/run-asset-transfer-refund-tests.js`
- `scripts/run-avalanche-local-source-smoke.js`
- `scripts/run-avalanche-response-lifecycle-test.js`
- `scripts/run-evm-fabric-challenge-e2e.js`
- `scripts/run-fabric-evm-challenge-e2e.js`
- `scripts/request-evm-fabric-call.js`
- `fabric-network/scripts/invoke-xcall.sh`

前五个脚本自行完成证明、TEE 调用或目标提交，已经被 Automation E2E、Watcher escrow 测试和 atomic batch 测试覆盖。后两个脚本只创建源链事件却不发布内容材料，会使 Automation 永久停在 `WAITING_MATERIAL`，因此也不再作为有效入口保留。

### 3.2 旧链上入口

- EVM Gateway 动态 `bytes callData` 单消息入口。
- EVM Gateway 动态 payload 批次入口。
- EVM-compatible 批次中携带 `bytes32[][] merkleProofs` 的兼容重载。
- `TargetContract.execute(bytes32,bytes)` 及字符串 ABI 业务分发。
- 领域服务合约的字符串版业务写入函数和重复状态结构。
- Fabric `ExecuteHXMsg` 完整动态 h-xmsg 入站入口。
- Fabric `RefundAssetEscrow` 直接退款入口。
- Fabric 未使用的 `GetAckStatus` 与空 `InitLedger`。

删除 `RefundAssetEscrow` 后，Fabric escrow 只能由已授权 Watcher 按 `Pending -> Challenged -> Compensated` 状态机调用 `CompensateAfterChallenge` 触发内部真实退款，不能绕过 challenge window。

### 3.3 过时文档

已删除完成阶段的重构计划、旧阶段实现说明和与当前代码相冲突的历史安全审查。当前结构应以 `README.md`、本文档、`event-driven-relayer-watcher-refactor.md`、`persistent-automation-and-lifecycle-checkpoint.md` 及各链最新专项文档为准。

### 3.4 旧运行时备份

已从项目目录移除 `runtime/subnet-isolation-migration-backup/`。该目录约 104 MB，包含子网隔离迁移前的 TEE/Raft 状态、旧实验结果及 Fabric ledger reset 副本，不会被当前代码读取。当前 `runtime/` 状态和 `fabric-network/runtime/` 活跃账本未删除。

## 4. 额外收敛

- Fabric target builder 的 selector 已从旧 `ExecuteHXMsg` 改为 `ExecuteHXMsgCompact`。
- Fabric 单笔和批次执行会实际检查该 selector。
- Automation EVM target submitter 不再回退到动态 calldata；缺少 `compactCall` 时直接拒绝。
- EVM-to-EVM builder 始终生成 compact target action，本地 Ethereum、Avalanche 和 Sepolia 共用该逻辑。
- Sepolia preflight 改为检查无逐消息 proof 的唯一 compact batch ABI。
- `npm test` 明确分离 Node Test Runner 与 Hardhat/Mocha 测试。
- 删除指向同一实现的 `evm-avalanche` 旧命令别名，统一使用明确的
  `ethereum-avalanche`、`avalanche-sepolia` 和 `sepolia-avalanche` 链名。

## 5. 保留但不属于旧路径的接口

- `/v1/jobs/response`：开放 RESPONSE 中继任务入口。任意 relayer 可以提交候选材料，TEE 仍独立验证目标链事实。
- `/v1/jobs/checkpoint`：生命周期终态批量清理入口。
- `/v1/jobs/watch`：Watcher 任务入口。
- TEE `/attest-response` 与 `/attest-checkpoint`：分别认证目标执行事实和终态 checkpoint。
- Fabric TEE 注册、查询和 Watcher 授权管理接口：属于治理与运维 API，不是旧 relay。

## 6. 验证结果

本轮已通过：

| 检查 | 结果 |
|---|---|
| Solidity 编译 | PASS，7 个合约文件重新编译 |
| 全部项目 JavaScript `node --check` | PASS |
| Avalanche P-Chain trust anchor 单元测试 | 3/3 PASS |
| TEE 子网密码学隔离 Hardhat 测试 | 1/1 PASS |
| EVM challenge/response 状态机 | 7/7 PASS |
| 生命周期 checkpoint、Watcher 授权和 escrow 清理 | PASS |
| Automation store | 5/5 PASS |
| Ethereum -> Avalanche Automation E2E | PASS，真实 reserve transfer，目标 gas 532825 |
| Avalanche -> Ethereum Automation E2E | PASS，真实 reserve transfer，目标 gas 533698 |
| `git diff --check` | PASS |

本轮已使用本地 5 节点 Avalanche 网络、本地 Ethereum、两个 5 节点 TEE 子网和 Automation 重新部署合约并完成双向容器化冒烟测试。Fabric 链码 ABI 也已发生变化；后续运行 Fabric 方向实验前仍须重新部署 chaincode sequence。

## 7. 后续实验约束

1. 业务 E2E 只使用 `automation:test:*` 或调用这些 Automation driver 的 Sepolia 包装命令。
2. 不重新增加测试脚本直接调用 TEE 后再直接提交目标链的流程。
3. 修改 EVM 合约后重新部署对应链合约。
4. 修改 Fabric 链码后执行新的 chaincode sequence 部署。
5. 论文实验结果必须记录 scanner、finality、proof、TEE、target submit 和 Watcher 阶段，不能使用已经删除的旧结果文件冒充当前主线数据。
