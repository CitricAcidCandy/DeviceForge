# 业务功能边界

功能模块根目录保留薄 `index.ts` 核心入口和中文 README。app 的值和类型导入使用功能核心入口或 `components/index.ts` 展示入口；核心不依赖或重导出展示，避免无界面消费者加载 TSX。测试可以读取内部实现，不同功能不互相导入，跨功能协作由 app 装配公开端口。

按真实职责建立目录，不搭建空骨架：`models` 放用例、状态、订阅与编排；`services` 放适配器、网关与字节解码；`types` 放类型；`utils` 放纯规则、验证与转换；`components/<PascalCase组件>/index.tsx` 放专属展示，私有文件留同组件目录。

依赖方向为 types/utils 不引用 models/services/components；services 不引用 models/components；models 可引用 services/types/utils；专属 components 可引用 models/types/utils 和公共组件，不能直接读取 services。功能非展示目录不依赖公共组件。

公共组件统一放 `src/components/<PascalCase组件>/index.tsx`，官方、组合及第三方封装使用相同结构。`components/index.ts` 供外部汇总，组件内部不导入汇总；纯工具放 `src/utils`。不再强制 ui/common/integrations 或 DDD 分层。

业务与验证状态仍以模块 README、根 todo 和交接文档为准；目录重排不计为新的业务、视觉或真机验收。细则见 [前端目录与组件约束](../../docs/前端目录与组件约束.md)。
