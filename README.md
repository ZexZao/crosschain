# Cross-Chain Trusted Transport Prototype

## 项目概述

本项目是一个面向异构区块链跨链调用的可信传输实验原型。当前主线已经从旧版 `XMsg + validator 多签 + VerifierContractV3` 改造为：

```text
h-xmsg + h-FSV + MELV-EF + 4 节点模拟 TEE 集群 + 目标链轻量验证
```

当前已实现到改造方案的第四阶段：

1. 引入链无关的 `h-xmsg` 消息结构。
2. 完成 Fabric → EVM 正向链路。
3. Fabric 源链侧采用 h-FSV 思路，将跨链事件状态化。
4. TEE 模拟服务通过 Fabric adapter 获取 h-FSV 状态视图，验证 Fabric peer endorsement、MSP 身份、验证策略、具体交易存在性、交易有效性和写集内容。
5. EVM 目标链不再验证 Fabric 复杂证明，只验证 TEE 对完整 `hmsgDigest` 与压缩执行字段组成的 `deliveryDigest` 的签名、防重放、过期时间和目标执行摘要。
6. 完成 EVM → Fabric 主线：EVM 源合约发标准事件，TEE 通过 MELV-EF adapter 验证 receipt/log/header/finality，Fabric 链码验证 TEE quorum 后执行。
7. TEE 从单节点升级为 4 节点模拟集群，节点地位平等，任意节点均可作为本轮 proposer 发起共识，默认阈值为 3/4。

当前未实现的部分：

- h-xmsg 已加入协议级 `feedback` 策略字段；ACK / RESPONSE 的闭环执行器仍将在后续阶段接入。
- 当前 TEE 仍为 Node.js 模拟服务，接口按后续真实 TEE/服务器部署预留；共识层已经实现 Raft 风格的 RequestVote、AppendEntries、leader election、heartbeat、日志复制和 commitIndex。
- Mercury 中的辅助 TEE 轮换委员会当前由单节点 `tee-header-helper` 替代，后续可替换为正式委员会方案。
- Fabric MSP 多组织背书策略目前按本地单组织 Fabric 网络实现为 `Org1MSP` 策略，接口保留多组织扩展。

## 当前实现程度

### 已完成

| 能力 | 当前状态 |
|---|---|
| h-xmsg 通用消息结构 | 已实现，位于 `shared/hxmsg/` |
| h-xmsg feedback 策略字段 | 已实现，`required / expectedMsgType / timeout / callbackRefHash` 参与 hmsgDigest |
| Fabric → EVM h-xmsg builder | 已实现，位于 `hxmsg-builder/fabric-to-evm.js` |
| Fabric 链码状态化跨链事件 | 已实现，写入 `crosschainEvents:{requestID}` |
| Fabric 状态查询接口 | 已实现，`QueryCrosschainEvent(requestID)` |
| h-FSV TEE adapter | 已实现，位于 `tee-verifier/adapters/fabric-hfsv-adapter.js` |
| Fabric peer 背书视图验证 | 已实现，向 4 个 peer 查询同一 h-FSV view，验证 endorsement 签名和 MSP 归属 |
| Fabric h-FSV policyHash | 已实现，策略内容包含安全域、channel、chaincode、requiredOrgs、MSP 根证书摘要、允许查询函数 |
| Fabric block 具体交易验证 | 已实现，解析 block envelope，匹配 txId，检查 VALID，检查写集 |
| EVM 轻量目标网关 | 已实现，`contracts/HXMsgGateway.sol`，主路径使用 `HXMsgMinimal` |
| EVM gas 第三阶段优化 | 已实现，轻量目标合约 + payload hash-first + 压缩链上 h-xmsg |
| TEE 注册表 | 已实现，`contracts/TEERegistry.sol` |
| EVM → Fabric h-xmsg builder | 已实现，位于 `hxmsg-builder/evm-to-fabric.js` |
| MELV-EF TEE adapter | 已实现，位于 `tee-verifier/adapters/evm-melv-adapter.js` |
| EVM header helper | 已实现，`tee-verifier/header-helper.js`，当前为单节点辅助 TEE 替代物 |
| 4 TEE / Raft 集群 | 已实现，4 个 TEE 节点，支持 leader election、heartbeat、日志复制、commitIndex，默认 3/4 quorum |
| Fabric h-xmsg 入站执行 | 已实现，`ExecuteHXMsg` |
| Fabric TEE registry | 已实现，`RegisterTrustedTEE / QueryTrustedTEE` |
| 8 条 Fabric → EVM 测试 | 已通过，结果保存在 `runtime/` |
| EVM → Fabric 测试 | 已通过，结果保存在 `runtime/` |
| Ubuntu/Docker Compose 运行路径 | 已切换为 Bash / Node / Docker Compose |

