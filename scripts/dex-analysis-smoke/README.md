# DEX 直接分析真实服务验证

执行 `node scripts/dex-analysis-smoke.mjs`；当前 release 宿主与插件重建后追加 `--release`。入口只消费已构建的 `apk-server` 与 `deviceforge-dex-analysis-plugin`，不执行 Cargo，也不修改部署者配置。

每轮复制宿主、插件、清单与驱动到独立 artifacts 目录，记录运行前后 SHA256。真实前端公共 API、Job runner 与 DEX 基础用例源码另作成员与摘要核对，不构建或添加产品界面。

## 覆盖

- 独立插件运行中加载、两贡献进入 MCP 工具目录。
- HTTP 上传 `.DEX`，核对媒体类型、大小、摘要与 v1/v2 原字节下载。
- 实际调用前端 `createHttpDexAnalysis` 的目录、inspect 和 scanSdks；固定统计、完整性及 SDK 证据。
- MCP 实际提交两贡献，HTTP/MCP 查询同一 Job；最低资格允许但 Adler32 错误的输入由插件失败，下载仍保留原字节。
- 卸载撤销目录，新提交拒绝；前端通过原 MCP 任务身份恢复历史，不要求在线插件或重新提交。
- 所有客户端响应日志 ID 落盘，每项插件 Job 的开始/结束关联原提交日志；正常宿主退出、监听释放及输入身份稳定。

夹具是独立手工构造的标准 039 DEX，包含两条字符串、两类型及一个定义类；外部引用不得当作已安装 SDK 的证据。这条实际进程与网络链路不证明真实编译 APK、完整指令语义、真机、浏览器界面、正式分发或跨平台。

每轮 `report.json` 保留实际通过项、Job、响应、输入身份与日志位置。失败轮保留原件；未执行的模式不记为通过。

## 实际结果

2026-10-12 debug修后入口exit0，`artifacts/dex-analysis-service-debug-b0d929ff-5deb-4798-a2b9-a8099f8b6330/report.json`通过7检查、5Job、187日志、44响应ID、6原输入与25前端源码成员身份。首轮上传后插件输入白名单拒绝DEX，原件`artifacts/dex-analysis-service-first-20261012.txt`保留；补通用输入白名单后重建宿主，另开修后轮，未放宽插件完整校验。release及其它未验范围保持。
