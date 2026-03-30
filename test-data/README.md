# 测试数据说明

本目录存放用于论文原型实验的测试数据，当前覆盖四类用途：

- 功能正确性数据：用于验证正常跨链调用能否被 TEE 验证并在目标链成功执行
- 安全实验数据：用于对应篡改、重放、伪造证明、TEE 回滚等攻击场景
- 性能实验数据：用于观察不同 `payload` 大小下的延迟和 gas 变化
- 真实 Fabric 模式数据：用于驱动真实 Fabric 链码事件、Listener、proof-builder、TEE 和目标链的端到端联调

## 文件说明

- `functional-cases.json`
  - 12 组正常业务消息
  - 适合做正确性实验、演示截图和论文中的业务样例
- `security-cases.json`
  - 8 组安全实验样例
  - 给出参考功能用例、攻击类型和预期失败原因
- `performance-cases.json`
  - 12 组不同负载规模的性能用例
  - 覆盖约 `256B` 到 `32KB` 的 `payload`
- `fabric-real-cases.json`
  - 8 组真实 Fabric 模式测试用例
  - 适合验证真实链码事件发出后，是否能被监听器转换为 `XMsg` 并最终在目标链落地

## 真实 Fabric 模式用例

`fabric-real-cases.json` 当前包含：

- `FABRIC-001`：资产锁定
- `FABRIC-002`：铸造确认
- `FABRIC-003`：应收账款确认
- `FABRIC-004`：冷链物流同步
- `FABRIC-005`：医疗授权
- `FABRIC-006`：预言机更新
- `FABRIC-007`：多方审批提交
- `FABRIC-008`：补贴确认

每条 Fabric 用例除了 `payload` 外，还额外包含：

- `expectedMode`
  - 标记该 case 面向真实 Fabric 模式
- `expectedTargetFields`
  - 说明消息最终落到 `TargetContract` 后，预期解析出的关键字段

## 使用方式

读取某条测试用例的 `payload`：

```bash
node scripts/load-test-case.js test-data/fabric-real-cases.json FABRIC-001
```

查看完整 case 信息：

```bash
node scripts/load-test-case.js test-data/fabric-real-cases.json FABRIC-006 --full
```

直接把某条真实 Fabric 用例发送到 Fabric 链码：

```bash
node scripts/run-fabric-test-case.js test-data/fabric-real-cases.json FABRIC-001
```

这一步会调用：

- `docker compose -f docker-compose.fabric.yml run --rm fabric-tools ...`

并把 case 的 `payload` 作为链码 `EmitXCall` 的输入。
