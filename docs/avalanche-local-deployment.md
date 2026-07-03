# Avalanche 本地真实链部署说明

## 当前部署结果

本项目已接入真实本地 AvalancheGo 网络，而不是仅在脚本中模拟 Avalanche proof。

当前本地网络由 Avalanche CLI 启动：

```bash
npm run avalanche:up
```

等价于：

```bash
PATH=$HOME/bin:$PATH avalanche network start --num-nodes 5 --skip-update-check
```

当前网络包含 5 个 AvalancheGo primary validator。P-Chain 可查询到 5 个当前 validator，且每个 validator 具有实际 stake weight。

本地 C-Chain RPC：

```text
http://127.0.0.1:9650/ext/bc/C/rpc
```

本地 P-Chain API：

```text
http://127.0.0.1:9650/ext/P
```

## 已部署的 Avalanche 智能合约

部署命令：

```bash
npm run deploy:avalanche
```

部署结果保存于：

```text
runtime/avalanche-deployment.json
```

当前部署的合约包括：

| 合约 | 作用 |
|---|---|
| `TEERegistry` | Avalanche 目标链上记录可信 TEE 身份并验证 TEE quorum certificate |
| `EvmSourceContract` | Avalanche C-Chain 源链合约，真实发起跨链请求并产生 `CrossChainCallRequested` 事件 |
| `HXMsgGateway` | Avalanche 目标链网关，验证 TEE quorum 后调用业务目标合约 |
| `TargetContract` | Avalanche 目标业务合约，执行真实业务动作 |
| `CrossChainToken` | `TargetContract` 内部资产服务使用的真实 ERC20 风格 token |

`TargetContract` 并非简单状态写入。资产类业务会调用 `CrossChainAssetService`，进一步 mint `CrossChainToken`；补偿类/转账类实验后续也应通过真实资产合约路径完成。

## 已验证的真实 Avalanche 源链交易

执行：

```bash
npm run avalanche:smoke
```

脚本会在真实本地 Avalanche C-Chain 上调用 `EvmSourceContract.submitHXMsgRequest(...)`，产生真实交易、真实区块、真实 receipt 和真实 `CrossChainCallRequested` event。

结果保存于：

```text
runtime/avalanche-source-smoke-result.json
```

该测试用于确认：

1. Avalanche C-Chain RPC 可用。
2. Avalanche 源链合约真实部署。
3. 跨链请求不是本地伪造对象，而是来自 Avalanche 链上交易。
4. 后续 TEE 可以基于该 receipt/log 构造源链事实证明。

## 两两启动实验模式

后续本地实验不建议同时启动 Fabric、Ethereum、Avalanche 三条链。

推荐按实验方向两两启动：

| 实验方向 | 启动组件 |
|---|---|
| Fabric -> EVM | Fabric + Hardhat EVM + 对应 TEE 子网 |
| EVM -> Fabric | Hardhat EVM + Fabric + 对应 TEE 子网 |
| Avalanche -> EVM | Avalanche local network + Hardhat EVM + Avalanche/Ethereum TEE 子网 |
| EVM -> Avalanche | Hardhat EVM + Avalanche local network + Ethereum/Avalanche TEE 子网 |
| Avalanche -> Fabric | Avalanche local network + Fabric + Avalanche/Fabric TEE 子网 |
| Fabric -> Avalanche | Fabric + Avalanche local network + Fabric/Avalanche TEE 子网 |

Avalanche 网络管理命令：

```bash
npm run avalanche:status
npm run avalanche:up
npm run avalanche:down
```

Fabric 和 EVM 仍使用项目已有命令：

```bash
npm run fabric:up
npm run evm:up
```

## 服务器 / TDX 迁移考虑

当前本地 Avalanche 网络使用 Avalanche CLI 管理，适合开发和功能验证。

迁移到服务器时，应保留以下环境变量接口：

```text
AVALANCHE_RPC_URL
AVALANCHE_PRIVATE_KEY
```

部署脚本 `scripts/deploy-avalanche-local.js` 不绑定本机路径，只依赖 RPC 和私钥。因此迁移到服务器时可以直接切换为：

```bash
AVALANCHE_RPC_URL=http://<server-ip>:9650/ext/bc/C/rpc \
AVALANCHE_PRIVATE_KEY=<server-test-key> \
npm run deploy:avalanche
```

TEE 子网后续部署到 TDX 时，也应只通过 RPC 与 Avalanche 节点交互，不应把 Avalanche 节点进程和 TEE 进程强耦合。

## 当前边界

当前完成的是：

```text
真实 5 validator AvalancheGo local network
真实 C-Chain
真实 Avalanche 源链合约交易
真实 Avalanche 业务目标合约部署
```

当前尚未完成的是：

```text
Avalanche ICM/Warp message 真实发送
validator BLS aggregate signature 聚合
TEE 对 P-Chain validator set + signer bitmap + aggregate signature 的完整验证
```

如果论文中需要使用“权重签名者证明”作为 Avalanche 源链事实证明，则下一阶段必须在当前真实 Avalanche 网络基础上继续接入 Avalanche ICM/Warp 或 Avalanche L1/Subnet-EVM，并替换现有模拟的 `avalancheProof` 材料。
