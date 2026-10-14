# 业务功能边界

每个功能模块通过根目录的薄 `index.ts` 公开能力，并保留中文 README。app 的值和类型导入都使用公开 index；测试可以读取内部实现。不同功能不直接互相引用，跨功能协作由 app 装配回调或公开端口。

源码按实际职责分层：`domain` 放纯规则与模型，`application` 放用例与状态，`infrastructure` 放适配器和解码，`ui` 放功能专用展示组件。模块只建立有实现的层，不为形式建立四个空目录；根目录不再堆放其他源码。

依赖方向为 domain 不引用 application/infrastructure/ui，infrastructure 不引用 application/ui，application 不引用 ui。只有 ui 层可使用公共 components；公共组件不反向读取功能 API、状态或 SDK。

共享展示放 `src/components`，官方基础组件放 ui，通用展示放 common，实际需要的第三方通用封装放 integrations。组件纯工具放 components/lib；第三方封装不承接任务派发、设备状态或业务查询。

既有业务实现与验证状态以所属模块 README、根 todo 和交接文档为准；目录迁移不新增业务完成或真机验收资格。细则见 [前端目录与组件约束](../../docs/前端目录与组件约束.md)。