### h-FSV 验证目前做到的程度

TEE 的 Fabric adapter 不是只验证区块号或区块存在，而是执行以下检查：

1. 根据 `h-xmsg.sourceRef.encodedRef` 定位 Fabric 状态对象。
2. 根据本地可信策略计算 `policyHash`，要求与 h-xmsg 中的 `policyRef.policyHash` 一致。
3. 向 Fabric peers 发送同一个 `QueryCrosschainEvent(requestID)` proposal，获取 h-FSV view。
4. 要求多个 peer 返回完全一致的 payload。
5. 解析每个 peer response 的 `endorsement.endorser`，提取 MSP ID 和 peer 证书。
6. 使用 Fabric MSP 根证书校验证书归属，并验证 endorsement 签名。
7. 汇总 endorser MSP 集合，检查是否满足 h-FSV verification policy。
8. 构造 `viewMeta / payload / payloadHash / endorsements[]` 形式的 h-FSV 视图摘要。
9. 校验 Fabric 状态记录中的 `requestID`、`sourceTxID`、`nonce`、`expireAt`、`callDataHash`、`targetObject`、`functionSelector`、`receiver`。
10. 重新计算 `sourcePayloadHash` 和 `businessPayloadHash`，要求与 h-xmsg 绑定字段一致。
11. 通过 QSCC `GetBlockByTxID` 获取 Fabric block。
12. 解码 Fabric protobuf block，找到指定 `txId`。
13. 检查该交易的 validation code 为 `VALID`。
14. 解码交易 action 和 rwset，检查该交易实际写入了 `crosschainEvents:{requestID}`。
15. 检查 `feedback.required` 与业务 payload 的 `requireAck` 一致。
16. 验证通过后，TEE 对 `deliveryDigest` 进行 ECDSA 签名；`deliveryDigest` 由完整 `hmsgDigest` 和目标链最小执行字段共同计算。

这意味着伪造一个存在的区块、但区块里没有目标交易，交易没有写入目标状态，或者只有未被 MSP 信任的 peer response，都不会通过 TEE 验证。

### 目标链目前做到的程度

EVM 侧 `HXMsgGateway` 只做轻量验证。当前主路径使用 `HXMsgMinimal`，完整 h-xmsg 保存在链下并由 TEE 通过 `hmsgDigest` 绑定：

1. `requestID` 防重放。
2. `expireAt` 过期检查。
3. `targetChainID` 检查。
4. `targetObject` 与实际目标合约地址一致性检查。
5. `keccak256(callData) == callDataHash`。
6. 重新计算 `targetExecutionHash`。
7. 检查 certification 中的 `hmsgDigest` 与提交的 `HXMsgMinimal.hmsgDigest` 一致。
8. 重新计算 `deliveryDigest` 并验证 TEE 签名。
9. 检查 TEE 地址已注册到 `TEERegistry`。
10. 检查 feedback 策略字段的规范性。
11. 调用目标业务合约 `TargetContract.execute(requestID, callData)`。

EVM 不直接验证 Fabric block、Fabric endorsement、MSP 证书或 FabricView 原文。

### MELV-EF 验证目前做到的程度

