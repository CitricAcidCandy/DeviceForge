# TypeScript 维护源码迁移裁定

日期：2026-10-10。模式：先确定架构再实现；验证顺序采用 Hybrid，先证明严格类型检查覆盖，再保留既有行为与构建输出。用户已明确要求前端维护源码使用 TypeScript；本批保留 Svelte 外壳，不实施 React、产品界面或后端契约变更。

## 目标与边界

将前端五个开发脚本和五个 JavaScript 测试迁为 `.ts`，纳入 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。不使用 `any`、忽略指令、关闭检查或宽泛断言绕过类型边界。Node 最低版本保持 22.18，Node 开发工具与测试直接执行 TypeScript；浏览器只能消费真实构建后的 JavaScript。

原 `svelte.config.js` 仅导出空对象，没有配置行为；移除后使用工具默认行为，实际构建配置集中在已纳入严格检查的 `vite.config.ts`。第三方发布包的 JavaScript 入口和历史报告路径不属于此次前端维护源码迁移。

选择源码迁为 TypeScript、浏览器 harness 单独构建为稳定 JavaScript 产物。只改后缀会把 TypeScript 交给浏览器并遗漏类型检查，因此不采用。根服务驱动由主代理改读构建产物；本角色不修改根脚本、根 todo、生成类型或旧工程。

| 单元 | 输入／输出与责任 | 明确不负责 | 副作用 |
| --- | --- | --- | --- |
| scripts/generate-api.ts | 调用既有导出器和类型生成器 | 手改生成类型；本轮不执行 Cargo | 开发期子进程与生成文件 |
| scripts/check-architecture.ts、source-dependencies.ts、architecture-policy.ts | 解析源码、依赖规则和检查汇总，保留现有职责 | 产品运行与业务类型 | 开发期文件读取 |
| scripts/browser-plugin-harness.ts | 消费公开宿主，执行原浏览器行为断言 | 私有宿主导入、产品 UI | 验收 DOM、HTTP 与插件生命周期 |
| tests/*.test.ts 与必要测试夹具 | 保留原断言，显式描述输入、异步值和 DOM | 把模拟 DOM 当作真实浏览器 | 测试内临时资源 |
| tsconfig、package、Vite | 严格检查所有前端维护 TS，生成独立浏览器 harness | 改动服务 API 或 SDK 版本 | 安装依赖、构建 dist |
| AGENTS、README 与所属 docs | 更新源码与运行产物命令，记录实际证据 | 转计旧报告为新版本通过 | 无产品副作用 |

依赖继续为 app → features/plugins，features → shared/SDK，plugins → SDK；开发检查不进入产品运行。测试 DOM 夹具可以共享，避免复制三套缺乏类型的节点模型；原生产模块无需拆分。

## 验证与交接

本角色不运行 `generate:api`，由主代理协调 Cargo。最小门禁为 `npm run check`、`npm test`、`npm run build` 和 `git diff --check`；检查须包含 scripts 与所有 TS 测试，构建须确认独立 harness 输出及外部公开宿主导入。真实根浏览器驱动在主代理改读新产物后另行验收；编译和单元测试不代替浏览器、真机或分发证据。

实施完成后在本文追加实际门禁、稳定产物路径与未验证边界。历史冻结 `.mjs` 报告仍对应原输入，不能因迁移完成自动转记为本批通过。

## 本批完成记录

2026-10-10 12:43（UTC+08:00），前端源码已冻结供主代理接线。五个开发脚本和五个原 JavaScript 测试均已迁为 TypeScript，空 `svelte.config.js` 已移除；前端维护树排除 `node_modules/dist` 后没有 `.js/.mjs/.cjs` 文件。严格配置覆盖五个脚本、23 个测试与夹具文件及 Vite 配置。

三套无类型节点模型已统一改用 JSDOM：正常宿主、插件、设备端口及延迟值均采用实际公开类型；HTTP/SSR/外部模块数据先进入 `unknown` 并校验后消费。非法第三方值经模块加载边界进行运行时拒绝测试；不降低正常 helper 的类型要求，不删除既有取消、回滚或资源清理断言。JSDOM 及其类型定义仅为开发依赖。

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 退出 0；架构 58 个源码文件；Svelte 0 错误/0 警告；严格 TypeScript 通过 |
| `npm test` | 退出 0；152/152 通过；无失败、跳过或取消 |
| `npm run build` | 退出 0；161 个模块；稳定验收入口与公开宿主成功输出 |
| 构建模块依赖核对 | 验收入口静态导入仅 `/__production_host__`；JavaScript 输出仅 app、plugin-host、browser-plugin-harness 三个入口，无其他 JS chunk |
| `git diff --check -- frontend` | 通过；换行提示不属于差异错误 |
| `generate:api` | 主代理在 Cargo 间隙实跑退出 0；生成类型前后字节不变；本角色未运行或手改生成类型 |

浏览器产物为 `frontend/dist/assets/browser-plugin-harness.js`，9037 字节，SHA-256 为 `91984275D5FAB73F73F36DE19B657FDB133FFB03B1AC31782ADC6095C9C58779`；同次公开宿主 `frontend/dist/assets/plugin-host.js` 的 SHA-256 为 `39B4D353B2BF7B0C984F8EB2A5FBE2FDD7212592E6BD327699316CFA56D05BCE`。根驱动须通过 `/__harness__` 服务前者、通过 `/__production_host__` 服务后者，不能再读取维护源码路径。

主代理生成器回流确认：`generated.ts` 前后 SHA-256 均为 `9227ED546F0CE9BE57E4B257F284457BA3904E2F2F77FBD2EBE0C72E52088421`，因此上列最终检查、测试和构建结果继续对应同一内容。

本记录证明严格类型、单元行为、构建与模块接缝。主代理已接线根驱动，debug/release 的本批真实浏览器报告及生成器最终结果另见根记录；本角色没有据此宣称真实浏览器、React 迁移、产品界面、真机或性能验收完成。

主代理随后执行新构建接线的真实浏览器 debug 验收，脚本实际退出 0、报告 passed=true，归档到 `artifacts/frontend-typescript-browser-debug-20261010.json`。报告的 9037 字节验收模块与 53533 字节公开宿主摘要均匹配上述冻结构建。本批 release 接线尚未执行；Svelte 外壳保留，未实施 React 或产品界面。
