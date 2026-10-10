# Android 包公共核心

本库提供同步、有界的归档机制与 Android 纯解析。生产依赖仅为标准库、zip 8.6（关闭默认特性，仅 deflate）、quick-xml 0.42、serde derive、thiserror 2；测试使用 tempfile 3。不依赖宿主四层、SDK、插件运行库、工具进程库、Tokio、设备连接、网络或数据库。工作区接入与旧实现替换由主代理另行实施，新库本身不表示平台迁出完成。

## 模块与公开 API

| 模块 | 输入、输出与职责 |
| --- | --- |
| `control` | `Control::new(Option<std::time::Instant>, &(dyn Fn() -> bool + Sync))`，回调与控制值同生命周期；`check() -> Result<()>`、`deadline() -> Option<Instant>` |
| `error` | 独立 `Error`、`Result<T>`、`IoStage`、`LimitKind`；I/O 保存原 `std::io::Error`，展示文本不包含原路径 |
| `profiles` | 固定 `ArchiveProfile::Structure`、`TreeProfile::{Reverse,Splits}` 及限额；业务输入不能扩大限制 |
| `models` | 独立 `ManifestData`、`SignatureData`、`Signer`、`Scheme`、`SdkRule`、`SdkFinding`、`BuildMode`、`ApksSummary`、`CopiedEntry`、`PackedTree`；无宿主产物 ID 或实体 |
| `archive::preflight/index/paths` | 固定尾部预检、中央及本地目录边界、名称/类型校验，保留重复观测；不把目录读取当作所有 CRC 已通过 |
| `archive::io_control/copy` | 每笔底层读取/定位复核控制，绑定原容器的精确选择及完整复制；EOF、实际长度与 CRC 全成立才返回摘要 |
| `archive::tree/packing` | 含目录计数的快照、源变化复核、按名称排序的 Stored ZIP、有界写入/定位与收尾；不创建父目录或回收目录 |
| `android::{manifest,signature,apks,smali}` | 命名空间清单、签名报告、APKS 外层完整读取、反编译必要成员及 smali 路径证据；不执行工具或连接设备 |

核心类型 `Control`、错误、profile、models 从 crate 根导出。归档类型位于 `archive::{Archive,Directory,ArchiveEntry,SelectedEntry}`，树快照位于 `archive::tree::TreeSnapshot`；关键状态私有，不接受调用者伪造的目录证明或选中索引。

```rust,ignore
Archive::open(file: File, profile: ArchiveProfile, control: &Control<'_>) -> Result<Archive>
Archive::directory(&self) -> &Directory
Archive::file_size(&self) -> u64
Directory::entries(&self) -> &[ArchiveEntry]
Directory::declared_size(&self) -> u64
Archive::select_exact<'a>(&'a mut self, name: &str, control: &Control<'_>) -> Result<SelectedEntry<'a>>
SelectedEntry::copy_to(self, destination: &mut File, byte_limit: u64, control: &Control<'_>) -> Result<CopiedEntry>
tree::scan(root: &Path, profile: TreeProfile, control: &Control<'_>) -> Result<TreeSnapshot>
tree::pack(snapshot: &TreeSnapshot, destination: &mut File, control: &Control<'_>) -> Result<PackedTree>
TreeSnapshot::directory(&self) -> &Directory
TreeSnapshot::profile(&self) -> TreeProfile
android::parse_manifest(xml: &str, control: &Control<'_>) -> Result<ManifestData>
android::parse_signature(report: &str, control: &Control<'_>) -> Result<SignatureData>
android::validate_apks(archive: &mut Archive, mode: BuildMode, control: &Control<'_>) -> Result<ApksSummary>
android::validate_decoded(directory: &Directory) -> Result<()>
android::scan_sdks(directory: &Directory, rules: &[SdkRule], control: &Control<'_>) -> Result<Vec<SdkFinding>>
```

文本函数借用输入，成功模型拥有自己的字符串；不会截断 XML/report。`SelectedEntry` 可变借用原 `Archive`，复制消耗选择值。零匹配返回 `EntryMissing`，多匹配返回 `EntryDuplicate`；调用方应选择成功后再创建输出。精确名称至多 500 UTF-8 字节，通用精确选择不替 Android 调用层检查业务后缀。

## 规则与成功证明范围