TEE 的 EVM adapter 参考 Mercury 的轻客户端思想，不信任 relayer 直接提交的证明材料，而是执行以下检查：

1. 根据 `h-xmsg.sourceRef.encodedRef` 定位 EVM `txHash / blockNumber / blockHash / logIndex / sourceContract`。
2. 通过 EVM RPC 获取 receipt 和 block。
3. 调用 `tee-header-helper` 检查区块头哈希，并维护本地 EVM header state。
4. 检查 receipt 的 `blockHash / blockNumber` 与 sourceRef 一致。
5. 检查确认数满足 EVM finality policy。
6. 解析指定 log。
7. 检查 log address 是可信 `EvmSourceContract`。
8. 检查 topic0 是 `CrossChainCallRequested`。
9. 检查事件参数与 h-xmsg 的 `header / target / targetAction / payloadBinding` 一致。
10. 重新计算 `sourcePayloadHash` 和 `targetExecutionHash`。
11. 4 个 TEE 节点通过 Raft 复制同一 h-xmsg 共识日志；leader election 后由 leader 发起 AppendEntries，达到 Raft majority 后提交，提交节点才签名并形成 `teeClusterCertification`。

Fabric 目标链只验证 TEE quorum、`hmsgDigest`、防重放、过期时间、目标 Fabric chainID/domain、目标 chaincode、`callDataHash` 和 `targetExecutionHash`。

## 当前架构

```text
Fabric chaincode
  |
  | EmitXCall: writes crosschainEvents:{requestID}, emits XCALL
  v
Fabric listener
  |
  | builds h-xmsg
  v
TEE verifier
  |
  | fabric-hfsv-adapter:
  |   - QueryCrosschainEvent
  |   - peer endorsement signature verification
  |   - MSP and verification policy verification
  |   - GetBlockByTxID
  |   - txId / VALID / rwset verification
  v
TEE certification
  |
  | hmsgDigest + deliveryDigest signature
  v
HXMsgGateway on EVM
  |
  | verifies TEE signature and target execution hash
  v
TargetContract.execute()
```

## 主要目录

| 路径 | 说明 |
|---|---|
| `shared/hxmsg/` | h-xmsg 枚举、编码、摘要计算和链上 tuple 转换 |
| `hxmsg-builder/fabric-to-evm.js` | Fabric event/state 到 h-xmsg 的构造逻辑 |
| `hxmsg-builder/evm-to-fabric.js` | EVM receipt/log 到 h-xmsg 的构造逻辑 |
| `tee-verifier/adapters/fabric-hfsv-adapter.js` | h-FSV 验证主逻辑 |
| `tee-verifier/adapters/evm-melv-adapter.js` | MELV-EF 验证主逻辑 |
| `tee-verifier/header-helper.js` | 模拟辅助 TEE 区块头维护节点 |
| `tee-verifier/adapters/fabric-block.js` | Fabric block / transaction / rwset 解码验证 |
| `tee-verifier/core/certification.js` | TEE 证明签名生成 |
| `contracts/HXMsgGateway.sol` | EVM 目标链轻量验证网关 |
| `contracts/HXMsgLib.sol` | 链上 h-xmsg 压缩结构和 digest 计算 |
| `contracts/TEERegistry.sol` | TEE 地址注册表 |
| `contracts/TargetContract.sol` | 轻量目标执行确认合约，只接受 Gateway 调用并记录 requestID/payloadHash |
| `fabric-chaincode/xcall/index.js` | Fabric 跨链链码 |
| `scripts/run-hxmsg-forward-tests.js` | 当前主线 8 条 Fabric → EVM 测试 |
| `scripts/run-evm-fabric-tests.js` | EVM → Fabric MELV-EF 测试 |
| `docs/hxmsg-project-refactor-plan.md` | 本次改造方案文档 |
| `docs/stage4-melv-ef-evm-to-fabric-implementation.md` | 第四阶段实现说明 |
| `docs/mercury-like-equal-tee-consensus.md` | 平等 TEE quorum 共识改造说明 |
| `docs/raft-tee-cluster-implementation.md` | Raft TEE 集群实现说明 |
| `docs/raft-unimplemented-items.md` | Raft 未实现与待增强项 |

