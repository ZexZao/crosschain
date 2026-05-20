# 项目设计初衷达成度安全审查

## 1. 审查结论

截至当前实现，项目已经接近 h-xmsg / h-FSV / MELV-EF 的设计主线，但还不能宣称完全达到“无安全妥协”的设计初衷。

本审查默认接受以下两个实验边界：

1. 当前 TEE 仍为 Node.js 模拟实现。
2. EVM 区块头管理节点当前只有一个节点，且暂未实现轮换委员会。

在排除上述两个已接受边界后，项目仍存在若干会削弱安全性的实现点，需要后续整改。

## 2. 已满足设计初衷的部分

### 2.1 Fabric -> EVM 不再只是验证区块

当前 Fabric -> EVM 主线已经验证具体 Fabric 交易存在性，而不是只验证区块存在：

- TEE 通过 h-FSV adapter 查询 `QueryCrosschainEvent(requestID)`。
- 验证 Fabric peer endorsement 签名。
- 验证 endorser MSP 身份和 MSP 根证书归属。
- 检查 h-FSV policyHash。
- 通过 QSCC `GetBlockByTxID` 获取 Fabric block。
- 在 block 中定位指定 txId。
- 检查交易 validation code 为 `VALID`。
- 解码 rwset，检查交易确实写入 `crosschainEvents:{requestID}`。
- 检查 Fabric 状态记录和 h-xmsg 字段绑定关系。

这已经满足“不能只证明区块存在，必须证明具体交易存在并写入目标状态”的核心要求。

### 2.2 EVM -> Fabric 已接入 receipt MPT proof

当前 EVM -> Fabric 主线已经要求 relayer 提供 receipt MPT proof，并由 TEE 使用 receipt trie proof 验证 receipt 属于某个 `receiptsRoot`。

TEE 还检查：

- receipt 的 txHash / blockNumber / blockHash。
- 指定 logIndex。
- log address 是可信 EVM source contract。
- topic0 是 `CrossChainCallRequested`。
- event 字段和 h-xmsg header / target / targetAction / payloadBinding 一致。

### 2.3 旧 validator / BLS / ACK relay 主路径已经删除

当前项目已经删除旧 validator 多签路径、BLS 聚合辅助代码、legacy ACK relay 和旧 relayer guard，减少了误用旧安全模型的风险。

### 2.4 目标链执行有基本绑定

EVM 目标链和 Fabric 目标链都检查：

- requestID 防重放。
- expireAt 过期时间。
- 目标链 ID / domain / target object。
- callDataHash。
- targetExecutionHash。
- TEE 签名中的 hmsgDigest 或 deliveryDigest。

## 3. 未达标点

### 3.1 EVM receipt proof 的 header 锚定仍不严格

当前 `tee-verifier/adapters/evm-melv-adapter.js` 中，TEE 会在目标 block header 尚未存在于本地 header window 时，将 relayer 提供的 `proofHeader` 写入 header window，然后用该 header 的 `receiptsRoot` 验证 receipt MPT proof。

这会造成一个安全缺口：

- receipt proof 只证明 receipt 属于某个 `receiptsRoot`。
- 如果 `receiptsRoot` 来自 relayer 提交的未验证 header，那么攻击者理论上可以构造伪 header、伪 receiptsRoot 和自洽的伪 receipt proof。
- TEE 没有强制要求目标 block header 必须已经由自己维护的可信 header 链得到。

这不满足 Mercury / MELV-EF 的核心要求。TEE 应独立维护可信区块头窗口，receipt proof 只能挂到 TEE 已验证或已维护的 header 上。

整改要求：

- 删除“缺 header 时接受 relayer proofHeader 写入窗口”的路径。
- TEE 应从自身 header 管理模块获取目标 header。
- receipt proof 的 root 必须等于 TEE 已维护 header 的 `receiptsRoot`。
- relayer 只允许提交 receipt proof 和 receipt，不应成为 header 信任来源。

### 3.2 TEE quorum threshold 由调用者提供

当前 EVM 侧 `HXMsgGateway.executeHXMsgMinimalCluster(...)` 接收外部传入的 `threshold` 参数。

Fabric 侧 `ExecuteHXMsg(...)` 也从 `certEnvelope.threshold` 读取阈值。

这意味着 relayer 理论上可以提交较低 threshold，例如 `threshold = 1`。即使测试中使用的是 3/4，目标链和链码本身并没有强制固定安全阈值。

这不满足 Mercury 风格 `2f+1` TEE 中至少 `f+1` 通过的安全模型。

整改要求：

- EVM 侧 threshold 应由 `TEERegistry` 或固定配置读取，不允许 calldata 传入。
- Fabric 侧 threshold 应由链码状态中的 TEE 集群配置读取，不允许 cert envelope 自声明。
- certification 中可以携带 reached / total 等元信息，但不能决定验签阈值。
- 对 4 个 TEE 的当前实验，应固定为至少 3/4 或明确实现 `2f+1` 下的 `f+1` 规则。

### 3.3 Fabric -> EVM helperData block bytes 旁路已删除

此前 Fabric h-FSV adapter 在验证交易存在性时，如果 `helperData.signedBlockBytes` 存在，会优先使用 relayer / listener 提交的 block bytes；否则才通过 QSCC `GetBlockByTxID` 查询。

这条路径的问题是：

- helperData 中的 block bytes 来源不一定可信。
- 当前代码没有对该 block 的 orderer commit、block 签名链、channel 配置进行完整验证。
- 虽然代码会检查 block 内 txId、VALID 和写集，但如果 block bytes 自身不是从可信 Fabric peer / QSCC 获得，这条路径仍然是安全降级。

