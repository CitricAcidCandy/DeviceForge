# 产物复制插件示例

根目录 `npm run pack:plugins -- artifact_copy` 生成当前平台 release 便携 tgz，npx 安装后重启加载。完整分发约束见 ../../docs/原生插件分发.md；手工清单部署方式继续适用于源码开发。

## 作用与适用场景
演示公开协议版本 2 的产物输入、生成文件和宿主发布；实现只依赖 plugin-sdk，不引用宿主内部类型。适用于其他语言插件开发者参考 JSON 结构和执行顺序。

## 快速开始
执行 `cargo build -p deviceforge-artifact-copy-plugin`。将 manifest.example.json 放到 APK_PLUGIN_DIR 下独立目录的 manifest.json，填写插件绝对路径并保留 artifacts 能力声明，重启服务。

通过 HTTP 任务或 MCP `plugin.artifact_copy.copy` 传入 artifact_id，宿主把输入复制到临时文件，插件把该文件复制到 output_directory，返回 outputs 描述。宿主重新检查并发布新的产物。

## API 与参数
输入：artifact_id（UUID）。清单 artifacts.input_fields 为 [artifact_id]，outputs 为 true。操作复制一个产物，支持宿主已有的 APK / APKS / AAB / HAP / ZIP / PNG / JSON / MessagePack 类型。

任务成功结果为 result 与 artifacts；result 包含 source_artifact_id、size，artifacts 为新产物元数据数组。下载使用既有产物 content 接口，新 ID 与来源不同但内容摘要相同。

## 验证
`cargo test -p deviceforge-artifact-copy-plugin` 使用真实独立插件进程检查 PNG 复制、下载字节、SHA-256、输出授权和输入篡改。插件还检查不应继承 APK_API_TOKEN；日志不得输出令牌或文件内容。

这是可信本机插件示例，不提供网络或文件系统沙箱。跨语言开发者必须使用标准错误输出日志，标准输出只返回一份关联 request_id 的响应 JSON。
