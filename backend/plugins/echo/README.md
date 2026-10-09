# 独立进程回显插件

在根目录执行 `npm run pack:plugins -- echo` 可生成当前平台 release 便携 tgz，使用 npx 的 plugin install 安装后重启加载；见 ../../docs/原生插件分发.md。无需手工填写机器路径。

作用：展示完全通过公开 SDK 接入的服务器插件，宿主不引用插件内部实现。适用于其他语言开发者对照实现标准输入 / 输出协议。

快速开始：在后端目录执行 `cargo build -p deviceforge-echo-plugin`。把 `manifest.example.json` 复制到部署目录的 `echo/manifest.json`，将 `executable` 替换为构建产物的绝对路径，然后设置 `APK_PLUGIN_DIR` 并启动服务器。

API：贡献操作 `plugin.echo.echo`；HTTP 提交 `{ "operation":"plugin.echo.echo", "input":{"message":"你好"} }`；MCP 自动发现同名工具。正常输出回显输入，未知操作或版本不兼容返回错误。标准输出只能包含响应 JSON，日志写标准错误。

验证：`cargo test -p deviceforge-echo-plugin` 启动真实插件子进程，验证中文数据、请求关联和 JSON 空值。手工部署示例保留占位路径；便携包由构建从清单派生，并经过 Rust 门禁和实际 npx 任务验收。