## h-xmsg 结构

当前 h-xmsg 由以下模块组成：

```text
HXMsg {
  header,
  source,
  target,
  sourceRef,
  targetAction,
  verification,
  payloadBinding,
  feedback
}
```

核心含义：

| 模块 | 作用 |
|---|---|
| `header` | 协议版本、requestID、消息类型、nonce、创建时间、过期时间 |
| `source` | 源链类型、源链 ID、安全域 ID |
| `target` | 目标链类型、目标链 ID、安全域 ID |
| `sourceRef` | 源链事实定位信息，Fabric 场景下指向 `QueryCrosschainEvent(requestID)` |
| `targetAction` | 目标链执行对象、函数选择器、调用参数哈希、接收方 |
| `verification` | TEE 验证方法、最终性模型、策略引用、adapterID |
| `payloadBinding` | 源链状态哈希、业务语义哈希、目标执行哈希 |
| `feedback` | 请求级反馈策略，描述是否需要 ACK/RESPONSE、期望反馈类型、反馈超时和回调引用哈希 |

### h-xmsg 核心子结构

`header` 描述消息基础信息：

| 字段 | 说明 |
|---|---|
| `version` | 协议版本 |
| `requestID` | 全局唯一请求 ID，也是目标链防重放主键 |
| `msgType` | 消息类型：`CONTRACT_CALL`、`RESPONSE`、`ACK`、`CHALLENGE` |
| `nonce` | 请求随机数，用于绑定源链查询上下文 |
| `createdAt` | 消息创建时间 |
| `expireAt` | 消息过期时间 |

`sourceRef` 只保存源链事实定位信息和哈希，不保存完整证明材料。Fabric 场景中 `encodedRef` 指向 `QueryCrosschainEvent(requestID)`，TEE 根据它主动获取 h-FSV。

`targetAction` 描述目标链执行语义，包括目标对象、函数选择器、调用参数哈希和接收方。目标链执行前必须检查实际 `callData` 的哈希等于 `callDataHash`。

`verification` 描述 TEE 应采用的验证方式、最终性模型和策略引用。完整策略不写入 h-xmsg，只通过 `policyID + policyHash` 绑定到 TEE 本地可信策略。

`payloadBinding` 将源链事实、业务语义和目标执行绑定为三个摘要：

| 字段 | 说明 |
|---|---|
| `sourcePayloadHash` | 源链状态、事件或交易语义哈希 |
| `businessPayloadHash` | 业务层语义哈希 |
| `targetExecutionHash` | 目标链执行摘要哈希 |

`feedback` 是本次规范化新增的请求级反馈策略：

| 字段 | 说明 |
|---|---|
| `required` | 是否需要反馈消息 |
| `expectedMsgType` | 期望反馈类型：`0 = NONE`、`2 = RESPONSE`、`3 = ACK`、`4 = CHALLENGE` |
| `timeout` | 反馈超时时间；`0` 表示不在当前目标链侧强制反馈期限 |
| `callbackRefHash` | 回调目标、原请求引用或反馈路由信息的哈希；不直接携带链特定回调原文 |

当 `feedback.required = false` 时，链上压缩结构要求 `expectedMsgType = 0`、`timeout = 0`、`callbackRefHash = 0x0`，避免不同表示方式导致 digest 歧义。当前 Fabric -> EVM 正向测试都使用 `required = false`；后续 ACK / RESPONSE 闭环会使用该字段作为协议层依据，而不是只依赖业务 payload 里的 `requireAck`。

TEE 先验证完整 h-xmsg 与 h-FSV，再对 `deliveryDigest` 签名。`deliveryDigest` 包含完整 `hmsgDigest`、`requestID`、目标链、目标对象、函数选择器、`callDataHash`、`targetExecutionHash`、`feedback` 和 `expireAt`。这样 EVM 侧可以提交压缩的 `HXMsgMinimal`，但 relay 不能把一条已认证 h-xmsg 篡改成另一个目标调用。

