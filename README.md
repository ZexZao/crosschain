# Cross-Chain Trusted Transport Prototype

## 项目概述

本项目实现了一个面向跨链智能合约调用的可信数据传输原型。当前主线实验场景为：

- 源链：本地 Hyperledger Fabric 网络（4 peer + 1 orderer）
- 目标链：本地 Hardhat EVM 测试链
- 签名方案：**门限 ECDSA（链上 ecrecover 逐条验证，3/4 阈值）**
- 信任模型：**签名者共识 + TEE 独立源链验证，两条路径在链上合约中独立验证**

系统目标是将源链事件转换为统一跨链消息 `XMsg`，由签名者集合产生 ECDSA 阈值签名证明、TEE 独立查询源链验证交易存在性，在目标链 `VerifierContractV3` 上完成双重独立验证与业务执行，并支持 ACK 回执闭环。

## 当前架构

### Fabric 侧组件

- `fabric-ca.org1.example.com` — Fabric CA 证书服务
- `orderer.example.com` — 排序节点
- `peer0~3.org1.example.com` — 4 个 Fabric peer，均加入 `mychannel`
- `validator-node-1~4` — 4 个与 peer 一一绑定的验证节点，绑定 peer 查询交易存在后 ECDSA 签名
- `consensus-aggregator` — 向 4 个验证节点请求 ECDSA 签名，收集 ≥3 个后返回（支持 V3 独立签名 + BLS 聚合 + 旧版 ECDSA）
- `fabric-listener` — 监听 Fabric 链码事件，提取 txId/blockNumber 构造 XMsg
- `fabric-tools` — Fabric 命令行工具容器

### EVM 侧组件

- `evm-node` — 本地 Hardhat 测试链（Chain ID 31337）
- `evm-validator-node-1~4` — 4 个 EVM 验证节点，签名前从 EVM 获取交易回执
- `evm-listener` — 监听 EVM 合约事件（forward / ack 双模式）

### 合约层

- `VerifierContract.sol`（V1）— 旧版 TEE 单约束合约
- `VerifierContractV2.sol`（V2）— BLS + TEE 合约（TEE 内部验证 BLS，链上验证 TEE 签名）
- `VerifierContractV3.sol`（V3）— **签名者 ECDSA 阈值 + TEE 独立源链验证**，两条路径在链上各自独立验证
- `TargetContract.sol` — 目标链业务合约
- `EvmSourceContract.sol` — EVM 源链合约

### TEE 验证服务

- `tee-verifier/server.js` — `/attest` 端点：独立连接 Fabric peer 查询 `GetBlockByTxID`，验证交易真实存在后才签名报告

### 验证节点与 Peer 绑定

- `validator-node-1 → peer0.org1.example.com`
- `validator-node-2 → peer1.org1.example.com`
- `validator-node-3 → peer2.org1.example.com`
- `validator-node-4 → peer3.org1.example.com`

## XMsg 结构（V3）

XMsg 是系统内所有组件传递的核心跨链消息。V3 已删除 eventProof 和 finalityInfo（TEE 独立查询源链替代了密码学证明），并显式支持异构链差异。

### 链上合约字段（13 个，ABI 编码提交到 VerifierContractV3）

