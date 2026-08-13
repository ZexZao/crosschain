# Avalanche P-Chain 可信锚实现

## 1. 解决的问题

旧实现由 relayer 同时提交 Warp message、validator set、权重、阈值和签名。TEE 能验证这些材料内部一致，却不能证明 validator set 确实来自真实 P-Chain。攻击者可自建 BLS 密钥集合并构造一套自洽材料。

当前实现将 validator set 的权威来源移入 Avalanche TEE 子网：

```text
本地 Avalanche genesis
  -> 五节点 P-Chain 一致查询
  -> genesis-pinned trust anchor
  -> 每个 Avalanche TEE 查询各自 P-Chain 节点的指定高度
  -> 使用锚内公钥和权重验证 Warp BLS 签名
  -> Raft 提交已验证结果
```

Relayer 仍可携带 validator set 以便传输和审计，但不能决定 validator 公钥、总权重或阈值。

## 2. 信任锚生成

本地 Avalanche 网络启动后执行：

```bash
npm run avalanche:anchor
```

脚本读取当前 Avalanche CLI 网络的 `genesis.json`，并向五个 AvalancheGo 节点查询相同 P-Chain 高度的 `platform.getAllValidatorsAt`。只有满足以下条件才生成 `runtime/avalanche-pchain-trust-anchor.json`：

- 五个节点返回相同的 C-Chain blockchain ID；
- 五个节点返回相同的 validator set hash 和 total weight；
- validator NodeID 和 BLS 公钥与 genesis initial stakers 完全一致。

`npm run pair:up -- evm-avalanche` 和 `npm run pair:up -- fabric-avalanche` 会自动先启动 Avalanche 网络、生成信任锚，再启动 Avalanche TEE。

## 3. TEE 验证规则

每个 Avalanche TEE 配置独立的 P-Chain RPC：

| TEE | P-Chain 节点端口 |
|---|---:|
| tee-avalanche-1 | 9650 |
| tee-avalanche-2 | 9656 |
| tee-avalanche-3 | 9652 |
| tee-avalanche-4 | 9654 |
| tee-avalanche-5 | 9658 |

TEE 对每个 Warp 证明执行：

1. 检查 network ID 和 source chain ID 与 genesis 锚一致。
2. 检查证明高度不高于本地 P-Chain accepted height，且未超过历史窗口。
3. 使用 `platform.getAllValidatorsAt(proofHeight)` 查询指定高度，而不是查询 current validators。
4. 检查本地节点返回的集合与 genesis 固定快照一致。
5. 拒绝 relayer 修改 validator set、total weight、quorum 或排序规则。
6. 使用信任锚中的 BLS 公钥和权重验证 Warp signatures。
7. 将验证后的 P-Chain 高度、genesis hash 和 validator-set hash 写入各 TEE 的 chain state。
8. 只有各节点独立验证通过后才进入 Raft 提交和 TEE quorum 签名。

## 4. 轮换策略

当前本地五节点网络在实验期间使用静态 genesis validator set。若 P-Chain 返回不同集合，TEE 会 fail closed，而不会接受 relayer 或 RPC 提供的新集合。

后续 TDX 部署使用相同 `PChainValidatorSetProvider` 边界，将 AvalancheGo/P-Chain 验证节点放入 TDX VM 内，从 genesis 同步并验证 P-Chain，再由 provider 输出指定高度的动态 validator snapshot。届时不需要修改 h-xmsg、Automation、Gateway、Ethereum adapter 或 Fabric adapter。

Raft 只同步各 TEE 已独立验证的高度和 validator-set hash，不承担 P-Chain 真实性判断。

## 5. 测试

运行纯安全回归：

```bash
npm run avalanche:test:pchain-anchor
```

覆盖：

- 正确的 genesis-pinned validator set 通过；
- 攻击者自建且内部自洽的 BLS validator set 被拒绝；
- relayer 降低 quorum 被拒绝；
- 错误 network ID 被拒绝。

真实端到端测试继续使用：

```bash
npm run automation:test:avalanche-ethereum
```

结果中的 `teeVerification` 会包含 `pChainGenesisHash`、`pChainTrustMode`、`pChainHeight` 和 `validatorSetHash`。
