# 项目实现合理性与安全边界审计报告

> 审计日期：2026-08-19  
> 审计对象：`crosschain_experiment` 当前本地版本  
> 审计重点：TEE 身份与注册、Raft 共识、源链事实证明、业务合约真实性、挑战响应与原子性、自动化路径及论文实验有效性

## 1. 审计目的

本报告从项目的设计初衷出发，检查当前实现是否存在以下不合理情况：

- 多个 TEE 实际共享同一身份或同一签名密钥；
- Raft 只有形式上的接口，没有真实执行选举、日志复制和多数派提交；
- 智能合约只修改状态字段，没有发生真实资产或业务动作；
- TEE 接受由中继者自洽伪造的 h-xmsg、证明或 ResponseProof；
- challenge、response、补偿和回滚只在测试脚本中拼接，未形成可靠的系统闭环；
- 本地模拟能力被错误描述为真实 TEE、真实远程证明或生产级安全能力；
- 旧路径绕过 automation、TEE quorum 或源链证明，使实验结果失真。

审计结论用于指导后续工程整改和论文表述，不等同于形式化安全证明或第三方安全认证。

## 2. 总体结论

当前项目已经不是“所有 TEE 使用一个签名、Raft 完全没有运行、业务合约全部为空壳”的简单模拟：各 TEE 节点拥有独立 ECDSA 密钥，TEE 子网中存在选举、日志复制、法定人数提交和节点独立验证；Ethereum、Fabric、Avalanche 三类源链事实证明也分别形成了可执行路径；资产转账、托管退款等路径会执行真实合约动作。

但是，项目仍然属于**研究原型**，还不能宣称已经达到生产级可信跨链系统。ResponseProof 对目标链和目标网关的强绑定已于 2026-08-28 完成整改；当前主要安全边界转为：模拟 TEE 注册无法证明正确程序确实运行在真实可信硬件中；资产跨链的源端授权与价值守恒没有完整闭环；challenge 超时与 response 可用性之间仍存在双重结果风险。Raft 虽然真实运行了核心流程，但持久化、节点间身份隔离、成员变更和故障模型仍不充分。

因此，论文中可以将其描述为“支持多链事实证明、TEE 子网共识、真实业务动作和自动化中继的系统原型”，但不应将当前版本表述为“已实现生产级远程证明”“严格原子资产桥”或“在任意中继者审查下均不会产生双重结果”。

## 3. 严重问题

### 3.1 ResponseProof 目标链和目标网关绑定（已整改）

整改前，ResponseProof 的 EVM 检查主要验证事件主题、请求标识和收据证明，但缺少对 `log.address`、目标链安全域和授权目标网关的强绑定；Fabric 的通道、链码和执行记录也未形成统一绑定。

当前实现采用 `targetExecutionHash V2` 和目标执行域：EVM/Avalanche 的域由目标链类型、链 ID 和 `HXMsgGateway` 地址计算，Fabric 的域由 Fabric chain ID 和目标 chaincode 计算。源链事件、canonical h-xmsg、TEE 证书、目标网关和 ResponseProof 使用同一组目标上下文。

TEE 对 EVM-compatible 目标执行会验证 receipt MPT proof，并只接受授权网关地址发出的扩展 `HXMsgAccepted` 事件；事件同时绑定 `requestID`、`hmsgDigest`、`targetExecutionHash`、实际目标合约和执行返回值哈希。`targetProofRefHash` 进一步覆盖目标链类型、链 ID、执行域、网关、交易哈希、区块高度、交易索引、日志索引和事件内容。链标识来自原始 h-xmsg 与 TEE 子网路由，不再信任 relayer 自报的 `evmChainID`。

Fabric response 使用独立 h-FSV policy，只允许 `GetInboundStatus`，并绑定 channel、chaincode、MSP policy、状态键、执行交易、目标域、目标对象和业务执行结果。源链生命周期还会校验 RESPONSE 证书确实来自原请求目标链对应的 TEE 子网。

