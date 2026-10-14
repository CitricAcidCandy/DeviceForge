# MCP 目录消费

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `services/`：网关、归档IO、字节解码与浏览器适配，不反向引用models。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