| 字段 | Solidity 类型 | 说明 |
|------|-------------|------|
| `version` | `uint8` | 协议版本号，固定为 `1` |
| `chainType` | `uint8` | 源链类型：`0` = Fabric，`1` = EVM，`255` = 未知 |
| `finalityModel` | `uint8` | 最终性模型：`0` = BFT 即时（Fabric），`1` = 概率（PoW/PoS），`2` = 经济（PoS with finality），`3` = 检查点锚定 |
| `requiredConfirmations` | `uint16` | 所需确认数：Fabric = `1`，EVM PoW = `6~12`，EVM PoS = `2` epoch |
| `requestID` | `bytes32` | 全局唯一请求标识 `keccak256(namespace, nonce, srcHeight)` |
| `srcChainID` | `bytes32` | 源链标识 `keccak256("fabric-mychannel")` |
| `dstChainID` | `bytes32` | 目标链标识 `keccak256("evm-31337")` |
| `srcEmitter` | `bytes32` | 源链事件发射者 `keccak256("xcall")` |
| `dstContract` | `address` | 目标 `TargetContract` 地址 |
| `payload` | `bytes` | ABI 编码业务负载 `(string op, string recordId, string actor, string amount, string metadata, bool requireAck)` |
| `payloadHash` | `bytes32` | `keccak256(payload)`，链上校验负载完整性 |
| `srcHeight` | `uint64` | 源链区块高度（Fabric = blockNumber，EVM = block.number） |
| `nonce` | `uint64` | 源链交易序号 |

**ABI Tuple**: `(uint8, uint8, uint8, uint16, bytes32, bytes32, bytes32, bytes32, address, bytes, bytes32, uint64, uint64)`

### 链下传输字段（不进入合约，供 TEE/Relayer 使用）

| 字段 | 类型 | 说明 |
|------|------|------|
| `txId` | `string` | 源链交易原始 ID（TEE 用它做独立源链查询） |
| `createdAt` | `string` | XMsg 创建时间 ISO 8601 |
| `payloadDecoded` | `object` | 负载解码后可读对象 `{ op, recordId, actor, amount, metadata, requireAck }` |
| `teePubKey` | `address` | TEE 以太坊地址（初始 `0x00...`，TEE 签名后填入） |
| `_blockData` | `object` | 可选的区块数据 `{ signedBlockBytes }`，用于 TEE 本地验证 |

### 证明数据（链下，附在 XMsg 上传输）

| 字段 | 说明 |
|------|------|
| `v3Proof.signatures[]` | N 个 ECDSA 签名（每个 65 字节），链上 `ecrecover` 逐条验证 |
| `v3Proof.signerAddresses[]` | 签名者地址（已排序，用于链上注册） |
| `v3Proof.consensusMessage` | 签名者签名的共识消息 |
| `v3Proof.threshold` | 阈值，当前固定 `3`（3/4） |
| `v3Proof.validatorSetId` | 验证者集合标识 |
| `proofMeta` | 元数据：`proofType: 'hybrid-v3'`，`signatureScheme: 'ecdsa-threshold-v3'` |

附带的证明数据（不进入合约 tuple）：

| 字段 | 说明 |
|------|------|
| `v3Proof.signatures[]` | N 个 ECDSA 签名（每个 65 字节），链上 ecrecover 逐条验证 |
| `v3Proof.consensusMessage` | 签名者签名的共识消息 |
| `v3Proof.signerAddresses[]` | 签名者地址（已排序，用于链上注册） |
| `v3Proof.threshold` | 阈值（3/4） |
| `proofMeta` | 链下元数据：`proofType: 'hybrid-v3'`, `signatureScheme: 'ecdsa-threshold-v3'` |

## XMsg 处理流程（V3）

### 正向链路（Fabric → EVM）

1. Fabric 链码 `xcall.EmitXCall` 发出 `XCALL` 事件。
2. `fabric-listener` 捕获 txId、blockNumber、业务负载，构造基础 XMsg。
3. `consensus-aggregator` 向 4 个 validator 请求 ECDSA 签名。/v3-aggregate 收集 ≥3 个签名。
4. `tee-verifier` 的 `/attest` 端点收到 XMsg：
   - 独立连接 Fabric peer，通过 QSCC `GetBlockByTxID(txId)` 查询
   - 解码 protobuf Block，验证区块号匹配
   - 验证通过后对 `attestDigest = keccak256(reportHash, teePubKey)` 签名