相关位置：

- `tee-verifier/server.js` 中 ResponseProof 解析与 `/attest-response` 路径；
- `automation/handlers.js` 中 response 处理；
- `contracts/ResponseLifecycleBase.sol` 中 response 接收和状态迁移。

已完成的整改：

- 目标 `chainID`、执行域、目标对象和事件类型来自原始 canonical h-xmsg；
- TEE 检查 EVM `log.address`，Fabric 绑定通道、链码、MSP policy 和具体状态记录；
- adapter 输出已验证的 `verifiedChainID / verifiedDomainID / verifiedExecutor`；
- response 摘要和 TEE 证书覆盖目标证明引用、request ID、原始 h-xmsg 摘要、目标执行哈希和业务结果摘要；
- 新增错误网关、错误执行域和 Fabric 执行上下文替换测试，并通过双向原子 RESPONSE automation 实验。

### 3.2 当前 TEE 注册仍是模拟远程证明

当前 attestation provider 可以生成结构化 quote，并由链上 TEERegistry 或 Fabric 链码执行注册校验，但 quote 的信任根仍来自本地模拟配置，不能证明程序运行在 Intel SGX、TDX 或其他真实可信执行环境中，也不能证明运行时镜像与预期代码度量一致。

相关位置：

- `shared/tee/attestation.js`；
- `contracts/TEERegistry.sol`；
- `fabric-chaincode/xcall/index.js` 中 TEE 注册逻辑。

因此目前“注册”真实实现了注册状态机、身份记录和签名者授权，但“远程证明”仍是模拟边界。部署到真实 SGX/TDX 时至少需要增加：硬件 quote 获取、厂商证明链校验、TCB 状态校验、measurement/policy 校验、公钥与 quote 的绑定、防重放 nonce，以及密钥密封和恢复策略。

### 3.3 多个 TEE 身份独立，但缺少硬件级隔离

各 TEE 节点并非使用同一签名：当前容器为节点配置了不同的 ECDSA 私钥，目标链能够验证多个独立签名者达到阈值。这比“一个私钥复制五份”合理。

问题在于这些节点仍运行在同一主机和 Docker 信任域中，代码目录与运行环境可被宿主机统一控制，私钥以普通文件或环境配置形式存在。一个获得宿主机权限的攻击者可能同时读取多个节点密钥、篡改多个容器或伪造法定人数。因此当前五节点只能用于测试协议行为和崩溃故障，不能证明对宿主机攻陷或 TEE compromise 的容忍性。

部署真实 TEE 后，每个实例应生成并密封独立密钥，并将公钥、代码度量、子网标识和节点身份共同绑定进远程证明。若一台物理机运行五个 enclave，它可以模拟五个注册身份和协议节点，但不能作为“五个独立故障域”的安全实验。

### 3.4 资产路径缺少完整的源端授权与价值守恒闭环

当前目标链上的转账、托管和退款会真实调用 token/escrow 合约，并非只有状态字段变化。但是部分常规跨链资产实验只在目标链从储备池转账或铸造资产，没有始终证明源链已执行对应的锁定、销毁或扣款。若源链事件入口允许任意调用者提交消息，还会进一步削弱“消息代表真实用户授权”的论证。

这会造成两类问题：

- 目标链确实发生了真实转账，但没有完整证明资产来自源链上的等值锁定或销毁；
- h-xmsg 证明了某个事件真实存在，却不一定证明该事件来自系统认可的业务入口或满足资产桥的经济约束。

因此需要区分：

- **通用消息互操作**：只要求证明授权源合约发出了确定事件，并在目标链执行动作；
- **资产桥**：还必须实现并证明 `lock-and-release` 或 `burn-and-mint` 的守恒关系、储备池管理、失败退款和最终结算。

源合约是否受信不应只由 TEE 内部写死；更合理的做法是由目标链网关或治理配置维护源安全域、源合约、允许动作及 adapter 版本的授权映射，TEE 只验证事实并将已验证上下文提交给链上策略层。

