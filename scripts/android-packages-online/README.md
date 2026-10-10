# 安卓包插件原 TGZ 在线独立验收

状态：驱动编写完成后交主代理统一检查与执行。本文件不表示语法检查或动态通过。入口只消费已有宿主及正式原 TGZ，不构建、不打包、不注入工具或签名配置。

入口要求 `--archive` 为原 TGZ 绝对路径，`--archive-sha256` 为本轮真实压缩字节 SHA256；不得用重新生成的包替代。`--release` 仅选择已有 release 宿主，包内插件仍来自同一原件。当前交接原件为 `artifacts/android-packages-native-20261010-0347/deviceforge-plugin-android-packages-win32-x64-0.1.0.tgz`，主代理实核摘要 `6DA4C3A3B8CD91C37E60CA9F35169D8148EEDB6BAE6F3D3AF3281EF0B0AADB2D`。路径及摘要只作本次交接说明，脚本没有内置默认值。

主代理可分别执行以下命令；编写者未执行 Node、构建、测试或服务：

```powershell
node scripts/android-packages-online-smoke.mjs --archive G:\Rust\DeviceForge\artifacts\android-packages-native-20261010-0347\deviceforge-plugin-android-packages-win32-x64-0.1.0.tgz --archive-sha256 6DA4C3A3B8CD91C37E60CA9F35169D8148EEDB6BAE6F3D3AF3281EF0B0AADB2D
# release宿主由主代理另行更新后，在同一命令末尾追加 --release。
```

## 输入与四个任务

本次宿主使用新临时数据目录及源七 alias 显式配置。安装前核空包/空插件、贡献缺席和零 Job；上传同一份已校 SHA 的原始压缩字节，201 后核包存在但插件未加载、贡献仍缺席、没有管理 Job。包内没有本次工具配置，不使用真实 Android 工具。

| 任务 | 提交入口 | 固定断言 |
| --- | --- | --- |
| 提取一 | HTTP 旧 `android.package.extract_apk` | 同 Job 保留旧 operation/input；旧产物投影精确匹配；下载原 APK 字节 |
| 提取二 | MCP 新 `plugin.android-packages.extract_apk` | 公布产物 wrapper 精确匹配；本次独立产物 ID；下载相同原 APK 字节 |
| SDK 扫描一 | HTTP 新 `plugin.android-packages.scan_sdks` | 完整 findings、命中/缺失/null 及 evidence 排序 |
| SDK 扫描二 | MCP 旧 `android.package.scan_sdks` | 同 Job 旧 value 投影；保留原规则及完整 findings |

ZIP 字节由独立测试 helper 手工构造；SDK 固定期望不调用生产解析器生成。每次提交前后精确新增一个 Job，总共四个，无嵌套 alias Job。HTTP GET/MCP get_job、历史及事件核同一全文与唯一终态；两次下载分别记录实际关联头、Artifact 元数据、长度、SHA 与原字节。

## 在线生命周期与身份

HTTP 首次加载后核七新贡献和七 alias 的 schema 与有效预算；其它五操作只记目录注册，不算业务执行。加载中 DELETE 必须精确返回 409/conflict 及“服务器插件仍已加载或正在排空，请先完成卸载”，原部署字节保持。MCP 卸载后贡献撤销、四 Job 历史不变、包仍保留；MCP 重载必须出现不同 generation，随后 HTTP 卸载。新代只核注册，不追加第五个任务。

公开部署删除后核包列表为空、部署目录确实消失、load 为 404/not_found，历史仍保存。脚本不会自行删除部署目录冒充生产清理。暂存目录收敛最多等待 5 秒；只重读已知 ENOENT 快照竞争，不吞其它错误。

原 TGZ 全部普通成员逐项比较实际安装文件的 size/SHA，无固定成员数假定；正式原生包的便携声明为 `plugin.json`，安装器另外生成绝对执行路径的 `manifest.json` 与包视图。核原包声明、当前源双清单、原生入口、生成文件和实际包内插件 binary 身份，额外文件拒绝。安装/业务/装卸之间快照不变；结束再核原 TGZ、保留副本及显式 alias 来源摘要。包视图 server `api_version=null` 不推成设备 API 或协议版本。

## 收口、报告及边界

成功标记在实际宿主正常 exit0、监听释放、四个 Job 的唯一调用开始/结束及所有响应关联 ID（含两下载）落盘、身份复核全部完成后设置。失败保留首阶段/请求，finally 的 shutdown 与索引异常只能成为次要错误，不覆盖原失败。

成功及失败均保留临时根、原 TGZ 副本、输入/下载样本、部署观测、宿主日志及 `checkpoint.json`；固定报告为 `artifacts/android-packages-online-smoke-{debug|release}.json`。原 TGZ 本体不改写；旧报告应由主代理按批次另存，不能由新结果覆盖历史归属。

本组直接采宿主 PID、退出码与端口；四个无工具插件调用只通过同 Job 日志采 request_id，未直接采插件 OS PID/退出码，不能反推派生树或外部资源全部清理。端点采样不证明内部原子性；看门狗不证明性能；不计取消、真实 Android 工具、真机、原 TGZ 的 CLI install 或真实 npx。后续 npx 验收需另立原归档、缓存成员、shim/实际宿主、非空库新增 Job 子集及双端口正常退出证据。