5. `relayer` 将 `XMsg + signatures[] + teePubKey + reportHash + teeSig` 提交到 `VerifierContractV3.submit()`。
6. 链上双重验证：
   - **路径A**：`ecrecover` 逐条验证 ECDSA 签名 → 去重计数 ≥ 3/4
   - **路径B**：`ecrecover(attestDigest, teeSig) == teePubKey` → TEE 在白名单中
   - 两条路径均通过 → 执行 `TargetContract.execute()`

### 闭环 ACK 链路（EVM → Fabric）

1. TargetContract 发出 `BusinessExecuted` 事件（`requireAck=true`）。
2. 从 EVM 收据构建 ACK XMsg，EVM 验证者集合产生 ECDSA 签名。
3. TEE `/attest` 独立查询 EVM RPC 验证交易收据存在。
4. ACK 守护进程将回执提交到 Fabric 链码 `ConfirmAckXMsg`。

## V3 双重独立验证

### 链上合约验证逻辑

```
VerifierContractV3.submit():

  路径A — 签名者共识（链上 ecrecover 逐条验证）:
    for each sig in signatures[]:
      signer = ecrecover(consensusMessage, sig)
      require(registeredSigners[signer])     // 签名者必须在链上注册
    require(uniqueSigners >= 3)               // 去重后 ≥ 3/4

  路径B — TEE 独立验证（链上验 TEE 签名）:
    attestDigest = keccak256(abi.encode(reportHash, teePubKey))
    require(ecrecover(attestDigest, teeSig) == teePubKey)
    require(teeWhitelist[teePubKey])
```

### 为什么不需要 eventProof

TEE 不依赖 eventProof 做验证。TEE 独立连接 Fabric peer，通过 QSCC `GetBlockByTxID` 直接查询交易在 Fabric 账本中是否真实存在。eventProof 被简化为三个字段（txId、blockNumber、channelName），作为 TEE 查询的"坐标"——这些字段本身已在 XMsg 中。

### 攻击防御

| 攻击场景 | 路径A | 路径B（TEE 独立查 Fabric） | 结果 |
|----------|-------|--------------------------|------|
| 全部签名者被控 + 伪造 eventProof | ❌ 可通过 | ✅ TEE 查 Fabric，伪造 txId 不存在 | **阻止** |
| TEE 被控 | ✅ 攻击者无 signer 私钥 | ❌ | **阻止** |
| 签名者+TEE 同时被控 | ❌ | ❌ | 攻击成功 |

## 运行要求

- Windows 10/11 + PowerShell
- Docker Desktop
- Node.js 20+
- 空闲端口：7050-7054、8051-8052、9051-9052、10051-10052、9101-9104、9200、9301-9304、9000、8545

## 快速开始

### 一键启动

```powershell
.\start.ps1                    # 完整闭环测试
.\start.ps1 -TestMode forward  # 仅正向测试
.\start.ps1 -SkipSetup         # 跳过初始化
```

或在 cmd 中：

