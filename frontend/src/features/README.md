# 跨页面业务逻辑

features 只承载被多个页面或无界面调用方复用的业务能力，不保存业务 UI。模块以薄 `index.ts` 暴露核心并保留中文 README；值和类型导入同样使用公开核心。测试可读内部文件，生产消费者不能绕过入口。

目录按真实职责建立：models 放状态、用例、订阅和编排；services 放请求适配、网关和字节解码；types 放类型；utils 放纯规则、验证和转换。types/utils 不依 models/services，services 不依 models，models 可依 services/types/utils；跨 feature 仅使用对方 index.ts 核心公开入口，不读取内部路径，类型导入也不得形成循环。

业务页面与页面私有组件放 `src/pages/<功能页>/index.tsx` 和该页 components。features 不含 components 或 TSX，不导出页面或展示组件；公共跨页面展示放 `src/components/<组件名>/index.tsx`，公共请求放 `src/services/api`。只有出现实际跨页面复用才提升逻辑，不为规范制造转发层或空目录。

本约束覆盖上一轮 feature 展示入口规则。目录迁移不计为新增业务或真机验收，最新证据见模块 README、根 todo 和交接文档。详见 [前端目录与组件约束](../../docs/guides/前端目录与组件约束.md)。
