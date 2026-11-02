# 自动化业务用例

## 2026-10-29 独立模型收敛边界

`types/index.ts` 的领域类型与 `types/desktop.ts` 已转发 `@deviceforge/automation/model`，设备步骤、桌面及轨迹契约不再重复维护。目录快照仍精确适配生成 HTTP DTO，保留未知 `input_schema` 和原蛇形 `execution`，不将其冒充公开 SDK 元数据。旧页面和 HTTP 工厂保留原入口，不读取独立插件私有路径。

运行时模型、规则和结果解码暂未直接切换：独立模型与宿主的错误构造器身份不同，直接替换还会影响目录错误码、日志 ID 及任务等待原因。兼容性单元固定原有契约，等待统一公开错误桥后再继续收敛，不把本批类型去重计作完整模型迁移或发行验收。

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。
- `utils/`：纯规则、转换、结果验证和计算，不依赖models、services或components。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