## Fabric 链码状态

`EmitXCall` 现在要求 payload 中包含目标执行绑定信息，例如：

```json
{
  "businessPayload": {
    "op": "asset_lock",
    "assetId": "FABRIC-ASSET-0001",
    "owner": "org1.userA",
    "amount": "128.50",
    "requireAck": false
  },
  "targetChainType": "EVM",
  "targetChainID": "0x...",
  "targetObject": "0x...",
  "functionSelector": "0x...",
  "callDataHash": "0x...",
  "businessPayloadHash": "0x...",
  "receiver": "0x...",
  "feedbackTimeout": 0,
  "callbackRefHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "expireAt": 1778846812
}
```

链码写入：

```text
crosschainEvents:{requestID}
```

并提供查询：

```text
QueryCrosschainEvent(requestID)
```

## 运行要求

当前主路径面向 Ubuntu：

- Ubuntu / WSL Ubuntu
- Docker Desktop 已启动
- Node.js 20+
- npm
- Docker Compose v2

端口：

- Fabric: `7050-7054`, `8051-8052`, `9051-9052`, `10051-10052`
- EVM: `8545`
- TEE: `9000`

## 快速运行

### 1. 安装依赖

```bash
npm install
```

### 2. 生成 Fabric crypto/channel artifacts

```bash
docker compose -f docker-compose.fabric.yml run --rm fabric-tools \
  bash /fabric-network/fabric-network/scripts/bootstrap.sh
```

如果是从旧 Windows runtime 克隆过来，遇到权限或损坏账本问题，可以清理 runtime 后重建：

```bash
docker compose -f docker-compose.fabric.yml down -v --remove-orphans
docker run --rm -v "$PWD":/work -w /work alpine sh -c \
  'rm -rf fabric-network/runtime/ca fabric-network/runtime/organizations fabric-network/runtime/system-genesis-block fabric-network/runtime/channel-artifacts fabric-network/runtime/peer0.org1.example.com fabric-network/runtime/peer1.org1.example.com fabric-network/runtime/peer2.org1.example.com fabric-network/runtime/peer3.org1.example.com fabric-network/wallet/*'
docker compose -f docker-compose.fabric.yml run --rm fabric-tools \
  bash /fabric-network/fabric-network/scripts/bootstrap.sh
```

### 3. 启动 Fabric 网络

```bash
docker compose -f docker-compose.fabric.yml up -d \
  fabric-ca.org1.example.com \
  orderer.example.com \
  peer0.org1.example.com \
  peer1.org1.example.com \
  peer2.org1.example.com \
  peer3.org1.example.com \
  fabric-tools
```

### 4. 创建 channel

```bash
docker exec fabric-tools bash /fabric-network/fabric-network/scripts/create-channel.sh
```

### 5. 导出 Fabric wallet

```bash
node scripts/export-fabric-wallet.js
```

如果遇到 root 生成文件导致的权限问题：

```bash
docker run --rm -v "$PWD":/work -w /work alpine sh -c \
  'chown -R 1000:1000 fabric-network/runtime fabric-network/wallet runtime'
node scripts/export-fabric-wallet.js
```

### 6. 部署 Fabric chaincode

```bash
docker exec fabric-tools bash /fabric-network/fabric-network/scripts/deploy-chaincode.sh
```

### 7. 启动 EVM 和 TEE

```bash
docker compose up -d evm-node tee-verifier
```

