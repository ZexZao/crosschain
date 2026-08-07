# Avalanche 与 Fabric 对齐说明

## 1. 对齐目标

本次改造对齐跨链消息语义和源链生命周期，不把不同链的事实证明强行改成同一种实现。

| 源链 | 交易事实证明 | TEE 验证结果 |
|---|---|---|
| Fabric | h-FSV View、Peer endorsement、MSP 信任和区块读写集 | 源链事件及其 h-xmsg 字段真实存在 |
| Avalanche | Warp message、P-Chain validator set 和 BLS 权重签名 | Warp payload 及其 h-xmsg 字段真实存在 |
| EVM | committee-certified header 和 receipt MPT proof | receipt log 及其 h-xmsg 字段真实存在 |

三类 adapter 输出统一的已验证源链事实，再由对应的 5 TEE 子网运行 Raft 并形成 `3/5` quorum certificate。

## 2. 统一消息类型

| 类型 | `feedback.required` | `atomicity.required` | 源链状态 |
|---|---:|---:|---|
| 单向消息 | false | false | 不创建响应生命周期 |
| 需要 RESPONSE | true | false | `Pending -> Completed`，不允许挑战和补偿 |
| 原子业务 | true | true | `Pending -> Challenged -> Completed/Compensated` |

`atomicity.required = true` 必须同时要求 `RESPONSE`；反向关系不成立。普通响应型业务不会因为等待 RESPONSE 就自动获得退款能力。

## 3. Avalanche 改造

`AvalancheWarpSourceContract` 继承 `ResponseLifecycleBase`，与 `EvmSourceContract` 共享：

- 请求状态机和 RESPONSE replay protection；
- TEE Registry 与 quorum certificate 验证；
- challenge deadline 检查；
- ERC-20 token escrow 锁定、成功结算和超时真实退款。

Warp payload 直接绑定完整 `feedback`、`atomicity` 和独立的 `validatorPolicyHash`。Avalanche adapter 会把 Warp 内策略与 h-xmsg 重新计算后比较，攻击者不能只修改链下 h-xmsg 与摘要来改变响应类型、挑战窗口或补偿动作。

## 4. Fabric 改造

Fabric 使用 `responseLifecycle:{requestID}` 保存需要 RESPONSE 的消息，接口统一为：

- `BindResponseLifecycleHXMsg`
- `QueryResponseLifecycle`
- `CompleteWithResponse`
- `StartChallenge`
- `CompensateAfterChallenge`

生命周期由 `feedback.required` 创建，challenge/compensation 额外要求 `atomicity.required`。`TOKEN_ESCROW` 成功 RESPONSE 会把真实 Fabric escrow 标记为 `Settled`；挑战期结束后会把真实余额退回 owner。

Fabric builder 优先采用链上 XCALL 事件中已经绑定的显式 feedback，不再用业务 payload 的 `requireAck` 覆盖 `RESPONSE/ACK` 类型。

## 5. 两两启动

受本地资源限制，实验不得同时启动 Ethereum、Fabric 和 5-node AvalancheGo。统一使用：

```bash
npm run pair:up -- evm-fabric
npm run pair:up -- evm-avalanche
npm run pair:up -- fabric-avalanche
```

`manage-chain-pair.js` 会先停止全部链节点和三个 TEE 子网，再只启动所选两条链及其源链证明子网。切换实验方向时应重新部署该链对需要的合约/链码，防止旧 Registry、nonce 或业务记录污染结果。

## 6. 验证结果

- EVM 挑战响应状态机：`7/7`。
- EVM <-> Avalanche 普通双向业务：`16/16`。
- Avalanche response-only：完成为 `Completed`，且挑战被拒绝。
- Avalanche token escrow：真实锁定 `250000` units，超时后真实退回 `250000` units。
- Fabric -> EVM：`8/8`。
- EVM -> Fabric：`64/64`。
- Fabric -> Avalanche：`8/8`，目标 Avalanche 执行 gas 平均 `467736`（TEE batch size 8）。
- Avalanche -> Fabric：`8/8`，每笔 Warp 源交易约 `123642-123666 gas`，Fabric 目标链不使用 EVM gas。
- Fabric response-only 完整 RESPONSE 闭环：通过。
- Fabric 真实资产结算与超时退款：`2/2`。

对应运行结果保存在 `runtime/`。这些结果来自顺序启动的链对，不是三链同时运行结果。
