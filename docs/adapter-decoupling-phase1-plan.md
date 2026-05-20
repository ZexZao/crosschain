# TEE Source Adapter 第一阶段解耦方案

## 1. 目标

本阶段不新增 Cosmos，也不改变当前 Fabric / EVM 的安全语义，只把 TEE 源链事实验证逻辑整理为可插拔 adapter 形态。

目标是让 TEE server 不再直接写：

```text
if source.chainType == Fabric -> verifyHFsv
if source.chainType == EVM -> verifyMelvEf
```

而是统一通过 adapter registry 分发：

```text
hxmsg -> resolveSourceAdapter(hxmsg) -> adapter.verifySourceFact(...)
```

这样后续新增 Cosmos 时，只需要新增 Cosmos adapter 并注册，不需要继续扩大 `tee-verifier/server.js` 中的分支逻辑。

## 2. 本阶段不做的事情

本阶段刻意不处理以下问题：

1. 不新增 Cosmos adapter。
2. 不改变 h-FSV 当前验证语义。
3. 不改变 MELV-EF 当前 header window / finality fallback 语义。
4. 不拆真实 TEE enclave / untrusted host 边界。
5. 不修改目标链合约或 Fabric chaincode 的执行模型。
6. 不解决 TEE threshold 由提交参数携带的问题。

这些事项应在后续阶段单独处理，避免一次重构混入太多安全语义变化。

## 3. 当前 Adapter 边界

当前项目中承担 source adapter 职责的文件如下：

| 文件 | 职责 |
|---|---|
| `tee-verifier/adapters/fabric-hfsv-adapter.js` | 验证 Fabric h-FSV View、endorsement、MSP、policy、h-xmsg 绑定；当前还保留 QSCC block/tx/rwset 交叉检查 |
| `tee-verifier/adapters/fabric-block.js` | Fabric block / tx / rwset 解析辅助模块 |
| `tee-verifier/adapters/evm-melv-adapter.js` | 验证 EVM receipt MPT proof、header window、finality policy、event log、h-xmsg 绑定 |
| `shared/evm/receipt-proof.js` | EVM receipt trie proof 构造与验证工具 |
| `shared/hxmsg/fabric-hfsv-policy.js` | Fabric h-FSV policy 构造 |
| `shared/hxmsg/evm-melv-policy.js` | EVM MELV-EF policy 构造 |

严格来说，`fabric-block.js` 和 `receipt-proof.js` 是 adapter 的底层证明工具，不是独立 source adapter。

## 4. 第一阶段接口

每个 source adapter 统一导出：

```js
module.exports = {
  adapterID,
  sourceChainType,
  verificationMethod,
  verifySourceFact,
};
```

字段含义：

| 字段 | 含义 |
|---|---|
| `adapterID` | adapter 的稳定字符串 ID，与 h-xmsg 中的 adapterID 语义对应 |
| `sourceChainType` | 该 adapter 支持的源链类型 |
| `verificationMethod` | 该 adapter 支持的验证方法 |
| `verifySourceFact` | 源链事实验证入口 |

`verifySourceFact` 的输入统一为：

```js
{
  hxmsg,
  helperData,
  chainState,
  saveChainState
}
```

其中：

- `hxmsg` 是待验证的完整 h-xmsg。
- `helperData` 是 relayer 提供的辅助证明材料，adapter 不能默认信任。
- `chainState` 是 TEE 本地维护的链状态窗口。
- `saveChainState` 用于 adapter 更新本地链状态。

## 5. Registry 分发

新增：

```text
tee-verifier/adapters/index.js
```

它负责：

1. 注册所有 source adapter。
2. 根据 `hxmsg.source.chainType` 和 `hxmsg.verification.verificationMethod` 选择 adapter。
3. 调用 adapter 的 `verifySourceFact(...)`。
4. 如果找不到 adapter，直接拒绝 h-xmsg。

TEE server 只保留：

```js
const verificationResult = await verifySourceFact({
  hxmsg,
  helperData,
  chainState,
  saveChainState,
});
```

## 6. 解耦后的职责划分

### TEE Server

TEE server 负责：

- HTTP API。
- h-xmsg 过期检查。
- adapter registry 调度。
- Raft RequestVote / AppendEntries / commit。
- committed entry 签名。
- TEE cluster certification 聚合。

TEE server 不再负责：

- 判断 Fabric/EVM 分支。
- 理解具体源链证明格式。
- 直接调用某个链特定验证函数。

### Source Adapter

source adapter 负责：

- 验证该源链的事实证明。
- 验证 policy。
- 验证 sourceRef。
- 验证 h-xmsg 字段绑定。
- 返回标准 verificationResult。

source adapter 不负责：

- Raft 共识。
- TEE 私钥签名。
- 目标链提交。
- 测试结果保存。

## 7. 后续演进

后续接入 Cosmos 时，应新增：

```text
tee-verifier/adapters/cosmos-*.js
shared/hxmsg/cosmos-*.js
```

并在 registry 中注册 Cosmos adapter。Cosmos adapter 应遵循同一接口，不应修改 TEE server 主流程。

后续真实 TEE 部署前，还应进一步拆分：

```text
trusted TEE core:
  h-xmsg hash
  policy check
  source adapter verification
  proof verification
  consensus critical state
  signing

untrusted host:
  HTTP
  RPC / Fabric Gateway
  filesystem
  Docker
  logs
```

这属于第二阶段或真实部署阶段，不属于本次第一阶段解耦。

## 8. 本阶段完成标准

1. Fabric -> EVM 测试保持通过。
2. EVM -> Fabric 测试保持通过。
3. `tee-verifier/server.js` 不再直接 import Fabric / EVM 具体 adapter。
4. 新 adapter 可通过 registry 增量注册。
5. 当前 h-xmsg、h-FSV、MELV-EF 安全语义不因解耦改变。
