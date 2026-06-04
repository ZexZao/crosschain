# 测试数据说明

本目录保留当前主线测试直接使用的数据。

## 文件说明

- `fabric-real-cases.json`
  - 8 组真实 Fabric 模式测试用例
  - 由 `scripts/run-hxmsg-forward-tests.js` 驱动，用于验证 Fabric -> EVM 主线消息、h-FSV 验证、TEE quorum 和目标链真实业务执行

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

运行完整 Fabric -> EVM 主线测试：

```bash
npm run hxmsg:test:forward
```