### 3.5 challenge/response 的可用性闭环尚不完整

watcher 已能扫描超时任务、发起 challenge，并将超时任务分发给补偿 handler；response 也可以由任意 relayer 构造并交给 TEE 验证。这一设计不要求固定的 response relayer，本身是合理的。

但当前系统没有充分保证“目标链已经执行成功，但 response 被持续审查或丢失”时的唯一结果。如果 source watcher 在 deadline 后执行退款，而目标链动作实际已经完成，系统可能同时出现目标链成功和源链补偿。不能仅凭“源链不会永久 pending”推导原子性，因为从 pending 退出到 compensated 并不证明目标链未执行。

需要补齐的不是一个中心化 response 生成器，而是 response 可用性和裁决规则：

- watcher 和任意 relayer 都可从目标链事件生成 ResponseProof；
- challenge 窗口应留出独立 response 提交期；
- 补偿前必须检查是否存在已证明的目标链执行结果；
- 对不可逆目标动作，应采用目标侧 escrow/prepare、源侧确认、目标侧 finalize 的状态机；
- 对可补偿动作，应明确 late response、已补偿状态和重复执行的处理规则。

## 4. 高风险问题

### 4.1 Raft 核心流程存在，但尚非生产级实现

当前 TEE 子网实现了 leader 选举、任期、日志复制、commit index、法定人数提交以及 follower 对源链证明的独立验证，所以不能说 Raft 完全没有运行，也不能因为最终签名格式相同就否定共识过程。

仍存在以下不足：

- 节点间认证主要依赖同一子网共享的 HMAC secret，缺少节点级双向身份和传输加密；
- 日志和状态持久化以普通 JSON 文件为主，缺少 WAL、`fsync`、原子快照和崩溃恢复验证；
- 链上验证主要看阈值签名，未充分绑定 Raft 的 `term`、`index`、membership epoch 和 committed entry；
- 动态成员变更、联合共识、密钥轮换和节点撤销不完整；
- 网络分区、磁盘损坏、重复提交和 leader 崩溃恢复测试不足。

Raft 在这里提供的是崩溃故障一致性和唯一提交顺序，不会自动提供拜占庭容错。TEE 的可信执行和远程证明用于降低节点任意作恶风险，两者的安全假设需要在论文中分开陈述。

### 4.2 TEE 注册可能进入业务热路径

automation 的目标提交路径可能在发现签名者尚未注册时临时执行注册。这会让普通 relayer 依赖 registry owner 权限，也会把成员管理、业务执行和测试便利逻辑混在一起。

TEE 注册、轮换和撤销应由独立治理/运维流程完成；业务 relayer 只读取当前 epoch 的成员快照并提交已经满足阈值的证书。实验脚本可以显式调用部署和注册阶段，但不能在每笔业务交易中隐式补注册。

### 4.3 成员阈值可被管理者降级

如果 registry owner 可以移除节点后立即以剩余成员重新计算阈值，系统可能从 `3/5` 悄然退化为 `1/1`。旧 epoch 的映射、签名者撤销状态和在途消息如何处理也需要明确。

建议采用版本化 membership epoch：成员更新需要治理批准和生效延迟；证书绑定 epoch；阈值有协议下限；旧 epoch 只能在有限过渡窗口内验证，且不能被重放到新 epoch。

Fabric 侧注册权限也不应仅以任意 Org1 客户端身份作为充分条件，应绑定专门 registrar MSP role 或治理背书策略。

### 4.4 TEE 未在所有入口强制重算 canonical h-xmsg 摘要

如果 TEE 接受中继者同时提供 h-xmsg 和 `hmsgDigest`，但没有在所有路径重新执行 canonical 编码并核对摘要，攻击者可以把二者一起修改为内部自洽的数据。源链证明只能证明 receipt、Fabric view 或 Warp message 存在，最终还必须证明从该不可篡改事实中提取的消息恰好等于待签名 h-xmsg。

