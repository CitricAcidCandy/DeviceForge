# 录像基础消费真实宿主验收

入口为`node scripts/mirroring-consumption-smoke.mjs --frozen-input=主代理冻结目录`，要求Windows、Node24、修后宿主、独立mirroring插件及实际OS探针。冻结目录包含`apk-server.exe`、`deviceforge-mirroring-plugin.exe`和`manifest.json`；默认目录为`artifacts/mirroring-consumption-frozen-debug-20261012`。本驱动不运行Cargo、生成器或正式分发，不改生产。

独立标准库工具源码为本目录`fake-tool.rs`，单独编译到`artifacts/mirroring-consumption-fixtures-20261012/mirroring-tool.exe`；可用`--tool=绝对路径`替换。服务必须等待主代理明确修后冻结，不能用原白名单宿主或其它扩展名绕过MP4资格。

## 真实验收范围

- 实际`createApiClient`、`createHttpMirroring`与共享Job工厂，先刷新双贡献目录；未发现时零提交。
- `runtime.status`查询真实可控工具版本，要求空产物与非直播；只证明配置工具可用，不证明设备连通。
- 平铺record输入、基本缺省1280/30与显式max_size/max_fps、非整秒时长向上取整，固定十一项scrcpy argv与部署ADB环境入口。
- HTTP真实前端提交、MCP提交后同Job前端恢复，唯一screen.mp4、业务设备/时长/编码/大小与实际元数据一致，下载原字节和SHA-256一致。
- 前端与HTTP/MCP非法输入零Job零工具；工具exit0但坏ftyp失败不发布，部分输出物理删除。
- 中断前端等待保留原票据，再明确取消；另一个在途录像由插件卸载取消。两次均不释放正常工具门闩，实际OS非零退出与父插件exit0独立确认。
- 卸载贡献撤销、撤离部署目录后原Job/唯一终态事件/视频原字节保留，前端恢复不重提；双贡献新代次重载后实际新录像成功。
- 每个工具取得本次OS句柄、路径、PID与创建身份，核对真实退出码和授权输出路径物理清理。全部响应日志ID、唯一插件request_id与终态码关联；普通日志不记录工具stdout。
- 宿主/插件/工具/清单/探针实际快照、Node、驱动相对导入、插件源码、实际前端导入闭包与部署配置在运行前后摘要稳定；宿主正常exit0、监听释放。

## 独立黄金与边界

本批黄金MP4仅36字节，由24字节ftyp与12字节mdat容器盒组成。按独立固定字节核对盒长/类型、实际文件、下载大小与SHA，不调用生产解析器作为oracle。可控工具复制这些预定字节，不执行录屏、编码或设备连接。坏头部用12字节零值作负例，不能把该负例改扩展名为其它格式通过。

这是公开现有ftyp资格、固定编排与真实消费证据，不证明完整MP4解码、可播放H264、实际分辨率/FPS或设备状态。结果不回显max_size/max_fps，不能从参数已提交扩大为这些效果已验证。录制不是浏览器直播、音频、控制、重连或完整投屏迁移完成。

OS探针只持本地可控工具和父插件的直接句柄，不证明scrcpy/ADB派生树、共享daemon或远端资源回收。未计真机、浏览器、release、正式TGZ/npx、跨平台或性能。

每轮报告为`artifacts/mirroring-consumption-service-debug-UUID/report.json`，保留SQLite、日志、实际快照、工具观测和探针原件。首失败持续保留；完整通过只能在实际退出、监听释放、日志与全部输入身份完成后成立。

## 2026-10-12实际完成证据

主代理修后独立冻结`plugin-formats-debug-frozen-56f8cffe-a0c6-489e-b38a-901fd5a688fe/mirroring`实际运行，报告为`artifacts/mirroring-consumption-service-debug-503921a0-53f6-450f-92d0-24b31cf9798b/report.json`。驱动终端实际退出0，九项检查、八Job及八工具符合预期：五成功、一坏MP4资格失败、两取消。六正常工具退出0，取消及在途卸载工具各退出1，八独立父插件与八探针全部实际退出0。

51项输入含25项实际前端导入，另外四项工具/黄金输入、五程序快照及部署配置/清单前后摘要稳定。七次视频下载原字节、大小和SHA一致，三次历史核对覆盖卸载后、部署撤离后及新代次后原七Job，前端恢复没有重发；新代次新录像成功。924条日志关联244个响应ID和八个唯一插件request_id。宿主PID54328正常退出0，64985监听释放。

首轮`1c3b61ba-1236-4dd6-bde4-a9e5991037c3`因驱动误将授权临时输出限定在数据目录而退出1，原件保留。公开产物上下文使用独占系统临时目录；修后由本轮宿主继承的TEMP/TMP/TMPDIR指定独立`authorized-temporary`根，启动后立即还原驱动原环境，全部录像核对该根下互不复用的`outputs/screen.mp4`、固定argv、真实原字节及退出后文件消失。等待中断按`JobWaitFailure.job`与`submitLogId`提取票据，卸载终态按公开`JobFailure`读取原Job；生产、前端、冻结程序和执行预算没有改动。

本节只计实际宿主与前端工厂对合成容器的消费、现有ftyp资格与直接退出证据；真实scrcpy/ADB、真机、H264解码/播放效果、浏览器界面、直播和正式分发继续未验。
