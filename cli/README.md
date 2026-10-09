# DeviceForge 启动与服务器插件安装

CLI 只负责分发边界，不复制设备业务。`bin/deviceforge.mjs` 是入口；src/options 解析参数；network 生成监听及 Host/Origin；start 管理生命周期；web-server 提供静态资源和固定后端流式代理；processes 管理进程；runtime/paths 校验运行包；install、plugin-package、plugin-files 分别编排安装、解析便携清单与受限复制。

## 使用
在根目录执行 `npm run prepare:runtime` 构建当前平台 release 运行包，随后 `npm pack --pack-destination artifacts`。生成的 tgz 携带 Rust 程序、插件校验器和前端资源，使用者只需 Node.js/npm，无需 Rust。发布 npm 后可使用 `npx @deviceforge/cli start`；当前没有发布 registry，验收与使用应指定本地打包 tgz：

```powershell
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge --help
# 配置 APK_API_TOKEN 后，默认允许局域网访问。
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge start --ip 0.0.0.0 --port 7030 --mcp-port 7032
npx --yes --package .\artifacts\deviceforge-cli-0.1.0.tgz deviceforge plugin install .\my-plugin --data-dir .\runtime-data
```

默认绑定 0.0.0.0；--ip 接受 IPv4/IPv6 字面量。前端/API 默认 7030，独立 MCP 默认 7032，端口不能相同。MCP 端口仅提供 /mcp，前端端口也可代理 /mcp；两者共用 Rust 任务。局域网监听要求 APK_API_TOKEN，CLI 不打印令牌、不把它放入 HTML 或代客户端注入；客户端以 Bearer 使用 API。仅绑定 127.0.0.1 或 ::1 时允许生成临时随机令牌。现阶段 UI 是无业务骨架，没有登录或令牌输入页面。

数据默认 ~/.deviceforge，可由 --data-dir 或 DEVICEFORGE_DATA_DIR 配置；插件默认 data-dir/plugins，可由部署 APK_PLUGIN_DIR 配置。相对 APK_PLUGIN_DIR 按 CLI 当前工作目录解析，安装、列举和启动共用该位置，Rust 接收绝对路径。持久数据不写 npm 缓存。工具部署继续通过 APK_ADB/APK_HDC 等配置。错误的 Host 被拒绝，MCP Origin 按实际网卡与两端口生成；未支持任意自定义域名。

Ctrl+C/SIGTERM、启动失败或后端异常退出时停止对外监听与本次进程。正常停止先通过本次回环后端的鉴权接口收敛任务/会话并刷新日志，最多等待 5 秒；超时才强制清理本次服务树。经过鉴权的 system/shutdown 接口也可让 npx 正常退出。默认日志写入 data-dir/logs，启动输出日志位置；DEVICEFORGE_LOG_DIR 可调整，相对值按 CLI 工作目录解析。设备操作不会自动回滚，外部设备进程需单独验收。

## 服务器插件包
`plugin install` 接受本地目录、本地 .tgz、npm 包名及可选版本；不接受任意 URL、Git 地址或 shell 指令。安装禁用 npm 生命周期脚本，保留 npm 已解析的依赖布局。包依赖若必须执行原生 postinstall，应由开发者预编译后发布。安装本地目录要求它已具备运行依赖。

包根 package.json 增加：

```json
{
  "name": "example-deviceforge-plugin",
  "version": "1.0.0",
  "deviceforge": {
    "kind": "server",
    "manifest": "plugin.json",
    "entrypoints": {
      "win32-x64": { "runtime": "native", "path": "bin/plugin.exe" },
      "any": { "runtime": "node", "path": "entry.mjs" }
    }
  }
}
```

plugin.json 使用公开 SDK 清单字段 id/version/protocol_version/args/operations 以及可选 artifacts/performance，省略 executable；入口由安装器生成绝对路径。Node 入口使用当前 Node 程序，native 使用声明平台程序。版本必须与 npm 包一致，入口必须为包内非链接普通文件。

安装先复制到发布目录同卷的独立暂存区，限制 256 MiB、20000 文件、32 层，拒绝链接；再调用同包 Rust validate-plugin 校验协议、能力、命名空间与输入模式，最后原子 rename 发布。该门禁不执行插件代码。相同 ID 拒绝覆盖，同 ID 安装锁拒绝并发；失败或取消清理本次暂存/锁，崩溃遗留锁需要部署者检查处理。依赖获取阶段没有磁盘硬配额，管理员应控制 npm 源与包信任。

plugin list 返回本地部署清单概要。安装可在服务运行中执行，原子发布后通过鉴权 POST /api/v2/plugins/{id}/load 或 MCP deviceforge.load_plugin 显式加载；/unload 或 deviceforge.unload_plugin 撤销贡献、取消并等待任务。部署文件保留，历史任务保留，重新加载生成新代际；受保护性能探针拒绝卸载。CLI 尚无专门的 load/unload 子命令，同 ID 包更新/删除、来源签名与系统沙箱未实现；常驻设备插件和浏览器动态加载仍在后续范围。

## 验收与发布边界
`npm test` 覆盖参数、网络、路径/来源、安装拒绝、实际 Rust 门禁、真实 HTTP/MCP、取消和端口冲突；`npm run smoke:cli` 打包并通过真实 npx 安装 tgz 插件，再验证依赖、禁用安装脚本、插件任务及本机/局域网地址。静态服务验收不等于页面视觉审核，未改变前端业务页面。

当前运行包仅包含构建主机的平台。发布前需分别构建 Windows/Linux/macOS 的目标程序并组成平台包或平台矩阵，不能把 Windows 验收写成跨平台验证。--debug 仅用于开发验收；默认 prepare:runtime 使用 release。registry 发布、下载来源签名、其他平台与另一台局域网客户端验收单独跟踪。