所有 adapter 应只返回规范化后的源链事实；TEE 应在内部构建或重建 canonical h-xmsg，计算摘要，并拒绝外部摘要不一致的请求。`callDataHash` 只能证明 calldata 与所提交哈希一致，不能替代“它与源链事件一致”的检查。

### 4.5 Fabric 链码使用非确定性本地时间

Fabric 链码中多处使用 `new Date()` 或宿主机墙钟进行 deadline、注册和挑战状态判断。不同 endorsing peer 的本地时间可能不同，导致读写集或返回结果不一致，并破坏 Fabric 链码必须确定性执行的要求。

应统一使用交易上下文中的 Fabric transaction timestamp，并通过单一 helper 转换。所有 deadline、challenge、registration epoch 和 checkpoint 时间逻辑都应依赖该确定性时间源。

### 4.6 h-FSV 的独立背书域不足

当前 h-FSV 能验证 peer 签名、MSP 证书、交易有效标志和事件/负载绑定，确实采用了 Fabric View-like 思路，而不是让 TEE 查询区块后自行相信结果。但是本地 Fabric 网络主要由单一组织构成，多 peer 签名仍属于同一 MSP/管理域，不能等价为多个独立组织共同确认。

论文实验需要明确“多个 peer”和“多个独立组织”的区别。若安全假设是多数背书域诚实，应增加多组织 MSP、对应 endorsement policy，并让 h-FSV 阈值按独立 MSP 或信任域计数，而不是仅按签名数量计数。

## 5. 其他需要修正的问题

### 5.1 源链 escrow 的成功结算可能只更新标志

退款路径会发生真实 token 返还，但成功 response 后的 settle 路径如果只更新 `settled` 状态，锁定资产仍停留在源 escrow 合约中。资产桥需要明确成功时是销毁、转入流动性提供者、归集储备还是允许治理提取，并用余额断言验证最终去向。

### 5.2 补偿类型扩展性不足

状态机和 h-xmsg 可以表达多类动作，但通用补偿 handler 仍可能主要覆盖 token escrow。NFT、授权变更、跨链调用、铸造/销毁和不可逆外部动作需要各自的 prepare/commit/compensate 策略，不能统一退化为状态标志。

### 5.3 Fabric 测试资产初始化权限过宽

若 `InitAssetBalance` 等测试辅助入口可被普通客户端任意调用，会削弱“真实余额变化”的实验意义。应限制为初始化管理员，或只在部署 fixture 中运行，并在正式链码配置中移除测试铸币入口。

### 5.4 watcher 任务领取和所有权规则不充分

如果首个调用者即可成为 watcher 或领取 challenge，可能产生抢占、阻断、恶意延迟和奖励窃取。更稳妥的方式是开放提交有效证明，但不要让单个 watcher 获得排他权；或采用租约、超时接管、保证金和可验证工作结果。

### 5.5 automation API 和本地存储不适合生产部署

automation 服务的 API 鉴权可能是可选的，任务和扫描游标主要保存在本地 JSON/文件存储中。该结构适合单机实验，不适合多实例高可用：并发写入、进程崩溃、重复消费和磁盘损坏都可能破坏任务状态。

生产化时需要强制鉴权、最小权限密钥、持久数据库、事务或幂等更新、任务租约、dead-letter queue、指标和审计日志。

### 5.6 本地 EVM gas limit 过大可能掩盖不可部署路径

为批量实验提高 Hardhat block gas limit 有助于测试吞吐，但可能让本地成功的超大批次在 Sepolia 或主网配置下无法估算和提交。性能报告应同时记录单笔 gas、calldata 字节数、区块 gas 占比和真实网络限制，不能只以本地通过作为可部署证据。

### 5.7 部分测试脚本仍可能直接调用合约

