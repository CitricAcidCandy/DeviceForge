# React 前端开发要求

## 范围与落点
- 当前项目为 `G:\Rust\DeviceForge\frontend`，采用用户于2026-10-14批准的 React 19.3.0、严格 TypeScript、Tailwind 4.3.3 与官方 shadcn/ui 清单。旧 renderer 仅作取证，不复制 Electron、preload 或本机全局状态。
- 用户已选电子设备背景并授权实现业务页面；原基础工厂、生成类型、公开宿主上下文及插件生命周期继续复用。图像和页面截图只由子代理审核；主代理集成结论，不能用构建代替业务、视觉或真机验收。
- 前端文档只放 `docs/`。注释、README 和文档使用中文与 UTF-8。开发前阅读架构与开发约束及插件开发文档。

## 界面样式：只用 Tailwind，禁止写 CSS（2026-10-23 用户硬性要求）

- 界面样式一律用 Tailwind 工具类表达。**禁止新增 CSS 文件，禁止在现有 CSS 文件里追加样式规则块**；用户明确要求「界面样式开发必须使用 tailwindcss」。
- 唯一例外是 `src/app/styles.css` 里的 `@theme` 与 `:root` 设计令牌（颜色、字号、圆角、字体变量）：那属于主题配置，不是样式实现。确实缺少语义色时先加 `--color-*` 令牌，再用 `bg-xxx` / `text-xxx` / `border-xxx`，不要写一段 `.foo { … }`。
- 组件变体（尺寸、平台色、状态色、选中态）用 `cva` 或类名映射表写在 TSX 里；跨页面复用的视觉元素抽成 `components/<组件>/index.tsx`，不要用一段公共 CSS 充当组件。
- 条件样式用 `cn()`（clsx + tailwind-merge）合并，靠后者覆盖前者；不要用 CSS 优先级和 `!important` 打架。
- `style={{}}` 仍只允许图表几何与 CSS 自定义属性（见 UI 政策门禁 T2）。
- 现存 CSS 文件只减不增：改动触达某个组件时，把它的规则翻译成 Tailwind，删掉对应 CSS 块并同步从 `scripts/check-ui-policy.ts` 的白名单里删掉该文件。白名单只允许缩减。

## 依赖与文件职责
- `src/app`：启动、路由、全局样式与装配；路由仅导入 pages/<功能页>/index.tsx，不堆积业务页面。应用装配可消费 features 的 index.ts 核心入口。
- `src/pages/<功能页>/index.tsx`：路由页面与页面编排。私有组件、局部 hooks、样式和类型就近放该页面目录；页面只读取自身私有文件，不读取其他页面实现。可消费 features 核心入口、公共 components 入口、services/api 和 utils。
- `src/features/<功能>`：只保留跨页面业务逻辑，根 index.ts 和中文 README；models 放用例、状态、订阅与编排，services 放适配与解码，types 放类型，utils 放纯规则。不含业务 UI、components 或 TSX；页面专属能力优先留 pages，不为目录完整制造空层。
- 功能内部方向：types/utils 不依 models/services；services 可依自身与 types/utils，不依 models；models 可依 services/types/utils。跨功能只引用对方 index.ts 核心公开入口，不读取内部路径且不得形成循环；核心入口不得引用 pages 或公共展示组件。
- `src/components/<PascalCase组件>/index.tsx`：仅跨页面公共组件，官方基础、组合和第三方封装使用相同结构。私有 children/types/styles/hooks 放本组件目录；外部读取组件入口或 components/index.ts，组件内部不导入汇总，不读取其他组件私有文件。
- 公共组件如需向非浏览器装配提供控制器和类型，可以额外保留同目录`index.ts`公共入口；该入口不加载或重导出TSX/CSS，展示入口仍为`index.tsx`。私有实现路径不因此开放。
- 公共组件只依公共组件和 `src/utils` 纯工具，不读取业务 API、features、pages、app、plugins 或 SDK。纯工具只依 utils，不承接业务状态和网络副作用。
- `src/services/api`：公共请求、生成类型、错误、取消和日志适配；页面调用公开请求，不直接 fetch。现有共享基础设施和 SDK 保留原边界，本轮不额外扩大业务重构。
- 页面另可消费 shared/jobs/index.ts 的公共作业能力，以及 plugin-sdk/index.ts、plugin-sdk/json.ts 的公开契约；不开放其他 shared 文件或 SDK 私有路径。
- 页面支撑过渡清单仅限 app/product 下 services.ts、hooks.ts、feedback.tsx、capabilities.tsx、device-target.ts，供既有页面使用；这些精确路径不表示可以任意读取 app 私有文件，后续按职责迁出。
- `src/plugin-sdk`：独立公开契约，不依 app/features/pages/shared/plugins。`src/plugins` 通过 SDK 接入宿主，装载失败回滚，卸载撤销贡献并等待资源清理。
- 禁止反向依赖、循环和跨工程源码路径。测试可读内部实现；生产边界不放宽。详见 [前端目录与组件约束](docs/guides/前端目录与组件约束.md)，普通异常直接修结构或门禁，不新增用户审批。

