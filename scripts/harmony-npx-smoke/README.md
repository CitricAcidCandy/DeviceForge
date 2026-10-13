# Harmony 正式包与 npx 独立验收

此入口仅消费主代理交付的正式 CLI 原 TGZ、正式 Harmony 原 TGZ、打包使用的 Harmony release 原 binary 与已编译假 HDC。入口不运行 Cargo、rustc、npm pack、运行包生成器，不修改现有 cli-smoke，不连接用户已有服务。

## 主代理准备与执行

先完成同一冻结版本的后端门禁及独立 Harmony debug/release 服务，再串行准备 CLI 运行包与原生插件包。正式原生打包器必须显式选择 harmony-device，现 cli-smoke 的八包集合不包含 Harmony，不能借记其分发证据。

```powershell
node scripts/prepare-runtime.mjs
node scripts/verify-package.mjs
npm pack --pack-destination artifacts
node scripts/pack-native-plugins.mjs harmony-device
rustc --edition=2024 scripts/harmony-device-smoke/fake-hdc.rs -o artifacts/harmony-npx-fake-hdc.exe
node scripts/harmony-npx-smoke.mjs --archive C:\完整路径\deviceforge-cli-0.1.0.tgz --plugin-archive C:\完整路径\deviceforge-plugin-harmony-device-win32-x64-0.1.0.tgz --plugin-binary C:\完整路径\backend\target\x86_64-pc-windows-msvc\release\deviceforge-harmony-device-plugin.exe --fake-hdc C:\完整路径\artifacts\harmony-npx-fake-hdc.exe
```

所有参数要求现有绝对路径，可加 `--source-directory` 指向冻结的当前 Harmony 元数据目录。打包器使用 Rust 原生 host 作为显式 `--target`，故 `--plugin-binary` 应指向实际打包使用的目标目录，不能改用另一次默认目标构建。需要冻结 manifest.json、aliases.example.json、harmony-device.config.example.json 与 README.md。脚本会核原包 native binary 与此原 binary 的大小和 SHA256。

## 验收范围

真实 `npx --package <CLI原TGZ> deviceforge plugin install <Harmony原TGZ>` 安装后，核 CLI `plugin list` 只列十贡献的 Harmony。正式 Harmony 包限定为六成员：README.md、package.json、plugin.json、当前平台 native binary、公开 alias 模板、公开 HDC 配置模板。全部原包成员与安装目录逐项核大小/SHA256，便携清单须与冻结源码语义一致，生成清单用公开 `materializeManifest` 重算；包内模板与源码原字节一致。

管理员使用包内 alias 模板生成独立格式2 bindings，并基于包内 HDC 配置模板物化 binary 旁置的实际 config。实际配置填写本轮独占假 HDC 与 scratch 目录，不修改便携清单、生成清单或任何包成员原字节。调用按可信本地插件执行，不引入审批或隔离机制。

两阶段共用同一 CLI 原 TGZ、同一 Harmony 原 TGZ、同一 npx 缓存、安装目录、运行数据与端口。第一阶段显式可选令牌，缺令牌 HTTP/MCP 均须401；第二阶段真正删除 APK_API_TOKEN，以默认免鉴权启动。令牌只在当前进程内生成、传递和检查，不进入报告、命令参数或保留日志。启动不传 `--ip`，必须报告默认0.0.0.0；HTTP与MCP使用不同临时端口，两个阶段各核正常关闭并重绑定双端口。

每阶段核十贡献、十显式绑定、九定义能力及owner/generation；七设备能力为packages、app.install、app.uninstall、app.detail、app.start、app.stop、app.reset，connect/disconnect两项为provider/write/30000，设备availability仍仅七项。先在没有发现目录时对两提供者能力各用HTTP/MCP一次，覆盖新连接、重复连接和静默断开，核localhost固定单argv且目录仍空，新增4 Job/4工具。随后保留原18 Job/20工具：发现使用HTTP direct与MCP alias各一次，原六设备能力各HTTP/MCP一次，详情另用capability/HTTP和alias/MCP，自动ability启动另用HTTP/MCP各一次。当前每阶段共22唯一成功Job/24假HDC，两阶段总44/48。自动ability一Job两个顺序调用且同父插件，详情完整对象保留未知字段且不要求启动字段；HAP安装核真实私有副本原字节和任务后清理，全部任务的HTTP/MCP历史及事件须一致。第二阶段新generation须不同，第一阶段历史仍可读。

最终须44个唯一Job、48次唯一HDC调用；不能靠工具目录数量代替逐Job一一映射。CLI原TGZ全成员与真实npx缓存核对，解析实际npm shim入口，核served插件宿主字节、两阶段关键资源身份相同；Harmony原TGZ全成员安装字节及生成清单再次核对。全部响应日志ID落盘，每Job唯一plugin_request_id起止与提交log_id配对，两次宿主正常结束、npx包装均exit0，输入前后原字节稳定。

## 原件与边界

报告与本次实际原TGZ写入独立 `artifacts/npx-raw-*/`，业务原件复制到该目录的 business-evidence，并保存来源/副本摘要；独占临时目录继续保留，含缓存、安装目录、真实SQLite、日志、工具argv/父插件路径/直接PID、HAP副本。失败先保留 failure-before-cleanup.json，清理失败不能抹掉首失败。只处理本次持有的进程，不结束其他服务。

这证明本地正式原TGZ、真实CLI安装与npx运行，不证明npm registry发布、真实HDC、共享daemon、真机、设备状态回滚、另一LAN主机或生产性能。公开CLI不暴露Rust PID，包装exit0与正常宿主日志不等于直接采集Rust OS退出码。工具直接PID由既有独立假HDC原件与驱动确认，不宣称派生树清理。本批成功分发路径不能替代独立148Job/130HDC服务故障、两类输入失败、取消、共享锁与卸载矩阵，前批八贡献/七能力包证据不能转计新版。

入口与文档静态完成不代表已运行通过；以主代理生成的实际报告为准。