项目历史上存在直接构造签名、直接调用目标合约或手动拼接 response 的测试路径。即使这些脚本用于单元测试，也必须明确标记为 component test；端到端实验只能通过 scanner、automation task state machine、proof worker、TEE 子网和 target submitter。

后续清理时应以“是否被当前 `package.json`、Compose、automation worker 或 CI 引用”为依据删除旧入口，避免仅通过改名或注释保留可误用路径。

### 5.8 代码体量和单文件职责过重

`tee-verifier/server.js` 和 `fabric-chaincode/xcall/index.js` 承担了过多协议解析、证明验证、状态机、注册和业务逻辑。单文件过大增加了安全审计难度，也容易让不同链 adapter 的规则交叉污染。

建议继续按以下边界拆分：

- canonical message 与 digest；
- source proof adapter；
- TEE consensus/raft；
- attestation 与 membership；
- response/challenge state machine；
- business handler；
- storage/repository；
- HTTP/API transport。

### 5.9 本地信任锚仍依赖人工或静态配置

本地 Ethereum header committee、Sepolia 初始 trusted block root、Avalanche P-Chain trust anchor 均需要某种带外引导。自动更新后可以限制增量证明长度，但无法消除初始信任问题。论文应明确 bootstrap anchor 的来源、更新规则、过期恢复和被替换时的安全后果。

## 6. 当前能力的真实性分级

| 能力 | 当前状态 | 可合理宣称的程度 | 不能宣称的内容 |
|---|---|---|---|
| TEE 节点签名 | 多节点独立 ECDSA 密钥和阈值验签 | 已实现独立软件节点身份 | 真实硬件密钥隔离、抗宿主机攻陷 |
| TEE 注册 | 有注册状态机、公钥和策略检查 | 已实现模拟 attestation 注册流程 | 已完成 SGX/TDX 真实远程证明 |
| Raft | 有选举、任期、日志复制和多数派提交 | 已实现研究原型级崩溃故障共识 | 生产级持久化、拜占庭容错、独立物理故障域 |
| Ethereum 验证 | receipt MPT proof、本地区块头和 Sepolia sync committee 路径 | 能验证收据属于受信 finalized header | 任意 RPC 返回值天然可信 |
| Fabric 验证 | h-FSV peer 签名、MSP、VALID 状态和事件绑定 | Fabric View-like 事实证明已实现 | 多组织独立背书安全性已经充分实验 |
| Avalanche 验证 | 本地 Warp/权重签名和 P-Chain validator set 锚 | 能验证本地配置下的权重证明 | 主网级动态 P-Chain 锚与验证者轮换已完成 |
| 真实业务动作 | token 转账、托管、退款等会改变真实余额 | 目标动作和部分补偿不是空壳 | 所有操作都满足跨链价值守恒 |
| challenge/response | watcher、challenge、response 验证、超时补偿均有路径 | 已实现协议状态机原型 | 在 response 审查和不可逆目标动作下严格原子 |
| automation | scanner、任务状态、worker 和 submitter 已接入主要实验 | 可用于单机端到端实验 | 高可用、抗并发故障和生产级 relayer 网络 |

## 7. 测试证据及其边界

当前测试能够证明一部分实现行为，但不能替代安全论证：

- 默认测试可验证 P-Chain trust anchor、Hardhat 合约基本行为和 automation store 等组件；
- 双向和两两链实验能够证明容器、adapter、TEE quorum、automation 和业务动作在给定配置下可连通；
- gas 实验能够测量指定路径的交易消耗，但必须说明是否包含源交易、目标执行、注册、checkpoint、challenge 和 response；
- 使用同一物理主机的五个 TEE 容器不能证明五个独立故障域；
- 同一 Fabric 组织中的多个 peer 不能证明多组织信任分散；
- 手工拼接证明或直接调用合约的脚本只能算组件测试，不能作为端到端协议证据；
- 单次成功不能证明分区、重启、重复事件、重组、恶意 relayer 和密钥泄露场景下仍然安全。

后续测试至少应覆盖：