## 基础工作台与设备扩展
- 开发设备相关界面前阅读 `docs/implementation/设备能力与插件面板.md`。通用工作台消费宿主设备目录和能力，平台特有交互通过公开插件面板扩展。
- 设备使用公开宿主引用定位提供者；平台名称只用于展示和筛选，按能力版本、可用状态和权限决定入口，不增加按平台硬编码的连接/命令分支。
- 设备提供者和浏览器面板可独立存在；面板通过 SDK v2 可选 HostContext.devices 调用 refreshProviders/refreshDirectories/refreshProvider/invoke、select/snapshot/subscribe，不读取宿主私有状态、工具路径或服务令牌。设备 HTTP 类型索引生成契约，独立 camelCase SDK 由 app 显式映射，不用手写 DTO 或私有导入绕过公开契约。
- 提供者停止、断线、移除和插件面板失败须收敛入口与订阅；切换设备后晚到结果不得覆盖当前视图。刷新开始清本代旧观测与选择；本实例服务器管理后撤销目标缓存再重查，远端变化通过显式刷新获知。第一阶段公开设备调用与提供者重载已有本机 debug 浏览器证据，常驻热拔插、真机和完整设备 UI 继续独立验收。

## 类型与行为
- 资源故障的现行硬约束见 `docs/contracts/插件清理告警与重试约束.md`：历史 cleanup_failed/unresolved/recovering 或旧报告不得单独灰掉独立新操作，不要求用户先恢复、重启或等待全插件清理归零；同一真实活动请求可串行，冲突限定到对应资源。
- 默认启用、浏览器插件管理器、市场卡片/详情、页面按钮与用例层必须保持同一规则。错误和日志可见，旧失败可查询，新成功不抹旧错；未知提交只停自动重放，查询结果并由用户显式决定重试，不永久封死后续操作。
- 浏览器插件加载器、激活、挂载及清理回调都可能不返回；宿主等待须能因取消或固定期限收敛并让队列继续，不能只给清理阶段加超时。旧代回调晚到不得写入新实例。同页面可信 JavaScript 无法被宿主强制终止，其副作用边界如实说明，不为此新增沙箱、来源审批或多用户安全模型。
- 保持 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes，不得以 any、类型断言或关闭检查绕过接口边界。
- 前端维护的源码、开发脚本及测试使用 `.ts`，React 页面与展示组件使用 `.tsx`。两者及配置均纳入同一严格类型和架构检查，不保留并行维护的 `.js/.mjs` 实现。
- Node 工具及测试要求 Node 22.18 以上，直接执行 TypeScript；浏览器只能载入构建后的 JavaScript。独立插件验收源码为 `scripts/browser-plugin-harness.ts`，稳定浏览器产物为 `dist/assets/browser-plugin-harness.js`，依赖既有公开 `plugin-host.js`。
- HTTP 类型由 generate:api 生成，禁止手改 generated.ts 或手写重复 DTO；公开 SDK 独立版本化，由适配器映射。
- 异步调用显式传 AbortSignal，处理失败、取消、销毁和晚到结果；插件卸载释放事件、订阅和 DOM。
- 日志 ID 由 services/api 按公开响应契约提取并传递，失败界面应支持复制排查；任务 ID 不代替日志 ID。日志响应升级需同步生成类型、适配器和公开 SDK，不把协议包装或服务器日志路径混入组件。
- 日志消费遵守 `docs/contracts/日志ID与接口消费.md`：默认 v2，v1 从响应头兼容，产物原字节与 OpenAPI 不按业务 JSON 拆包；真实客户端保留日志 ID 与结构化错误，复制交互随具体界面验收。
- 同页面插件按可信扩展运行，允许从已安装浏览器包动态导入模块；预注册加载器仅是开发路径。在线包、组件/模块/命令/服务/逻辑扩展遵守 `docs/implementation/在线插件与开放扩展.md`，没有实施或验收的能力不得写成已完成。
- 默认免鉴权，令牌提供器可选；不增加多用户权限、来源审批或强制隔离。宿主通过公开扩展点管理资源所有权与代际，不以直接引用宿主私有实现作为公开接口。
- 服务器插件管理遵守 `docs/implementation/服务器插件生命周期消费.md`：只使用生成类型与公开 ID，区分服务器插件、设备提供者和浏览器面板；取消等待后重新查询状态，不假定管理变更回滚。
- 采用语义 HTML、键盘操作和可访问标签；新增业务交互补浏览器验收，构建通过不代表视觉或真机验收通过。