当前处理状态：

- 已删除主线中的 `helperData.signedBlockBytes` 入口。
- Fabric listener 不再捕获或写出 `signedBlockBytes`。
- Fabric -> EVM 测试脚本不再向 `/attest` 传入 block bytes helperData。
- h-FSV adapter 现在只通过 Fabric Gateway / QSCC 主动查询 block。

剩余设计分歧：

- 如果项目最终坚持纯 h-FSV / Fabric View 语义，则还应进一步删除 TEE 的 QSCC block 查询和 block/rwset 解析逻辑。
- 如果保留“View + block 交叉验证”语义，则当前 helperData 旁路已不再构成未验证外部 block bytes 信任来源。

### 3.4 EVM finality 仍可能回退为 confirmation-based

当前 EVM MELV-EF adapter 会尝试使用 JSON-RPC `finalized` tag。如果 RPC 不支持，会回退到本地 confirmation 规则。

这在 Hardhat 本地环境中方便测试，但从严格安全目标看，confirmation fallback 不是 finalized checkpoint proof。

由于本项目目标参考 Mercury，TEE 应维护或验证最终性相关的区块头 / checkpoint 信息。仅依赖普通 RPC 的 block number 和 confirmations 仍然属于安全妥协。

整改要求：

- 将 confirmation fallback 标记为 local-dev only。
- 生产或严格实验模式下，RPC 不支持 finalized checkpoint 时应直接拒绝。
- 后续接入 beacon light client update 或等价的可验证 finalized checkpoint。
- h-xmsg 的 finality policy 中应明确区分 `FINALIZED_CHECKPOINT` 与 `LOCAL_CONFIRMATION_DEV_ONLY`。

### 3.5 EvmSourceContract 的状态函数权限不足

当前 `EvmSourceContract.markCompleted(bytes32 requestID)` 可被任意账户调用，只要 request 处于 Pending 或 Challenged 状态即可改变状态为 Completed。

虽然当前跨链执行主线暂未依赖该状态完成目标链提交，但该函数属于可用合约接口，后续若接入 challenge / refund / ACK，就可能形成真实安全问题。

整改要求：

- `markCompleted` 应限制为可信 gateway、TEE quorum 验证合约、owner 或经过证明的 callback 调用者。
- 或者在当前阶段直接删除 challenge / completed / refund 骨架，等正式设计后再引入。

### 3.6 TEE server 中仍残留未使用且安全语义较弱的旧函数

`tee-verifier/server.js` 中仍残留以下未被当前主线调用的函数：

- `queryFabricBlock`
- `queryEvmTransaction`
- `verifyFabricBlockLocally`
- `verifyEvmBlockLocally`

其中 `verifyFabricBlockLocally` 允许 Fabric chain gap，并且只检查 block 中有交易数据，不等价于当前 h-FSV 主线中的具体 txId / VALID / rwset 校验。

虽然这些函数目前未接入 `/attest` 主路径，但它们会误导后续开发，也可能被重新接入形成安全退化。

整改要求：

- 删除上述未使用函数。
- 保留的验证逻辑必须集中在 `adapters/fabric-hfsv-adapter.js`、`adapters/fabric-block.js`、`adapters/evm-melv-adapter.js`、`shared/evm/receipt-proof.js` 中。

### 3.7 Fabric listener 仍保留 mock-file 输入

`source-chain/fabric-listener.js` 仍保留 `--mock-file` 分支，用于从本地文件生成 h-xmsg。

当前 TEE 主线会重新查询 h-FSV，能够挡住多数伪造输入。但该入口仍不适合作为严肃主线的一部分，容易在后续实验或脚本中被误用。

整改要求：

- 从主线 listener 中删除 `--mock-file`。
- 如果需要测试 mock，应放入独立 test helper，并明确不能用于生产 / 严格安全实验。

## 4. 达标前必须完成的最低整改清单

要满足“除模拟 TEE、单节点未轮换 header 管理外，不接受安全妥协”的标准，至少需要完成：

1. EVM receipt proof 只能绑定到 TEE 已维护 header，不能接受 relayer 提交的未验证 header 作为信任来源。
2. EVM 和 Fabric 两侧的 TEE threshold 必须来自链上 / 链码可信配置，不能由 relayer 调用参数决定。
3. 若坚持纯 h-FSV / Fabric View，删除 Fabric -> EVM 中的 QSCC block 查询和 block/rwset 解析；`helperData.signedBlockBytes` 旁路已删除。
4. 严格模式下禁用 confirmation fallback，必须使用 finalized checkpoint 或等价可验证机制。
5. 修复或删除 `EvmSourceContract.markCompleted` 等未受控状态函数。
6. 删除 TEE server 中未使用的旧验证函数。当前 `queryFabricBlock`、`queryEvmTransaction`、`verifyFabricBlockLocally`、`verifyEvmBlockLocally` 已删除。
7. 删除 Fabric listener 的 `--mock-file` 主线入口。

## 5. 当前达成度判断

当前实现可以描述为：

```text
已实现 h-xmsg / h-FSV / MELV-EF 双向主线原型，
已具备具体交易存在性验证、receipt MPT proof、多 TEE Raft-backed quorum 和目标链轻量执行验证，
但仍存在若干安全妥协点，尚不能宣称完全达到最终设计初衷。
```

只有当第 4 节的最低整改清单完成后，项目才能在当前实验边界下更接近“无安全削减”的目标。
