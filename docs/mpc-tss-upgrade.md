# MPC-TSS 升级方案

## 1. 背景

当前 V3 签名者路径采用**逐条 ECDSA 签名**，N 个验证节点各自用独立私钥签名，链上合约通过 `ecrecover` 循环验证每条签名并去重计数。

此方案对于 N=4 是可接受的（~12,000 gas），但存在两个局限：
- Gas 与 N 线性增长
- 每条签名 65 字节全上链，总数据量 N × 65 bytes

MPC-TSS 是行业主流方案（RenVM, Thorchain, Axelar, LayerZero 等均采用），其核心优势：
- N 个节点协作产出一个标准 ECDSA 签名
- 链上只需一次 `ecrecover`（~3,000 gas）
- 签名体积固定 65 bytes（与 N 无关）

## 2. MPC-TSS 原理

```
DKG（分布式密钥生成）:
  N 个节点协作生成一个公私钥对
  每个节点持有一个私钥分片 s_i
  完整私钥 S = s_1 + s_2 + ... + s_N
  任何人（包括节点自己）都没有完整私钥 S
  公钥 P = S × G 是公开的，所有人可见

签名协议（如 GG20/GG18）:
  ① 阈值 T 个节点（如 3/4）同意签名
  ② 各节点用私钥分片 s_i 参与 MPC 交互协议
  ③ 协议完成后产出一个标准 ECDSA 签名 (r, s, v)
  ④ 任何人可用公钥 P 验证该签名（ecrecover）
  
  链上看到的是: 一个公钥 + 一个签名
  链上无法区分这是单签还是 MPC-TSS
```

## 3. 对当前项目的影响范围

### 3.1 需要修改的

| 层 | 文件 | 改动 |
|----|------|------|
| 验证节点 | `validator-node/server.js` | 新增 MPC 签名端点（GG20 协议）替代 `/sign` |
| 验证节点 | `evm-validator-node/server.js` | 同上 |
| 聚合器 | `consensus-aggregator/index.js` | 从"收集 N 个签名"变为"协调一次 MPC 签名" |
| 聚合器 | `consensus-aggregator/server.js` | `/v3-aggregate` 端点逻辑调整 |
| 合约 | `VerifierContractV3.sol` | `_verifySignerThreshold()` 从循环 `ecrecover × N` 改为单次 `ecrecover × 1` |
| 合约 | `VerifierContractV3.sol` | `registeredSigners` mapping → 单个 `signerPubkey` |
| 中继器 | `relayer/index.js` | ABI 参数调整 |
| 测试脚本 | `scripts/run-fabric-e2e-tests.js` 等 | 适配新 ABI |

### 3.2 不需要修改的

| 层 | 原因 |
|----|------|
| TEE（`tee-verifier/server.js`） | 不关心签名方案，只验源链交易存在性 |
| Fabric listener（`source-chain/fabric-listener.js`） | 只捕获事件，不涉及签名 |
| 链码（`fabric-chaincode/xcall/index.js`） | 不涉及签名验证 |
| 业务合约（`TargetContract.sol`） | 签名无关 |
| Proof builder（`proof-builder/v3-proof-builder.js`） | 只调用聚合器，不关心其内部协议 |
| ACK 守护进程（`scripts/ack-relay-daemon.js`） | 不涉及签名 |

### 3.3 Fabric 和 EVM 的差异处理

MPC-TSS 本身是**链无关**的——它只产出一个 ECDSA 签名。两条链的差异体现在**签名之前的验证步骤**：

```
                      Fabric 侧                    EVM 侧
                      ────────                     ─────
签名前验证:    查 peer GetBlockByTxID      查 RPC getTransactionReceipt
              ↓                             ↓
参与判断:      交易存在 → 参与签名           回执存在 → 参与签名
              ↓                             ↓
签名过程:      ┌─── MPC-TSS（完全相同的协议）───┐
              │   GG20 协议                     │
              │   各节点用私钥分片协作签名        │
              │   产出标准 ECDSA (r, s, v)       │
              └─────────────────────────────────┘
              ↓                             ↓
签名后:       提交到 VerifierContractV3
              链上 ecrecover × 1

两组验证者使用不同的 MPC 密钥:
  - fabric-mychannel: 4 个 Fabric validator 节点 DKG
  - evm-localhost:    4 个 EVM validator 节点 DKG
```

