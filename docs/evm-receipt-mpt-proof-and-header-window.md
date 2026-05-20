# EVM Receipt MPT Proof 与 TEE Header Window

## 1. 目标

本次改造补齐 EVM -> Fabric 路径中此前的主要安全缺口：TEE 不再只依赖 RPC 返回的 receipt/log，而是要求 relayer 提供 receipt MPT proof，并由 TEE 使用自己维护的 EVM header window 中的 `receiptsRoot` 进行验证。

当前 TEE 仍是 Node.js 模拟实现；但除 TEE 硬件隔离外，EVM 交易存在性验证不再以“RPC 返回了 receipt”为充分条件。

## 2. 当前实现

新增模块：

```text
shared/evm/receipt-proof.js
```

该模块负责：

1. 按 Ethereum receipt trie 规则编码 receipt。
2. 构造 receipt trie。
3. 生成 receipt MPT proof。
4. 根据 block header 的 `receiptsRoot` 验证 receipt proof。

TEE 的 MELV-EF adapter 现在要求：

```text
helperData.evmReceiptProof
```

其中包含：

```text
blockHeader
receipt
receiptProof
receiptTrieKey
receiptValue
receiptsRoot
```

TEE 验证流程：

1. 检查 h-xmsg sourceRef 与 EVM tx/block/log 定位信息一致。
2. 检查 block header 的 `hash / number / receiptsRoot`。
3. 将 header 写入 TEE 本地维护的有限 header window。
4. 用 header window 中的 `receiptsRoot` 验证 receipt MPT proof。
5. 检查 receipt 的 `txHash / blockNumber / blockHash`。
6. 从已验证 receipt 中解析目标 log。
7. 检查 source contract、topic0、event 字段与 h-xmsg 绑定一致。
8. 检查 confirmations / finalized checkpoint。
9. 进入 Raft 日志复制和 committed signing。

## 3. Header Window

TEE 不维护所有历史区块头，而是维护一个滑动窗口：

```text
MELV_HEADER_WINDOW_SIZE=128
```

这与 Mercury 的思想一致：TEE 保存近期必要 header/checkpoint，而不是保存完整链历史。

窗口中保存：

```text
number
hash
parentHash
stateRoot
transactionsRoot
receiptsRoot
logsBloom
timestamp
```

如果新区块能连接到窗口内前一区块，TEE 会检查：

```text
header.parentHash == previousHeader.hash
```

目标交易所在区块必须位于当前窗口中，否则 TEE 拒绝验证。

## 4. Finalized Checkpoint

TEE 会尝试通过 JSON-RPC 的 finalized tag 获取 finalized header：

```text
eth_getBlockByNumber("finalized", false)
```

如果底层 EVM 节点支持 finalized tag，则 TEE 记录：

```text
finalizedHeight
finalizedHash
```

目标交易所在区块必须不高于 `finalizedHeight`。

本地 Hardhat 环境通常不提供真实 PoS finalized checkpoint。因此当前实验环境会使用：

```text
MELV_LOCAL_FINALITY_CONFIRMATIONS
```

作为本地确认数回退。真实 EVM / PoS 环境部署时，应使用 finalized checkpoint 或 beacon light client update 替换该回退。

## 5. 安全边界

已补齐：

1. 不再接受没有 receipt MPT proof 的 EVM -> Fabric h-xmsg。
2. 不再仅凭 RPC receipt/log 判断交易存在。
3. TEE 使用 header `receiptsRoot` 验证 receipt 属于该 block。
4. TEE 维护有限 header window，而不是无界保存所有 header。

仍需后续增强：

1. 使用真实 PoS beacon light client update 验证 finalized execution header。
2. 将 finalized checkpoint 的来源从普通 RPC 升级为独立可验证的 consensus proof。
3. 为 header window 增加 snapshot / 持久化校验。
4. 增加篡改 receipt proof、篡改 receiptsRoot、过期 header window 的安全测试。

