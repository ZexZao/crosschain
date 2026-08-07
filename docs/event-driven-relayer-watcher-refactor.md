# Relayer/Watcher 事件驱动重构记录

## 改造范围

本次将原先“测试脚本掌握全部流程”的运行方式拆成监听、证明、TEE、目标提交和 Watcher 五个独立阶段。改造覆盖 Ethereum、Sepolia、Fabric 和 Avalanche profile，不修改 canonical h-xmsg 字段。

## 主要变化

1. 删除旧 `automation/durable-task-store.js`、旧 relay/watch handler 和手工 `/v1/jobs/relay` 入口。
2. 新增 `AutomationStore` v2，统一持久化 tasks、events、cursors、materials 和 workflows。
3. 新增 Ethereum/Avalanche 区间日志 scanner，以及 Fabric contract event scanner。
4. EVM 类 scanner 使用区块 hash checkpoint 识别 reorg，并取消 orphan event 的未完成任务。
5. 新增链级 finality/proof builder：EVM receipt MPT、Sepolia Sync Committee、Fabric h-FSV、Avalanche Warp。
6. 新增持久 Relayer 状态机，服务重启后从阶段任务继续，而不是重新发送源交易。
7. 复用并重构 Watcher，使其由源事件策略自动登记，按链上 deadline 自动 challenge 和真实补偿。
8. Source material 支持事件前后到达；材料缺失的 benchmark 事件不会生成生产任务。
9. 本地 Ethereum 与 Sepolia 私钥 profile 分离，避免本地 worker 误用测试网账户。
10. Fabric scanner 使用 QSCC 读取账本高度，并在网络启动较慢时持续重连。
11. Avalanche RPC proxy 解决容器访问本机五节点 AvalancheGo 时的 Host 校验问题。
12. 修正单消息以 Avalanche 为目标时的 TEE delivery digest 选择，使其与 EVM-compatible Gateway 验证一致。
13. Raft 恢复测试改为等待全节点 term/leader 收敛，不再用固定 3 秒睡眠误报失败。
14. Sepolia trusted root 轮换改为写入经 finalized header `parent_root` 链证明的 epoch checkpoint root，避免普通 finalized head 无法用于下一次 bootstrap。

## 解耦边界

| 层 | 只负责 |
|---|---|
| Scanner | 发现规范链事件并推进 cursor |
| Finality adapter | 判断事件是否达到该链要求的确定性 |
| Proof builder | 构造可由 TEE 独立验证的材料 |
| Relayer | 编排阶段任务和提交目标链 |
| Watcher | 读取源链 lifecycle、challenge、compensate |
| TEE adapter | 验证源链事实，不信任 relayer 结论 |
| Gateway/chaincode | 验证 TEE cert、目标绑定、防重放并执行业务 |

新增链时，Automation 只需增加该链 scanner/finality/proof builder/target submitter；现有链证明 adapter 不需要因新链而改变。

## 本次真实验证

| 路径 | 结果 | 真实动作 |
|---|---|---|
| Ethereum -> Avalanche | PASS | Avalanche ERC-20 reserve transfer |
| Fabric -> Ethereum | PASS | Ethereum ERC-20 reserve transfer；h-FSV 4 Peer endorsement |
| Ethereum -> Fabric | PASS | Fabric XCST 余额真实入账 |
| Watcher timeout | PASS | EVM ERC-20 escrow 自动 challenge 后真实退款 |
| Challenge unit suite | 7/7 PASS | 状态转换、迟到 response、真实 escrow |
| Lifecycle checkpoint | PASS | 终态根认证和活动状态清理 |
| Raft fault suite | 6/6 PASS | follower/leader 故障、重加入和收敛 |

详细输出位于 `runtime/automation-*-e2e-result.json`、`runtime/hxmsg-challenge-response-results.json`、`runtime/lifecycle-checkpoint-test-result.json` 和 `runtime/raft-cluster-test-results.json`。

## 保留边界

- Automation store 仍是单进程 JSON，尚不是多实例数据库。
- RESPONSE 使用开放 relayer 提交，不设置唯一 responder；这是协议选择，不是缺失的安全验证。
- Checkpoint 的证明与提交已实现，终态候选自动聚合调度尚未实现。
- TEE 当前仍是模拟节点；迁移 TDX 时需替换真实 attestation、sealed key 和持久 Raft WAL。
