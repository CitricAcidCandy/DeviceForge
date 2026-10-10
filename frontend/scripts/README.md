# 前端脚本

开发脚本使用 TypeScript，纳入前端严格检查。Node 22.18 以上直接执行 `.ts`，无需另行维护 JavaScript 副本。

`generate-api.ts` 从后端导出的 OpenAPI 生成接口类型。快速开始：npm run generate:api。参数来自脚本相对路径，不读取服务令牌；生成结果为 src/shared/api/generated.ts。移除上游说明后同步清理行尾空白，不手改生成类型。生成器由主代理与 Cargo 验证串行协调。
# 架构门禁

`check-architecture.ts` 负责源码枚举、tsconfig 解析和检查汇总；`source-dependencies.ts` 使用 TypeScript/Svelte 解析器提取导入及类型/直接网络调用；`architecture-policy.ts` 定义层级规则与循环检测。三者只做开发检查，不参与产品运行。规则拒绝用例位于 tests/architecture.test.ts，npm run check 自动执行检查。生产源码中的 `.js/.mjs` 维护文件被拒绝。

`browser-plugin-harness.ts` 是根目录 browser-plugin-smoke 的独立验收页面模块。它使用真实前端运行实例上传服务器/浏览器包，启停贡献、调用服务器、验证任务钩子及卸载恢复。仅由临时测试服务载入，不接入产品路由，不作为产品界面交付。

先执行 `npm run build`，Vite 输出稳定单文件 `dist/assets/browser-plugin-harness.js`。根驱动通过 `/__harness__` 服务此构建产物；外部导入 `/__production_host__` 仍指向公开生产 `plugin-host.js`。浏览器不直接读取 TypeScript 源文件，类型检查和构建不代替根驱动的真实浏览器验收。

