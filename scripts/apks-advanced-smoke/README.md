# APKS高级公开链路独立验收

入口为`node scripts/apks-advanced-smoke.mjs`，要求Windows、Node24及已编译的冻结debug宿主、validator、两插件、std-only工具和真实OS退出探针。驱动不运行Cargo，不修改生产、生成类型或旧工程。

默认冻结目录为`artifacts/apks-advanced-frozen-debug-20261012`，十成员逐件核对既有`identity.json`后再复制到本轮独占快照。默认可控工具为`artifacts/apks-advanced-fixtures-20261012/fake-java.exe`；可用`--frozen-input=绝对路径`和`--tool=绝对路径`显式替换，仍须满足同一冻结身份格式。探针来自`artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe`。

## 验收范围

- 新包插件贡献的基本规格、高级features/GL/codename/tier、模块选择、instant、显式空/null/false和单独ALL，HTTP/MCP共享Job与唯一终态。
- 旧alias保持四字段输入与历史结果；不把新贡献的高级字段扩写为旧alias能力。
- 设备插件安装缺省兼容与嵌套modules、null、公开能力动作ALL，真实设备目录资格和代次。
- 固定Java argv、真实私有输入副本原字节、私有规格JSON的独立精确camelCase金样；安装cwd和TEMP/TMP/TMPDIR均落入私有目录。
- 九类HTTP/MCP非法输入准入拒绝且零Job/工具；ALL混用、设备字符串48KiB超限与安装显示名资格业务拒绝且零Java。
- 实际前端`createApiClient`、`createHttpJobGateway`、`createPackageAnalysis`及`prepareApksInstallInput`消费，单提交、原字节下载、同Job恢复和能力嵌套安装输入。
- 安装在途取消、提取在途卸载、贡献撤销、双部署目录撤离后原Job/事件/下载产物保留；重载新代次后不重提旧Job。
- 每个实际工具取得OS句柄，核对当前冻结父插件身份、父子真实退出码和私有目录物理清理；正常宿主exit0及监听释放。
- 实际响应日志ID、Job/request关联和私有JSON/工具stdout过滤；程序、两插件全源码、前端导入闭包、驱动及夹具运行前后摘要稳定。

## 独立证据与边界

固定APKS由独立Stored ZIP金样生成，包含最小合成`toc.pb`与两份独立APK。可控Java只负责固定参数观测和输出两份预定APK，不解析toc、不执行匹配、不展开依赖；安装输出也不能证明设备实际改变。ZIP下载用独立中心目录、解压和CRC读取器验证每份APK原字节。

本次直接部署实际包插件`manifest.json`。其示例清单保留旧四字段，不声称两份清单相同；设备插件两清单仍须一致。部署合并格式2旧绑定并由实际validator核对七项与十二项贡献。直接目录部署不是在线TGZ、CLI install或npx证据。

真实工具资格仅只读旧工程已有两个bundletool 1.3.0 JAR、Manifest入口与嵌入版本字符串、Java release和程序身份；限定搜索旧`Tools`、`resources`、`test`的APKS。不会执行Java或全盘搜索。没有合法真实APKS时，真实JVM/bundletool匹配、模块依赖展开、目标设备及真机安装继续明确未验。

每次生成独立`artifacts/apks-advanced-service-debug-UUID/report.json`及真实SQLite、日志、快照、工具观测和OS探针原件。首失败保留，不覆盖为通过；退出失败会独立记录。完整通过标记仅在正常退出、日志与全部身份核对之后成立。

不扩称release、正式分发、浏览器、跨平台、派生进程树、共享ADB daemon、设备事务回滚或性能验收完成。

## 本次已取得证据

2026年10月12日实际debug报告为`artifacts/apks-advanced-service-debug-37e46e22-3a07-4bf9-8b72-d46e1e9fd8d4/report.json`。入口进程退出0，24项检查、19个Job（13成功、4预期失败、2取消）、15个直接工具通过；151个运行输入包含29个前端源码，运行前后摘要一致。12次独立下载核对原APK字节；1819条真实日志、447个实际响应ID全部关联。

15个工具和各自父插件均由OS句柄确认真实退出，正常13个工具exit0，在途取消与卸载工具各exit1；全部父插件exit0。宿主正常exit0，61961端口重新绑定验证释放，没有强杀记录。双插件卸载、部署目录撤离和新代次后的18个旧Job/事件原文均保留；新代次另提交一个基本提取成功。

前五轮失败报告保留在相应UUID目录。问题均位于驱动：load目录包含旧alias，设备贡献专用预算不序列化为普通execution，设备目录返回提供者数组封套，累计规则经插件映射为既有公共输入错误。窄修驱动断言后才取得本次通过，未改变生产、合成工具或冻结十成员。

只读资格确认两个24788267字节JAR摘要一致，静态入口为`BundleToolMain`且版本类含1.3.0；Java release为16.0.1。限定三个旧目录搜索没有APKS，本次没有运行真实Java，因此没有真实bundletool匹配或真机安装通过证据。
