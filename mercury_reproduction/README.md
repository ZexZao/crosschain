# MERCURY Ethereum/EOS Ablation Baseline

本目录按论文正式版 `Mercury: Practical Cross-Chain Exchange via Trusted Hardware`
实现一个与主项目 h-xmsg 隔离的消融 baseline。实验主路径为：

```text
Sepolia MercuryVault deposit
  -> Ethereum receipt MPT + sync committee finality
  -> 5 TEE nodes independently verify
  -> Raft majority commit + 3-of-5 signatures
  -> EOS mercuryvlt batched transfer
  -> irreversible EOS execution verification
  -> Raft confirmation certificate
  -> source deposit confirmed, or challenge/refund
```

## 与论文方案的对应关系

| 论文组件 | 本项目实现 |
|---|---|
| `n=2f+1`, `f+1` votes | 5 节点、3 节点 majority/threshold；偶数节点配置会拒绝启动 |
| Raft inside TEE | RequestVote、AppendEntries、heartbeat、commitIndex、leader forwarding；follower 独立验证 proof 后才接受 entry |
| `DEPOSIT` | `MercuryVault.createDeposit`，ERC-20 escrow 和唯一 deposit ID |
| batched `TRANSFER` | EVM `MercuryTargetVault.executeBatch`；EOS `mercuryvlt::transfer` |
| target-finalized confirmation | `/confirm-transfer` 验证 EVM finalized receipt 或 EOS irreversible transaction |
| `STARTCHALLENGE` | owner 在 response deadline 后提交固定 pledge |
| `RESOLVECHALLENGE` | challenge wait 后退回 source deposit 和 pledge |
| operator challenge response | target completion certificate 可在 Challenged 状态完成，pledge 归 treasury |
| `UPDATECHECKPOINT(idSet, signs)` | 链上验证证书并实际批量删除/结算 deposit IDs |
| lightweight EVM verification | receipt MPT proof 锚定到 sync-committee-certified finalized header |
| TEE registration | Mercury 独立 Registry，避免接受 h-xmsg cluster 的证书 |

`claimDigest/responseDigest/idSetRoot` 不再作为论文原语义使用。当前摘要分别绑定
off-chain exchange request、target transfer batch、finalized confirmation 和明确的 deposit ID set。

## 实现边界

- Raft 和 remote attestation 是实验级模拟实现，适合消融实验，不代表生产级硬件 TEE。
- Docker 中的固定私钥只用于可复现实验，不能用于生产环境。
- 正式 Sepolia 实验强制要求 Ethereum sync committee finality；只有本地 smoke test 才设置
  `MERCURY_ALLOW_UNFINALIZED_EVM=true`。
- 当前完整实验方向是 Sepolia -> EOS。反方向不是本次 baseline 的实验变量。
- EOS 节点不提供旧 `history_plugin` 时，TEE 会验证不可逆区块中的 transaction ID，并使用
  nodeos `push_transaction` 返回的 action trace；该 fallback 由
  `MERCURY_EOS_ALLOW_PUSH_TRACE=true` 显式控制，默认关闭；正常情况下直接解码不可逆区块内的
  packed transaction action，不依赖 relayer 提供的 trace。

## 本地验证

编译和协议状态机测试：

```bash
npm run compile -- --force
npm test
```

启动 5 TEE 和 EOS：

```bash
npm run docker:up
```

本地 Raft/proof smoke test 需要本地 EVM RPC，并仅为它允许未 finality 的开发链：

```bash
MERCURY_ALLOW_UNFINALIZED_EVM=true docker compose -p mercury-ablation up -d --force-recreate \
  mercury-tee-1 mercury-tee-2 mercury-tee-3 mercury-tee-4 mercury-tee-5
npm run test:raft-local
```

结果写入 `runtime/local-mercury-raft-smoke.json`。

## EOS 合约

构建 token 与 Mercury vault：

```bash
npm run build:eos
```

默认使用 `eostudio/eosio.cdt:v1.8.1`；可通过 `EOSIO_CDT_IMAGE` 覆盖。然后初始化
账户、token 流动性、EOS vault 和 5 个 TEE public keys：

```bash
npm run bootstrap:eos
```

部署结果为 `runtime/deployment.eos.json`。

## Sepolia -> EOS 完整实验

1. 启动 5 TEE 和 EOS，并构建/初始化 EOS 合约。
2. 部署 Mercury 专用 Registry 与 source vault：

```bash
npm run deploy:sepolia
```

3. 注册 5 个 Mercury TEE：

```bash
npm run register:sepolia
```

4. 运行交换：

```bash
npm run test:sepolia-eos
```

脚本会真实调用 `createDeposit`、等待 Sepolia finality、生成 receipt proof、经 Raft 签署
EOS batch、执行 EOS token transfer、等待不可逆区块、再次经 Raft 确认，并调用
`confirmTransfer`。任何阶段失败都会写入带 `pass: false` 的结果文件，不再吞掉链上异常。

主要结果文件：

```text
runtime/deployment.sepolia.json
runtime/sepolia-tee-registration.json
runtime/deployment.eos.json
runtime/sepolia-eos-ablation-result.json
runtime/local-mercury-raft-smoke.json
```
