# MERCURY 消融实验设计

## 论文依据

实现依据为：

```text
/home/zex/codex-work/修改文件/Mercury_Practical_Cross-Chain_Exchange_via_Trusted_Hardware.pdf
```

正式版 Algorithm 1 的核心函数为 `DEPOSIT`、`TRANSFER(tranSet, signs)`、
`STARTCHALLENGE`、`RESOLVECHALLENGE` 和 `UPDATECHECKPOINT(idSet, signs)`。

## 对照实验控制变量

MERCURY baseline 与主项目复用相同的 Sepolia RPC、测试资产和基础证明工具，但刻意保持：

1. 独立 source/target vault，不使用 `EvmSourceContract.submitHXMsgRequest`。
2. 独立 Mercury TEE Registry 和 cluster domain。
3. 交换 request/transfer/confirmation 摘要，不使用 h-xmsg envelope。
4. 同样的 5 节点实验级 TEE 容器和 Raft 故障模型，便于公平比较共识开销。
5. 相同 source transaction proof/finality 质量，避免把弱证明带来的性能差异算成协议收益。

## 安全不变量

- source deposit 只有两种终局：target finalized 后 Completed，或 challenge timeout 后 Refunded。
- TEE 不会为未绑定到真实 `MercuryDepositCreated` log 的 request 签名。
- follower 必须独立验证 source/target proof；leader 声明本身不能形成证书。
- 只有 Raft majority commit 的 entry 才能产生 TEE signatures。
- target batch ID 和 deposit ID 都防重放。
- challenge pledge 成功退款时退还；target 已完成时 pledge 被罚没。
- checkpoint 必须携带明确的 deposit IDs，并在链上逐项结算，不能只登记一个 root。

## 测量项

建议消融报告分别记录：

1. Deposit、target batch、confirm、challenge、refund、checkpoint gas。
2. receipt proof 构造时间与 Sepolia finality wait（分开报告）。
3. Raft prepare/append/commit/signature collection 延迟。
4. EOS push transaction、irreversibility wait 和 confirmation 延迟。
5. batch size 对单笔 target transfer 成本的影响。
6. leader/follower crash 后的可用性及 challenge/refund 结果。

## 非生产假设

本项目使用 simulated attestation 和固定实验密钥。论文的硬件隔离假设在论文叙述中保留，
但本地结果只能证明协议与工程路径，不能用来宣称真实 SEV/SGX 安全性或硬件性能。
