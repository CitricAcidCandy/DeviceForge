# Android Unicode 输入消费

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。
- `utils/`：纯规则、转换、结果验证和计算，不依赖models、services或components。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

## 验证边界

`android-input-consumption.test.ts` 使用受控 `DeviceAccess` 验证 UTF-8 限额、字段原样、能力准入、结果解码、日志、取消和晚到响应。该测试不代表真实 Android 设备、ADB Keyboard 安装、目标应用文字插入或产品界面验收。