| 工作 | 固定规则 | 成功所证明的范围 |
| --- | --- | --- |
| Structure | 10000 条、声明展开 2 GiB；拒绝分卷、ZIP64、加密、非法范围、重叠、危险路径、链接及特殊类型；支持 Stored/Deflate | 所有目录记录的结构观测；原始重复名不去重，尚未读取的成员 CRC 不在证明内 |
| 精确复制 | 调用者上限与 64 MiB 取小；每 64 KiB 块及底层 I/O 复核 | 所选成员完整读取、实际长度和 CRC，目标 sync 后才有摘要 |
| Reverse 树 | 文件和目录共 10000 条、深度 128、文件总量与 ZIP 完成大小各 64 MiB | 监测期可为空；最终必须有唯一非空 `apktool.yml` 与 `AndroidManifest.xml` |
| Splits 树 | 文件和目录共 1000 条，其余大小/深度同上 | 最终非空、文件仅 `.apk`，逐 APK 做 Structure 校验；不证明内层所有 CRC、签名或真机可安装 |
| APKS | 压缩输入 64 MiB，外层展开累计 256 MiB，无重名 | 所有外层成员完整读取与 CRC/长度、非空 `toc.pb`、至少一个 APK 的 ZIP 本地头标识；Universal 模式只有一个 `universal.apk` |
| Manifest | 1 MiB、20000 元素节点、128 层；唯一无命名空间根、标准 Android 属性命名空间、主要结构唯一 | 所有命名空间声明均校验实体，URI 按 XML 属性值规范化后比较及判重；保留字符串/None、布尔、排序权限和原 XML，拒绝 DTD/未定义实体/歧义，不解析二进制 XML 或资源标签 |
| Signature | 1 MiB；明确 `Verifies`、至少一成功方案、1–32 连续签名者及完整 64 位十六进制 SHA256 | 当前报告的明确验证结果，保留警告及原 report；不增加 `-Werr` 或其他签名算法 |
| SDK 路径 | 1–100 条唯一有界规则，合法包/类标识；`smali` 与 `smali_classesN`（N≥2） | 仅路径证据、包前缀边界、每条最多 10 个排序证据，指定类命中不会被挤掉；不识别 DEX 或 SDK 版本 |

归档名称沿 ZIP 的 UTF-8/CP437 解释，并核对解码视图与中央目录观测。目录由独立固定结构读取，避免 ZIP 解码器按原始文件名去重后丢失观测；实际读成员复用同一文件的解码元数据，并在内部注明该受控复用的安全依据。底层读/seek 错误保留原 I/O，解码、CRC 与长度错误归 `InvalidArchive`。

复用解码元数据要求调用者在 `Archive` 的整个使用期内保持输入文件内容稳定，包括中央目录、本地头及成员数据；同一 File 句柄并不保证字节不变，其他句柄或路径仍可能改写该文件。本库没有不可变快照、锁定源内容或并发改写检测保证，不能把缓存视为字节身份已冻结。CRC/长度是本次读到内容的校验，不替代上述输入稳定假设；不稳定来源应由调用层先建立独占稳定副本。

树扫描拒绝根及子项的链接、Windows 重解析点与特殊文件；目录和相对名称排序。打包前及完成时重新扫描，逐文件打开前/复制后复核路径、类型和长度；Stored 输出包含真实 ZIP 头部与目录开销，并限制最大写入范围，seek 回写头部不能绕过限额。故障后封住底层，ZIP writer 的 Drop 不能继续写收尾。空目录计入树限额，完成 ZIP 仅包含排序普通文件。

## 控制、文件与调用方责任

`check` 先判断 `Some(D)` 已到期，返回 `Timeout`，否则查询取消回调并按信号返回 `Cancelled`；同刻取消与到期选择超时。`None` 不增加阶段预算。回调只能只读共享取消状态，必须同步、无 I/O、无阻塞、不得重置预算。库不会创建计时器、线程、取消树或默认预算。

每次新文件 I/O、条目/目录/解析循环、64 KiB 复制块和返回成功前都复核控制。已经在进行的同步系统调用不能被此控制强制中断；检查错误不等于所有 worker 或外部工具已停止。本库没有 `CleanupFailed`，也没有清理资格判断。

输出必须由调用者以 `create_new` 独占创建，核心只借用空普通 File，检查长度及当前位置为零，不截断或覆盖、不选择目的父目录。已经打开的 File 无法反证其最初创建方式或原路径从未经过链接；调用层负责创建权限和路径来源。失败半文件由本次所有者处理，本库不删除文件或目录。树快照不锁定源，同长度内容被外部替换的竞态不在本轮保证内。

调用者负责受限阻塞池，许可、输入/scratch/输出目录 lease 与真实 worker 一起持有到物理返回；丢弃 Future 或异步 timeout 不能抢先释放许可/删除目录。实际插件工具、签名材料和产物 ID 映射归调用层；本库不读取配置或选择程序，不处理设备连接。跨进程 D 及部署配置来源尚待后续裁定，不能把本地 `Control` 冒称宿主剩余预算传输。

## 测试与验收状态

所属测试包含独立手工 ZIP/Deflate/描述符样本，覆盖重复/缺失、路径/类型、尾部/ZIP64/分卷、CRC/长度、复制与完成前取消，树 profile/深度/ZIP 开销/源变化，XML/签名/SDK/APKS 的关键成功与具体失败类别。独立验收的 `tests/acceptance_control.rs`、`acceptance_archive.rs`、`acceptance_android.rs` 及 `acceptance_support/` 由测试角色独占；实现角色不修改这些路径。

PKG-XML-001 另追加三项严格回归：命名空间声明未定义实体、等价编码 URI 的 Android 属性读取、规范化 URI 后重复扩展属性。主代理对修复前原实现实测三项全失败（0/3、退出码 101、输入零变化，报告 `artifacts/core-xml-before-20261010-004318.txt`）；该失败保留为红基线，不记为通过。修复后复验仍由主代理执行，原 26 项测试保持。

本轮只完成源码与测试落盘、静态文本/UTF-8/差异检查，不运行 Cargo、fmt、Clippy、测试、构建或工具服务。编译及实际测试结果以主代理接入后的真实退出码为准；独立真 APK/AAB/APKS、包工具进程、旧适配等价、真实产物、合作清理和当前 release/npx 均仍须后续验收，不能由本库静态交接代替。