**两条链的 DKG 是独立的**，但 MPC 协议实现完全相同。

## 4. 合约变化

### 当前（逐条 ECDSA）

```solidity
mapping(address => bool) public registeredSigners;
address[] public signerList;
uint16 public signerThreshold;

function submit(
    XMsg calldata xmsg,
    bytes[] calldata signatures,   // N 个签名
    bytes32 consensusMessage,
    ...
) external {
    uint256 count = _verifySignerThreshold(consensusMessage, signatures);
    require(count >= signerThreshold);
}

function _verifySignerThreshold(bytes32 digest, bytes[] calldata sigs)
    internal view returns (uint256) {
    uint256 count;
    address lastSigner;
    for (uint256 i = 0; i < sigs.length; i++) {
        address signer = _recover(digest, sigs[i]);
        require(registeredSigners[signer]);
        require(signer > lastSigner);
        lastSigner = signer;
        count++;
    }
    return count;
}
```

### MPC-TSS 后

```solidity
address public signerPubkey;          // MPC 公钥

function submit(
    XMsg calldata xmsg,
    bytes calldata signature,          // 单个签名 (65 bytes)
    bytes32 consensusMessage,
    ...
) external {
    address recovered = _recover(consensusMessage, signature);
    require(recovered == signerPubkey, "invalid signer signature");  // 一行
}
```

| 维度 | 当前 | MPC-TSS |
|------|------|---------|
| 合约代码 | ~40 行 | ~5 行 |
| Gas（签名验证） | ~12,000 (N=4) | ~3,000 |
| 签名数据量 | 260 bytes (4×65) | 65 bytes |
| 注册逻辑 | `registerSigner()` ×4 + `setThreshold()` | 仅 DKG 后设置一次 `signerPubkey` |
| 可扩展性 | Gas 随 N 增长 | Gas 固定 |

## 5. MPC 协议选择

| 协议 | 特点 | 推荐 |
|------|------|------|
| GG20 | 基于 Gennaro-Goldfeder 2020，最广泛使用 | ✅ 首推 |
| GG18 | 更早版本 | 已被 GG20 取代 |
| CGGMP20 | 支持 Proactive Refresh | 生产环境推荐 |
| FROST | Schnorr 签名，比特币生态 | 非 ECDSA 不适用 |

对于本项目，推荐 **GG20**：
- npm 包 `@toruslabs/tss-client` 或 `@safeheron/mpc-wasm-sdk`
- 每条签名 2 轮交互（4 节点约 100ms）
- 支持 t-of-n 阈值

## 6. 实施路线

### Phase 1: MPC 协议集成（~3 天）

1. 在每个 validator 节点中集成 GG20 DKG + 签名模块
2. DKG 初始化：生成公钥 P 和私钥分片
3. 新增 `/mpc-sign` 端点替代 `/sign`
4. 聚合器改为协调单次 MPC 签名（非收集 N 个签名）

### Phase 2: 合约升级（~1 天）

1. 修改 `VerifierContractV3`：单公钥 + 单 `ecrecover`
2. 升级部署 + 设置 MPC 公钥
3. 保留旧版合约兼容

### Phase 3: 联调测试（~1 天）

1. Fabric→EVM：MPC 签名 + TEE 验证 + 合约单次 ecrecover
2. EVM→Fabric ACK：MPC 签名 + TEE 验证 + Fabric 接收
3. 故障注入：N-1 个节点离线仍能签名

### Phase 4: 生产加固（可选）

1. Proactive Key Refresh（定期刷新私钥分片）
2. 节点轮换（Party Rotation）
3. 审计 MPC 实现

## 7. 技术选型建议

| 选项 | 工具/库 | 适用 |
|------|---------|------|
| WebAssembly MPC | `@safeheron/mpc-wasm-sdk` | Node.js 原生，性能好 |
| MPC Library | `mpc-ecdsa` (ZenGo-X) | 学术级实现，Go/Rust |
| 托管服务 | Sepior / Curv（已合并） | 生产级，需付费 |

对于本项目原型阶段，推荐 `@safeheron/mpc-wasm-sdk`：
- 纯 WASM，无原生编译依赖
- 支持 GG20 协议
- 官方维护且社区活跃
