# 公共组件

本目录按 Ant Design Pro 的具名组件目录组织：每个跨功能复用组件使用 PascalCase 目录和 index.tsx 入口。官方基础控件、通用组合、第三方库包装均位于 components 根目录，例如 Button、FormField、CodeEditor；不按 ui、common 或供应商再分类。当前仅保留实际组件，不预建 CodeEditor 等未实现目录。

## 公开入口与私有实现

components/index.ts 显式汇总公开组件及类型。业务消费者可使用汇总入口或具体具名组件入口；组件内部必须按具体入口导入兄弟组件，不回引根汇总文件，避免循环依赖。FormField 目录保留原 Field 导出名称。目录可按实际复杂度增加 types.ts、hooks.ts、style.module.css 和 components/ 私有子组件；私有文件不加入根汇总入口，不创建空文件。

跨功能复用组件放本目录；只服务一个功能的组件留在 features/<功能>/components。公共组件只接收普通展示数据与回调，不导入 app、features、plugins、plugin-sdk、shared/api 或 shared/jobs，不直接执行网络请求。第三方包装负责统一 Props、事件和资源释放；任务派发、业务转换和服务适配留所属功能。

## 初始化与样式

16 个基础控件保留官方 shadcn/ui、Radix、React 的交互和无障碍实现。初始化或增补官方组件后，将生成文件移到对应 PascalCase 目录，并核对导出及依赖；不重新建立 ui/common/lib 分类层。类名合并统一从 src/utils/classnames.ts 导入，组件内部使用 ../../utils/classnames.ts。官方控件组合直接引用兄弟组件，例如 Dialog 引用 ../Button/index.tsx。全局主题由 app 样式和公开主题贡献装配。

迁移只调整目录与导入，不改变现有行为；组件安装配置、外部消费者和架构门禁由集成代理同步检查。