等待 Hardhat RPC 出现：

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  http://127.0.0.1:8545
```

### 8. 部署 EVM 合约

```bash
npm run deploy
```

### 9. 启动 Fabric listener

```bash
FABRIC_CONNECTION_PROFILE=fabric-network/connection-org1.json \
FABRIC_WALLET_PATH=fabric-network/wallet \
FABRIC_AS_LOCALHOST=true \
FABRIC_CHANNEL=mychannel \
FABRIC_CHAINCODE=xcall \
node source-chain/fabric-listener.js
```

### 10. 运行当前主线测试

在另一个终端运行：

```bash
npm run hxmsg:test:forward
```

运行 EVM → Fabric：

```bash
npm run hxmsg:test:evm-fabric
```

等价命令：

```bash
npm run fabric:test
npm run fabric:test:forward
```

## 测试结果

最新一次测试结果：

```text
h-xmsg / h-FSV Fabric → EVM: 8/8 PASS
EVM提交: HXMsgMinimalCluster
目标合约: 轻量 TargetContract
TEE adapter: fabric-hfsv
TEE quorum: 4/3 reached
Peer 背书: 4
MSP: Org1MSP
交易写集检查: checked
Gas区间: 130,982 - 132,491
稳定区间: 约 131k - 132k

h-xmsg / MELV-EF EVM → Fabric: 1/1 PASS
TEE adapter: evm-melv-ef
TEE quorum: 4/3 reached
Fabric 状态: executed
```

结果文件：

| 文件 | 说明 |
|---|---|
| `runtime/hxmsg-fabric-evm-results.json` | 8 条测试 JSON 结果 |
| `runtime/hxmsg-test-summary.md` | Markdown 表格汇总 |
| `runtime/hxmsg-evm-fabric-results.json` | EVM → Fabric 测试 JSON 结果 |
| `runtime/hxmsg-evm-fabric-summary.md` | EVM → Fabric Markdown 汇总 |

最新摘要：

| 用例 | 业务 | 金额 | Fabric 区块 | EVM Gas | TEE 验证 | TEE Quorum | Peer 背书 | MSP | 交易写集 | 目标执行 | 状态 |
|---|---|---:|---:|---:|---|---:|---:|---|---|---|---|
| FABRIC-001 | asset_lock | 128.50 | 190 | 130,982 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-002 | mint_confirm | 980.00 | 191 | 132,491 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-003 | receivable_attest | 285000.00 | 192 | 131,597 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-004 | logistics_sync | -18.6 | 193 | 131,465 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-005 | medical_consent | 30 | 194 | 131,583 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-006 | oracle_update | 0.1387 | 195 | 131,369 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-007 | approval_commit | 2 | 196 | 130,982 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |
| FABRIC-008 | subsidy_confirm | 46250.00 | 197 | 131,679 | fabric-hfsv | 4/3 | 4 | Org1MSP | checked | requestID/payloadHash | PASS |

## 常用命令

```bash
npx hardhat clean
npx hardhat compile
npm run deploy
npm run hxmsg:test:forward
npm run hxmsg:test:evm-fabric
npm run fabric:test
docker compose up -d evm-node tee-header-helper tee-verifier tee-verifier-2 tee-verifier-3 tee-verifier-4
docker compose -f docker-compose.fabric.yml up -d fabric-tools
docker compose -f docker-compose.fabric.yml down -v
```

## 当前删除和停用的旧路径

本次改造删除了旧主线文件：

- `contracts/VerifierContract*.sol`
- `proof-builder/*`
- 旧 V3 / BLS / MPC 测试脚本
- Windows PowerShell 启动脚本

`relayer/index.js` 目前只保留为 legacy guard。当前测试脚本直接完成 h-xmsg 构造、TEE attestation 和 EVM submit。后续阶段会将它整理为正式 h-xmsg router。

## 下一阶段计划

第五阶段建议实现：

1. ACK / RESPONSE 统一建模。
2. 补齐生产级 Raft 能力：故障注入、snapshot、log compaction、InstallSnapshot、WAL 和网络分区恢复测试，详见 `docs/raft-unimplemented-items.md`。
3. Mercury 辅助 TEE 轮换委员会替换当前单节点 header-helper。
4. 多 TEE threshold / cluster key 上链验证，减少目标链逐签名管理。
5. EVM receipt MPT proof 或 finalized checkpoint 验证。
6. h-xmsg 安全测试套件：篡改、重放、未注册 TEE、源链事实不存在、最终性不足。
