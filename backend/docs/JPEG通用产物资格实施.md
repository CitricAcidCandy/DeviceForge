# JPEG 通用产物资格实施

日期：2026-10-12，UTC。本文记录共享格式与通用宿主接缝，不代表 Harmony 截图生产、远端资源、像素解码或真机验收完成。

## 架构与职责

采用 architecture-first / Hybrid：先以结构、限额及原字节回归冻结共享接口，再实现具体截图插件。比较两条规则落点：

| 路线 | 变更与风险 |
| --- | --- |
| 宿主和 Harmony 各实现一套 JPEG 规则 | 初始改动局部，但错误分类、格式范围与资源限额可能分歧；新增图像插件继续复制。 |
| data-codec 共享纯增量规则，宿主与插件薄适配 | 增加一个独立格式模块；两端共用结构与限额，不把文件、平台命令或任务生命周期放入公共库。 |

选择共享纯规则。公开 SDK、HTTP DTO、设备路由和生成类型不变，JSON/MessagePack 的既有错误类型及 16 MiB 限额不变。

| 文件 | 职责与所有者 |
| --- | --- |
| `crates/data-codec/src/jpeg.rs` | 主代理：固定状态、字节/标记限额、扫描区与结束状态；无 I/O。 |
| `crates/data-codec/src/jpeg/segments.rs` | 主代理：纯 SOF/SOS 字段、组件与渐进频段历史规则。 |
| `crates/data-codec/tests/jpeg.rs` | 主代理：独立构造结构帧，验证有效与无效分块、截断、字段及资源边界。 |
| `crates/infrastructure/src/artifacts/mod.rs` | 主代理：jpg/jpeg 媒体类型与上传流提前限额，复用原发布流程。 |
| `crates/infrastructure/src/artifacts/validation.rs` | 主代理：在既有受限工作池内以 64 KiB 缓冲读取并调用同一 Validator。 |
| `crates/infrastructure/tests/artifacts_jpeg.rs` | 主代理：流式存储、失败不发布、元数据/原字节、低部署限额及格式硬限。 |
| `crates/server/tests/artifacts_jpeg.rs` | 主代理：原路由的 HTTP v1/v2 原字节、v2 日志 ID 和 MCP inspect 共享元数据。 |
| Harmony 插件私有 `screenshot/jpeg.rs` | 后端代理：原期限、取消与错误映射薄适配，禁止复制规则。 |

## 公开格式与限制

`deviceforge_data_codec::jpeg::Validator` 通过 `new()`/`Default` 创建，分块 `push(&[u8])`，最后 `finish(self)` 返回 `Info { width, height }`。错误为 `Limit`、`Invalid` 或 `Unsupported`；一次失败之后不能恢复验证。

- 字节最多 64 MiB；SOI 后标记最多 65,536 个，包括 EOI 与重启标记，FF00 转义和填充不计标记。
- 支持 8 位 SOF0/SOF2、1 至 4 组件；精确段边界、非零尺寸、组件标识、采样因子、SOS 选择及谱范围。
- 固定 256 字节近似表记录各组件频段的前次 Al，拒绝初次扫描重叠、未初始化细化及不连续细化；重启区间必须存在扫描字节且序号循环正确。
- 不解析 DQT/DHT 表内容或引用，不执行熵 MCU、完整像素解码或视觉检查。最小结构测试帧不能作为可解码图像样本。

宿主将 `jpg`/`jpeg` 不区分大小写地映射为 `image/jpeg`。上传上限取部署上限与格式 64 MiB 的较小值；JPEG 验证器超限映射为领域 `TooLarge`，其余映射为 `Invalid`。插件输出资格沿现有通用内容门禁使用该格式，不增加 Harmony 分支。

## 首阶段验证

初版 27 项定点与 data-codec 17 项通过后开放截图实施；独立静态审核发现空重启区间和渐进扫描历史漏拒绝，新增回归先取得 10 通过/3 失败，再修复为 13/13。当前定点为 29/29，data-codec 全量为 19/19；对应定点 Clippy、rustfmt 和差异检查通过。初版与修后报告分别保留，不用首版结果覆盖修后代码。

修后原件位于根 artifacts：`harmony-jpeg-review-red-20261012.txt`、`harmony-jpeg-review-green-20261012.txt`、`harmony-jpeg-reviewed-targeted-20261012.txt`；11 个公共/宿主输入身份为 `harmony-jpeg-reviewed-inputs-20261012.json`。

当前真实宿主两模式报告为 `jpeg-artifact-smoke-debug-lh9bGa/report.json` 与 `jpeg-artifact-smoke-release-GrjPAt/report.json`。验证两种后缀、两产物、四次 HTTP v1/v2 原字节下载、MCP 两 Job 共享元数据、三类非法内容及服务日志关联；Rust 直接进程 exit/close 均为 0，七个指定输入前后大小和 SHA256 一致。成功临时目录已由既有宿主辅助清理，报告与日志另行保留。

上述服务不采集 SQLite 原件、端口独立探测、截图远端 writer/reader、JPEG 像素或真机。当前截图生产与协议仍在实施，完整 workspace、全量门禁、截图服务及正式包/npx 需按新冻结输入另验。

独立原件审核发现四次 JPEG 下载在宿主日志均为“响应流被提前关闭”，日志计数为完整 31 字节。驱动实际 `arrayBuffer`、原字节和摘要断言通过，因此可以报告内容下载完整；不能据此报告日志侧正常 EOF 已证明，也不把告警直接改写为截断失败。通用日志语义问题独立排队，不通过反复运行或本批格式修改掩盖该观察。
