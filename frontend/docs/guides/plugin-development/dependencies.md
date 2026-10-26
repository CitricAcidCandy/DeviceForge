# 浏览器插件依赖与共享复用

浏览器插件、独立服务器组件和完整功能共用公开依赖声明。独立浏览器包在包根包含 `dependencies.json`，完整功能在 `release.json(format_version:2,host_api_version:2)` 的 `dependencies` 中声明。工具描述格式独立为 `format_version:1`；无工具时写 `{"format_version":1,"dependencies":[]}`。

声明字段包括稳定 `id`、`name`、`version_requirement`、`required`、`entries`、`requires`、`discovery`、`probe`、`sources`、`bindings`。字段和示例以同主题后端指南及公开 `apk_plugin_sdk::dependencies` 为准；不要复制私有服务器类型或只在市场卡片添加工具信息。

## 用户操作

用户一次安装插件，宿主先检测环境和整个 `.deviceforge` 共享工具仓库；兼容工具直接复用，零重复下载，只自动下载缺失的必需项。可选依赖由用户补装。启动、依赖查询和重新检测不下载。依赖面板用于失效后重试、下载失败重试、可选项补装和高级手动覆盖，不要求普通用户先填路径。

所有检测、探测、下载与绑定发生在后端电脑。局域网网页不会扫描访问者的 PATH 或用户目录；浏览器插件不直接执行本机工具，应通过公开 HostContext 调用所关联服务器能力。不要把浏览器文件选择路径当服务器程序路径。

## 状态与接口

`GET /api/v2/plugin-dependencies/{target_kind}/{id}` 返回 `target`、`revision`、`ready`、`dependencies`。每项包含要求版本、实际版本、来源、是否可安装和状态。状态为 `ready/missing/incompatible/failed`，来源为 `environment/shared/local`。无依赖时 `ready:true`，面板显示无需安装依赖。

`target_kind` 只取 `release/server/browser`，同名类别不会冲突。组件被完整发布拥有时返回 canonical 发布身份，应以返回身份和修订提交操作，不能认定为响应错误或覆盖另一套绑定。

`POST .../scan`、`POST .../install` body 为 `{expected_revision,dependency_ids:[]}`，返回 202 任务。读取进度和终态，刷新真实状态；修订冲突后重新查询，不重放旧写操作。等待取消不表示后台任务已取消，须显式取消任务；迟到结果不能覆盖新目标或已关闭面板。所有成功响应使用 `{log_id,data}`，通过生成 API 类型消费。

插件已安装与依赖已就绪分开显示。完整发布缺必需项为 `dependencies_required`，不是要求用户手填配置；缺业务配置仍为 `configuration_required`。没有必需依赖时不得因可选项缺失阻止启用。独立浏览器插件启用同样检查依赖状态，不只禁用界面按钮。

## 发布与持久化

发布前检查市场 capabilities 支持清单格式 2；组件与市场工具资源先上传，在线清单后上传，catalog 最后提交。声明的官方兜底来源固定独立版本、摘要、大小、归档格式和入口，不要求把官方工具打进主 npm 包。完整性失败直接呈现，不通过换源掩盖。

工具保存在后端 `DEVICEFORGE_USER_DIR`（默认 `~/.deviceforge`），不在 npx 临时缓存。第三方只凭公开声明即可复用其他插件安装的兼容工具；卸载安装者不会删除其他引用者仍使用的内容。用户自备工具只登记引用，不取得删除权。v1 发布及旧安装记录保留兼容，不把历史验收当成新 v2 页面或真实工具验收。