1. 篡改 h-xmsg、摘要、calldata、目标链、目标合约和 response event 的拒绝测试；
2. TEE 节点宕机、leader 切换、网络分区、日志恢复和重复提交；
3. 源链重组、finality 延迟、sync committee 轮换和 trust anchor 恢复；
4. response 丢失、恶意延迟、late response、challenge 抢占和补偿重复执行；
5. 源端锁定/销毁与目标端释放/铸造的余额守恒断言；
6. 多组织 Fabric 和动态 Avalanche validator set；
7. automation 重启、游标恢复、任务幂等和并发 worker；
8. 不同批次规模下的 gas、时延、吞吐和失败率。

## 8. 整改优先级

### P0：论文安全结论前必须完成

1. ~~强绑定 ResponseProof 的目标链、目标网关、事件地址和原始 request。~~ 已完成。
2. 在所有证明入口由 TEE 重建 canonical h-xmsg 并重算摘要。
3. 明确源业务合约授权模型，并为资产桥补齐源端锁定/销毁和价值守恒。
4. 关闭或隔离任何绕过 automation、源链证明和 TEE quorum 的端到端旧路径。

### P1：真实 TEE 实验前完成

1. 抽象真实 SGX/TDX attestation provider，绑定 measurement、节点公钥、子网和 nonce。
2. 将节点密钥迁移为 enclave 内生成和密封，避免宿主机明文共享。
3. 将 TEE 注册、轮换、撤销和 membership epoch 从业务热路径分离。
4. 补齐 challenge response 的开放证明提交、裁决期和不可逆动作提交协议。
5. 修复 Fabric 非确定性时间，并增加多组织 h-FSV 实验。

### P2：性能和工程论文增强项

1. 为 Raft 增加节点级认证、WAL、快照、崩溃恢复和网络分区测试。
2. 将 automation store 替换为支持事务、幂等和多 worker 的持久存储。
3. 完善 settle 后资产去向、通用补偿 handler 和业务类型覆盖。
4. 在真实区块 gas 限制下重新测量批签名、批执行和 calldata 成本。
5. 拆分 TEE server 与 Fabric chaincode 的超大单文件，降低审计和修改成本。

## 9. 论文表述建议

论文可以重点陈述：

- 系统使用 canonical h-xmsg 统一异构链消息语义；
- 不同源链由独立 adapter 验证各自不可篡改事实；
- TEE 子网通过 Raft 对验证结果排序和提交，并由阈值 ECDSA 证书授权目标执行；
- automation 将事件发现、finality、证明构造、TEE 验证和目标提交解耦；
- challenge/response 与真实业务 handler 为需要反馈的操作提供失败处理框架；
- 批签名、CompactCall 和批量业务执行用于降低目标链摊销成本。

论文必须明确披露：

- 当前本地 TEE 是软件模拟，真实 SGX/TDX attestation 尚待实验部署；
- 同主机容器不构成独立硬件故障域；
- Raft 处理崩溃故障，不提供一般拜占庭容错；
- Fabric 本地网络的组织数量和 Avalanche 本地 validator set 的信任假设；
- 初始 trust anchor 的带外引导方式；
- 哪些业务满足严格原子提交，哪些仅提供超时补偿；
- gas 统计具体包含哪些链上阶段。

## 10. 最终判断

项目已经具备较完整的论文原型骨架，多个关键功能不是简单空壳：独立节点签名、Raft 核心流程、三类源链事实证明、真实 token 余额变化、watcher/relayer automation 和 challenge 补偿都存在可执行实现。

目前最需要避免的是把“路径可运行”直接等同于“安全语义完整”。ResponseProof 绑定这一 P0 问题已经修复并有双向实验与攻击测试支撑；真实 attestation、源端授权和价值守恒、response 可用性以及 Raft/automation 的生产化边界，仍然决定了系统能否支撑更强的安全与原子性结论。其余 P0/P1 完成后，项目才更适合作为安全方向论文的核心系统实现。