```cmd
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

等价 npm 命令：

```powershell
npm.cmd run start              # 完整闭环
npm.cmd run start:forward      # 仅正向
```

### 手动分步启动

```powershell
npm install
powershell -ExecutionPolicy Bypass -File fabric-network\scripts\bootstrap.ps1
npm.cmd run fabric:wallet
npm.cmd run fabric:up
npm.cmd run fabric:channel
npm.cmd run fabric:cc:deploy
docker compose -f docker-compose.fabric.yml up -d fabric-listener
docker compose up -d evm-node
docker compose up -d tee-verifier
npm.cmd run deploy
docker compose -f docker-compose.fabric.yml restart fabric-listener
node scripts/run-all-tests.js full
```

## 测试

### 正向测试（Fabric → EVM）

```powershell
node scripts/run-fabric-e2e-tests.js
```

### 闭环测试（Fabric → EVM → Fabric ACK）

```powershell
node scripts/run-full-suite.js
```

### 合并测试（正向 + 闭环）

```powershell
node scripts/run-all-tests.js full
npm.cmd run fabric:test         # 默认正向+闭环
```

### 组件测试

```powershell
node scripts/test-hybrid-bridge.js
```

### 结果文件

| 文件 | 说明 |
|------|------|
| `runtime/test-summary.md` | 格式化表格汇总（正向 + 闭环） |
| `runtime/fabric-hybrid-e2e-results.json` | 正向测试 JSON |
| `runtime/fabric-full-roundtrip-results.json` | 闭环测试 JSON |

## 最新测试结果（V3 — 门限 ECDSA）

### 正向测试（Fabric → EVM）8/8 ✅

| 用例 | Gas | 端到端时延 | 字段 | 状态 |
|------|-----|-----------|------|------|
| FABRIC-001 | 692,805 | 12,390ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-002 | 612,284 | 2,794ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-003 | 522,963 | 2,753ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-004 | 522,156 | 2,702ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-005 | 522,491 | 2,736ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-006 | 522,091 | 2,771ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-007 | 521,729 | 2,777ms | ✅/✅/✅/✅ | ✅ |
| FABRIC-008 | 522,442 | 2,779ms | ✅/✅/✅/✅ | ✅ |
| **平均（稳定）** | **~522k** | **2,759ms** | | |

### 闭环测试（Fabric → EVM → Fabric ACK）8/8 ✅

| 用例 | 正向 Gas | ACK | 总耗时 | 状态 |
|------|----------|-----|--------|------|
| FABRIC-001~008 | 470,436~560,955 | 8/8 confirmed | 4,996~5,366ms | ✅ |
| **平均** | **~485k** | **8/8** | **5,076ms** | **8/8** |

## 签名方案：门限 ECDSA

当前 V3 采用 **链上 ecrecover 逐条验证** 的门限签名方案：

- 4 个验证节点各自用独立 ECDSA 私钥对 `consensusMessage` 签名
- 聚合器并行收集 ≥3 个签名后返回
- 链上 `VerifierContractV3` 逐条 `ecrecover` 验证，去重计数 ≥ 3/4
- 阈值执行在**链上**，聚合器无法绕过

| 优势 | 说明 |
|------|------|
| 链上阈值执行 | 攻击者无法通过控制聚合器绕过 3/4 要求 |
| 安全边界清晰 | 必须同时攻破 ≥3 个独立私钥 + TEE 才能伪造消息 |
| Gas 可接受 | N=4 时仅 ~12,000 gas（4 × ecrecover） |
| 无单点故障 | 聚合器只做收集，不持有任何私钥 |

注：MPC-TSS 和 FROST 阈值 Schnorr 方案因所有可用 Node.js MPC 库均有版本兼容性问题，暂时不可用。详见 `docs/mpc-tss-upgrade.md`。

## TEE 验证机制

TEE `/attest` 端点采用**本地区块验证 + QSCC/RPC 降级**的双模式：

| 模式 | Fabric | EVM |
|------|--------|-----|
| 本地验证 | protobuf 解码 → 验 block.number → 验 previous_hash 链连续 → 验 txId 在 block.data 中 | 验 blockHash 自洽 → 验 parentHash 链连续 → 验 receipt.transactionHash 匹配 |
| 降级查询 | Gateway → QSCC.GetBlockByTxID → 同上本地验证 | RPC getTransactionReceipt → 验 receipt 存在 |

轻量化验证方案详见 `docs/tee-lightweight-verification.md`。

## 常用命令

```powershell
npx hardhat compile
npm.cmd run deploy
npm.cmd run fabric:wallet
npm.cmd run fabric:up
npm.cmd run fabric:channel
npm.cmd run fabric:cc:deploy
node scripts/run-all-tests.js full
node scripts/run-fabric-e2e-tests.js
node scripts/run-full-suite.js
node scripts/test-hybrid-bridge.js
docker compose -f docker-compose.fabric.yml up -d fabric-listener
docker compose -f docker-compose.fabric.yml down -v
docker compose up -d evm-node tee-verifier
```
