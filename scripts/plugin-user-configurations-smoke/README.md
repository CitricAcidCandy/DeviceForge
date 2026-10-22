# 用户目录插件配置验收

此脚本验证插件包部署、业务数据和用户配置三者独立：服务器与浏览器插件的托管配置统一保存在 `DEVICEFORGE_USER_DIR/plugin-configurations/{server,browser}`；更换 `APK_DATA_DIR` 后仍能读取同一份用户配置。

## 执行入口

由主代理先构建并指定本轮宿主，脚本自身不执行 Cargo，不使用预览实例、不访问设备：

```powershell
node scripts/plugin-user-configurations-smoke.mjs --binary backend/target/debug/apk-server.exe
```

已有 Vite 服务时，可一次执行 HTTP、真实浏览器模型及宿主重启后的浏览器复读：

```powershell
node scripts/plugin-user-configurations-smoke/browser.mjs --binary backend/target/debug/apk-server.exe --dev-url http://127.0.0.1:5173
```

该组合入口复用同一私有部署、用户根和两轮业务目录，不自行构建或启动 Vite。`browser-setup/report.json` 记录首次浏览器与实际页面刷新；`browser-restart/report.json` 记录第二业务目录宿主启动后，全新浏览器上下文的同修订复读。顶层报告引用两份报告并校验驱动退出码。

需要手动提供临时 API 地址时，独立驱动入口为：

```powershell
node frontend/scripts/browser-user-configuration-smoke.ts --api-url http://127.0.0.1:<隔离端口> --dev-url http://127.0.0.1:5173 --run-id <本轮UUID> --output artifacts/<全新首次目录>
node frontend/scripts/browser-user-configuration-smoke.ts --api-url http://127.0.0.1:<重启后隔离端口> --dev-url http://127.0.0.1:5173 --run-id <同一UUID> --phase restart --state artifacts/<首次目录>/report.json --output artifacts/<全新重启目录>
```

独立入口必须指向隔离宿主，不得传入用户预览 API。驱动使用全新 Edge 配置目录和 Vite 纯模块文档，只导入配置功能、公开 API 与插件管理器，不挂载产品页面或默认插件实例，也不截图。可用 `--browser <程序路径>` 选择本机 Chromium 浏览器。

浏览器行为包括旧 localStorage 完整迁移、服务器已有值优先、默认首次落盘、保存后新模型/页面刷新重读、SDK 配置读取前保持 loading、激活取得用户配置、保存及首次落盘失败无本地降级，以及配置读取失败阻止插件激活。失败路径只对本轮注入的 transport 制造受控网络错误，正常路径均走真实 HTTP；证据明确分开，不冒充真实断网测试。

可用 `--output artifacts/<本轮唯一目录>` 指定证据目录。目录必须不存在，防止覆盖旧报告。脚本会复制所选二进制并计算 SHA-256；默认在 `artifacts` 创建唯一目录。

## 隔离与证据

- 过滤继承的 `APK_*`、`DEVICEFORGE_*` 环境变量，显式设置私有业务根、插件部署根、浏览器包根和 `DEVICEFORGE_USER_DIR`。
- 两次宿主顺序启动，共用同一用户配置根和部署目录，分别使用两个全新业务目录。
- 使用本仓库受控 Node 协议 1 插件验证下次调用能消费托管配置，不调用 ADB、scrcpy 或外部工具。
- 覆盖服务器与浏览器配置的首次保存、重读、过期修订拒绝、跨业务根重启保留，以及部署清单字节不变。
- 检查用户根实际产生两类存储，并确认两个业务根没有 `plugin-configurations` 目录。
- 每轮通过公开 HTTP 关闭服务，确认退出码为 0、监听端口释放；失败时仅清理本次持有的宿主进程。
- 请求证据只记录路径、方法、状态码、日志 ID 和错误码，不保存请求体、响应体或配置敏感值。

`report.json` 的顶层 `passed` 只有在全部检查及进程清理通过时才为 `true`。浏览器驱动另校验正常退出、调试端口释放和私有 profile 清理。本脚本的实际服务与模型行为通过不能替代产品界面、真实第三方插件、真机、正式分发或性能验收。
