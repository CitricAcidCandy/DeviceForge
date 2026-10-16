# 在线部署包基础用例

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。

## 市场安装与更新

市场安装调用 `upload(kind, content, mediaType, signal, { id, version })`，可选期望身份由后端在发布前对真实包清单校验；普通本地上传继续兼容四参数调用。

`update(kind, id, content, mediaType, signal, expectedVersion?)` 先等待当前实例插件清理，再发送独立 PUT 更新，不发送部署 DELETE。后端先验证完整新包及真实身份，在同一部署锁内备份旧目录并发布，失败恢复旧目录。更新不自动启用；旧部署可能已停止，调用者应显示实际状态并允许重新启用。取消仅结束前端等待，随后用独立信号重查实际目录，禁止自动重放更新。

市场元数据通过 `details.plugin_kind` 显式指定 `server` 或 `browser`，不能依据主题或 UI 分类猜测运行种类。配置编辑也要求条目显式声明 `details.configuration` 的 `scope`、`owner_id`、`section`；设置服务负责 CAS 保存，插件仍须实际读取该位置，并按 `restart_policy` 处理重新应用。

