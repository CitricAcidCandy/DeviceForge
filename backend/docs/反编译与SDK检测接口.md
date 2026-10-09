# APK 反编译和 SDK 检测接口

## 调用链路
向 `POST /api/v1/jobs` 提交 android.package.decode，input 为 APK 产物 ID；查询任务成功后获得 result.artifact.id，将其传给 android.package.scan_sdks。两项操作也通过 MCP 自动发现，共用输入校验和任务层。

```json
{"operation":"android.package.scan_sdks","input":{"artifact_id":"反编译 ZIP 的 UUID","rules":[{"name":"示例 SDK","package_path":"com.example.sdk","class_name":"Entry$Inner"}]}}
```

| 操作 | 输入 | 成功结果 |
| --- | --- | --- |
| android.package.decode | artifact_id（APK） | source_artifact_id、artifact、files、unpacked_size |
| android.package.scan_sdks | artifact_id（反编译 ZIP）、rules | artifact_id、findings |

rules 每条包含唯一 name、点分包路径 package_path 和可选 class_name，最多 100 条。findings 保留原规则，并返回 package_found、class_found、evidence。未指定类名时 class_found 为 null；检测点缺失时返回 false，同时保留包目录是否存在的结果。

ZIP 产物可通过 `GET /api/v1/artifacts/{id}/content` 下载，条目列表可用现有 artifact.archive.entries。检测可处理上传的兼容反编译 ZIP，不接受服务器文件夹路径。目录必须包含非空 apktool.yml / AndroidManifest.xml。

## 语义与资源边界
反编译包括 Apktool 资源解码与 smali 反汇编，不提供 Java 源码恢复。SDK 检测沿用旧模块的包路径与可选类检测点语义，匹配 smali 和 smali_classesN 下完整路径边界。每条最多返回十条证据，类通过时包含检测点路径。结果只表示文件路径存在；未检查 smali 内容、CRC、SDK 版本或运行状态。

部署者配置 APK_APKTOOL_JAR 和 APK_JAVA，工具采用固定参数，不接受用户命令。每个任务独占输出与 framework 缓存；输入最大 64 MiB，输出最多 10000 个文件 / 目录、128 层、64 MiB 文件内容，最终 ZIP 也最多 64 MiB。工具输出与错误分别最大 1 MiB。准备、工具、打包和发布各阶段最多 120 秒。

运行时定期观察输出体积，超限会停止工具；这不是磁盘硬配额，快速写入可能短暂超过限制，framework 缓存也不在输出体积统计中。工具退出后再次完整检查再打包，不截断超限产物。

## 验收
Rust 测试覆盖真实模拟子进程参数、输出 / framework 独立性、失败、取消、体积、路径规则、多 DEX 和证据上限；runtime-smoke.mjs 验证 HTTP 反编译任务、产物下载与摘要，以及 MCP SDK 检测。模型由 Rust 类型生成到 OpenAPI，前端仅更新 API 类型。

本地 Apktool 2.9.0 帮助输出已确认参数；尚无真实包验收。后续需要 SDK 规则管理、DEX 直接分析、图标资源、AAB 转换与完整设备分包安装。
