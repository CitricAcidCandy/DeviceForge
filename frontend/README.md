# DeviceForge 浏览器工程

## 作用与范围
Svelte 5、TypeScript 和 Vite 的独立浏览器工程。当前只创建应用外壳、前端模块边界、接口生成和插件贡献契约，不实施完整设备管理界面。

## 快速开始
使用 Node.js 22.18 或更高版本，执行 `npm ci`、`npm run dev`。开发代理将 `/api` 与 `/mcp` 转发至本机 7031。生产部署将静态产物和服务器配置为同源，避免在前端代码写死服务器地址。

统一 npx 运行包已携带构建后的静态资源，对外默认前端/API 地址为 `http://服务器地址:7030`；可通过 CLI `--ip`、`--port` 修改。前端分发边界与验证见 [静态分发与访问](docs/静态分发与访问.md)。

验证：`npm run generate:api`、`npm run check`、`npm test`、`npm run build`。依赖锁文件提交到源码管理，CI 使用 npm ci。TypeScript 使用 5.9 兼容当前接口生成器和 Svelte 检查器，不通过忽略 peer 依赖强行升级。

## API 与参数
`src/plugin-sdk/index.ts` 定义 `WebPlugin/PanelContribution/HostContext`；`src/plugins/contracts.ts` 校验贡献冲突；`src/shared/api/generated.ts` 从后端公开模式生成。当前尚未提供运行时 HTTP 客户端和动态插件加载器。

## 文档
`docs/架构与开发约束.md` 描述文件骨架、依赖和门禁；`docs/插件开发.md` 描述浏览器扩展契约。后端文档存放在独立的 backend/docs，当前目录不保存后端接口说明。

`docs/设备能力与插件面板.md` 约束按设备能力展示功能、平台面板扩展及日志 ID 展示；当前仍是待实施的交互目标，未增加设备页面或运行时插件加载器。

`docs/日志ID与接口消费.md` 约束 v2 拆包、v1 兼容、产物原字节和关联 ID。生成类型已覆盖两版接口；HTTP 客户端和日志 ID 复制交互尚未实施。

本端独立开发规则见 [AGENTS.md](AGENTS.md)，包含完整职责、严格类型、异步资源与检查要求。

[服务器插件生命周期消费](docs/服务器插件生命周期消费.md) 约束运行目录、代际、保护依赖及取消后查询。生成类型已覆盖管理接口，当前仍未提供管理 UI 或浏览器面板动态加载。
