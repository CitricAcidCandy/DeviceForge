# 投屏录像业务用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

`createHttpMirroring` 使用生成的公开类型、真实 HTTP 任务网关和原字节产物接口，只消费 `plugin.mirroring.runtime.status` 与 `plugin.mirroring.record`。新提交前必须显式调用 `refreshOperations`；刷新开始立即撤销旧目录，失败、取消、替换和销毁后的晚到结果均不能恢复入口。`snapshot` 提供本次目录、刷新状态、错误和真实日志 ID。

`createMirroring` 保留已有任务网关和产物读取器注入签名；可通过 `options.operations` 注入动态公开目录。未注入目录时保持旧调用语义，目录快照为空，不能将其视为贡献发现证据。`catalog.ts` 负责目录代际；`rules.ts` 校验设备、1000–120000 毫秒时长及分辨率/帧率范围；`results.ts` 核对设备回显、H264、向上整秒时长、128 MiB 文件上限和唯一 `screen.mp4` 元数据；`index.ts` 组合任务与下载。输入与业务结果建立冻结副本，调用者修改原对象不改变已提交设备、时长或解码预期。

普通请求字段平铺，只提供业务设备、时长及可选编码参数；缺省值由后端决定。设备允许 1–200 个 ASCII 字母、数字或 `._:-`，首字符不能为 `-`；最大尺寸为 64–4096，最大帧率为 1–60。录像后端固定关闭播放、控制与音频，录像结果明确保留 `live_stream:false`。工具状态兼容早期 `live_stream:false`，当前支持 `live_stream:true` 与布尔 `live_configured`，分别说明插件具备直播能力和部署包含直播配置；`available` 仍只说明 scrcpy 可执行，不证明 ADB、服务或设备连通。结果不回显最大尺寸或帧率，因此不把提交选择写成实际输出已经验证。

录像任务结束并发布 MP4 后才可下载。下载前重新校验发布结果与产物对应关系，随后核对原字节大小、SHA-256 和前 12 字节 MP4 文件头。文件头资格与后端一致，只要求 `ftyp` 和首段声明大小至少 12 字节；完整容器、H264 解码、实际尺寸及帧率仍需真实媒体检查。下载失败或收到响应后取消时保留真实下载日志 ID。

取消信号只结束客户端等待，不伪造录像结束或回滚；`resumeStatus`、`resumeRecord`、`queryJob` 与显式 `cancel` 使用原任务票据，不重新开始录像，也不依赖当前目录仍存在。`dispose` 撤销本实例目录、任务和下载等待，消费忽略取消的晚到拒绝；它不自动取消服务器任务，也不证明远端工具进程已退出。

原 `mirroring-consumption.test.ts` 保持兼容用例字节；`mirroring-http-consumption.test.ts` 补公开 HTTP、目录竞态、输入与结果边界、取消恢复、错任务身份和下载验证。直播、音频、控制与重连的无页面消费在独立 `features/mirroring-streaming` 中实现，详见 [投屏直播消费契约](../../../docs/投屏直播消费契约.md)。当前产品页面、真实浏览器播放、真机和远端资源退出验收继续独立取得证据。