## 必须执行的门禁
在前端目录执行并确认退出码：
1. `npm run generate:api`
2. `npm run check`（包含 TS/TSX 架构与 TypeScript 检查，覆盖维护脚本与所有测试）
3. `npm test`（包含架构拒绝用例、插件契约及外壳测试）
4. `npm run build`

新增可见交互补行为测试；静态架构检查不能代替运行时插件信任或资源清理。

生成器由主代理串行运行，前端角色不与后端 Cargo 验证并行执行 `generate:api`。纯前端 TypeScript 迁移不手改生成类型；记录实际检查结果和生成器交接状态。

涉及在线包或开放扩展时，在根目录执行 `node scripts/browser-plugin-smoke.mjs`；当前 release 宿主重建后另执行 `--release`。该独立浏览器验收覆盖真实上传两类包、动态模块、界面替换、逻辑钩子、服务器对接和停用恢复；不替代具体产品界面视觉验收。

2026-10-09 19:45 当前源码门禁由主代理完成：generate:api/check 退出 0（51 源码，Svelte 0 错误/0 警告），test 退出 0（109/109），154 模块 production build 通过。当前 artifacts/browser-plugin-smoke-{debug,release}.json 均对应 48554 字节的生产宿主，覆盖公开设备目录、提供者代次变化、旧引用拒绝及三项永不返回回调的取消等待；实际 Edge 版本由 CDP 采集。release/runtime 重建、同一测试 tgz 的 npx 两阶段退出 0，最终持久包 24 文件另作字节核对，临时 npx 包当次摘要未保留。取消等待不证明可信回调副作用停止或资源清理完成。main.ts 未装配产品 runtime，远端推送、常驻会话、真机、产品 UI 和生产容量不在此证据范围内；各批版本及完整交付证据以根 todo.md 为准。

## 协作与交付
- 不自动提交、恢复或删除用户无关修改，不向旧工程写新实现；大型写入分批进行。
- 修改后更新新项目根目录 `../todo.md`，记录实际检查与未验证范围，终端摘要使用中文。
- 开发通信、基础用例与插件宿主前阅读 `docs/guides/前端运行架构.md`；并行开发遵守根目录四角色分工，生成类型由主代理统一同步。
- 区分类型契约、实际通信与插件生命周期、具体页面和视觉验收，不能以占位页面或契约存在证明完整功能完成。
