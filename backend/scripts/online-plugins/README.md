# 在线插件安装独立验收

`../online-plugins-smoke.mjs` 负责真实 HTTP/MCP、安装和运行生命周期、静态资源及落盘日志验证；`fixtures.mjs` 仅生成小型自包含 npm TGZ 和部署快照，不调用 npm、Cargo、分发构建或下载依赖。所有临时文件位于本次创建的系统临时目录；正常和失败关闭仅处理本脚本派生的宿主进程，不终止无关进程。

## 运行准备

由主代理统一构建包含在线安装接口的当前 apk-server。默认使用 backend/target/debug/apk-server，Windows 带 .exe；`--release` 改用 backend/target/release。脚本从自身位置确定工程根，可在项目根目录执行：

```powershell
node --check backend/scripts/online-plugins-smoke.mjs
node --check backend/scripts/online-plugins/fixtures.mjs
node backend/scripts/online-plugins-smoke.mjs
node backend/scripts/online-plugins-smoke.mjs --release
```

启动前过滤已有 APK_/DEVICEFORGE_ 测试配置，不传 APK_API_TOKEN，证明默认免鉴权路径；设置本次 APK_DATA_DIR、APK_PLUGIN_DIR、APK_BROWSER_PLUGIN_DIR，使用 DEVICEFORGE_NODE=process.execPath 确定真实 Node 程序。宿主仅监听本机回环，APK_MCP_HOSTS/APK_MCP_ORIGINS 显式对应本次动态监听地址，避免测试 Origin 被默认配置拒绝。报告写到根 artifacts/online-plugins-smoke-{profile}.json，记录已通过场景和实际失败，脚本编写或语法检查不能算真实验收。

## 覆盖

- 包均含 package.json.deviceforge 和 plugin.json，TAR 条目使用 npm package/ 根目录，原字节以 application/gzip 上传 POST /api/v2/plugin-packages/{kind}?format=tgz。目录 GET、安装 201 和删除 200 都核对 v2 JSON 包装及日志 ID。
- 两个 Node 服务器回显包分别使用协议 1/2；安装不执行包安装脚本或入口、不自动加载。显式 HTTP 加载后提交 HTTP/MCP 任务并核对真实结果；已加载时删除返回 409，卸载后 DELETE 成功、操作撤销、部署消失，完成历史仍可读取。重复安装不覆盖。
- 浏览器包清单 api_version=2，入口 any={runtime:browser,path:dist/index.js}，ESM 含相对 settings.json 引用。安装入口 URL、普通 assets 别名和 runs/{run_id}/assets 路径均保留 JS/JSON 原字节、媒体类型和日志头；同 ID 重复安装拒绝，删除后目录、入口和资源不可读取。
- 损坏服务器清单、缺失入口、浏览器 API 不兼容、包种类不符、TAR 重复路径、路径越界和损坏 GZIP 返回受控失败；缺失入口按当前路径端口返回 404/not_found，其他夹具返回 400/invalid_input。请求前后比较两类部署树（包括内部暂存/锁）以确认无残留，无路径越界落盘；允许最多 5 秒等待异步暂存守卫收敛。夹具使用小数据，不做资源极限或负载测量。
- 无令牌 shutdown 正常退出后核对 JSONL 日志、任务/插件与请求关联；不重启宿主完成全部安装、运行、卸载和删除。只清理已验证位于系统临时目录内的本次目录，正常产物报告保留。

本轮只验证可信代码部署、真实 HTTP/MCP、Node 任务与浏览器静态模块资源。未在浏览器导入或运行 ESM、挂载组件、检查 UI、验证贡献撤销/请求订阅/DOM 清理，也未验收隔离、真机、远端局域网客户端或分发；这些边界不能由资源可读取替代。

## 实际 debug 验证（2026-10-09）

定向 `cargo build -p apk-server --bins` 退出码 0。首轮 smoke 因测试未配置动态端口 MCP Origin 收到 403，退出码 1；仅补测试环境的 Host/Origin 配置，未修改后端。修正后 smoke 退出码 0，两个协议的 4 项真实 HTTP/MCP 任务、浏览器 6 次原字节资源读取、7 类失败包回滚、删除保护与正常退出均通过，报告含 455 条落盘日志和 116 个响应日志 ID。报告为 artifacts/online-plugins-smoke-debug.json；release 和浏览器运行/UI 验收未由本脚本执行。
