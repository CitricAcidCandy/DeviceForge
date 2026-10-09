# 前端脚本

作用：从后端导出的 OpenAPI 生成接口类型。快速开始：npm run generate:api。参数来自脚本相对路径，不读取服务令牌；生成结果为 src/shared/api/generated.ts。
# 架构门禁

`check-architecture.mjs` 负责源码枚举、tsconfig 解析和检查汇总；`source-dependencies.mjs` 使用 TypeScript/Svelte 解析器提取导入及类型/直接网络调用；`architecture-policy.mjs` 定义层级规则与循环检测。三者只做开发检查，不参与产品运行。规则拒绝用例位于 tests/architecture.test.mjs，npm run check 自动执行检查。

