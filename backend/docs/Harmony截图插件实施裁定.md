# Harmony 截图插件实施裁定草案

本文件待交付总监审核；生产实现、清单和服务输入仍冻结。推荐使用原 `snapshot_display` 同步截图、固定前台完成回执、经资格探测确认的 `base64 -w 0` 有界 ASCII 回传。采用 architecture-first、Hybrid：先验证共享纯 JPEG 格式模块及通用产物接缝，再实施截图流程与协议。本文是实施方案，不是工具、真机、取消清理或视觉验收通过记录。

## 1. 目标、证据与两条路线

迁移完整的 Harmony 截图动作：在目标设备实际执行截图，接收 JPEG，经过有界资格检查，以既有输出授权发布宿主产物。不能把下载已有图片算作截图迁移，不把 JPEG 更名为 PNG，也不增加无需求的转码。

已有官方源码证据固定于以下版本，实际设备是否采用同一构建仍须独立验证：

| 来源 | 直接证据与边界 |
| --- | --- |
| [window_window_manager/snapshot_display.cpp](https://github.com/openharmony/window_window_manager/blob/7c536e51df90e109628ab251679ddd4312b09990/snapshot/src/snapshot_display.cpp#L72)，`OpenHarmony-5.0-Release`，提交 `7c536e51df90e109628ab251679ddd4312b09990` | 第 72 行同步调用 `WriteToJpegWithPixelMap`；第 80～82 行成功诊断在调用返回后发出，第 83 行才 `_exit(0)`。成功行说明编码调用完成，单独读取该行仍不能证明进程已经退出；固定前台模板须在命令返回后发出完成回执。第 50～53 行要求开发者模式。 |
| [snapshot_utils.cpp](https://github.com/openharmony/window_window_manager/blob/7c536e51df90e109628ab251679ddd4312b09990/snapshot/src/snapshot_utils.cpp#L268) | 输出父目录须能解析且位于 `/data/local/tmp`，后缀为 `.jpeg`。普通分支在 `fclose` 成功后返回；DMA 分支使用 `image/jpeg` 并在 `FinalizePacking` 后返回。不提供直接 stdout JPEG；文件打开会覆盖，因此先建立调用独占目录。 |
| [developtools_hdc/daemon_unity.cpp](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/daemon/daemon_unity.cpp#L49)，提交 `4ce65f76fc57e64318b730c52eae6893f580f38d` | Shell 任务完成不把远端退出状态变为可信客户端退出码；`AsyncCmd` 释放主要终止远端 Shell PID，不能据此确认截图子进程已退出。Windows 客户端普通 Shell 输出使用字符串打印，不能承载含 NUL 的 JPEG 原字节。 |
| [developtools_hdc/transfer.cpp](https://github.com/openharmony/developtools_hdc/blob/4ce65f76fc57e64318b730c52eae6893f580f38d/src/common/transfer.cpp#L123) | `file recv` 在逐写前没有调用方指定的 64 MiB 接收限额；第 268 行是在写回调后按累计值判断完成。远端预查大小、下载后检查或轮询文件大小都不能替代接收器逐写硬限额。 |
| [third_party_toybox/base64.c](https://github.com/openharmony/third_party_toybox/blob/OpenHarmony-5.0-Release/toys/other/base64.c) | 官方分支提供 `base64 -w 0`。源码和默认配置不保证每台实际设备启用该命令；本方案把命令及行为列为明确的平台前置资格，以固定探测结果决定是否执行截图。 |

两条路线均保持真实 `snapshot_display`，均不扩展公共 SDK、设备 API 或通用宿主路由：

| 路线 | 完整实现条件 | 裁定建议 |
| --- | --- | --- |
| 固定截图完成回执＋Base64 有界回传 | 目标设备须通过固定 `base64 -w 0` 资格探测；插件复用公共 `spawn_stream_with_lease`，同时保留受限 stderr、逐块有界写入 stdout，再流式严格解码。明确保留未知远端状态的 `cleanup_failed`。 | 推荐首批实施。依赖与失败边界可在插件内明确表达，不部署新的守护系统，不自动安装设备工具。 |
| 固定截图完成回执＋`file recv` | 部署侧先提供并验证受限 HDC 接收器：在接收元数据时拒绝超过 64 MiB 的声明；每次提交文件写入前检查偏移、块长、累计字节及溢出，确保文件终点与总接收量均不超过限额；超限终止并关闭接收句柄。固定部署工具必须提供明确受限模式与资格回执，插件不能把现有普通 `file recv` 当作已有该模式。 | 本批不选。普通 HDC 缺少上述限额证据；增加本地大小轮询仍不完整。后续若交付受限接收器，再独立裁定工具契约和分发，不先虚构可用 argv。 |

推荐路线需要的远端 Shell、`mkdir`、`printf`、`cat`、`wc`、`rm`、`rmdir` 和 `base64` 属于可信平台工具前置条件。资格失败准确返回失败，不自动安装、不回退到无硬限额的普通接收，也不改为下载旧文件。

## 2. 公开操作及产物合同

- 新增设备能力 `screenshot@1`，`device/write`，业务预算 `30000ms`，严格输入 `{ "device_id": "目标设备标识", "input": {} }`；沿用现有目标标识纯规则及宿主设备归属校验，不接收屏幕编号、路径、脚本或编码参数。
- 不接受输入产物。必须取得宿主输出授权；仅在授权根内以 `create_new` 创建输出，不能覆盖已有文件，也不能接收浏览器指定的本地路径。
- 业务结果 `value:null`；唯一 `ArtifactOutput{filename:"screenshot.jpeg"}`。产物实体、ID、路径、大小、摘要和时间由宿主生成；协议 4 返回 `{result:null,artifacts:[宿主产物元数据]}`。
- 原字节媒体类型为 `image/jpeg`。现宿主扩展名映射与内容资格尚不接受 JPEG，因此必须由主代理补通用 `jpg`/`jpeg` 格式接缝并独立验证上传、发布及 HTTP/MCP 下载。不能仅修改插件就宣称已可发布；不返回 Base64、内联图片、远端路径、本地路径或插件自造产物 ID。
- 新批预计十一贡献、十定义能力：八个设备能力和两个提供者能力；发现设备的 `availability` 为八个设备能力。贡献清单增加既有 `artifacts.outputs=true`，其他操作继续返回空输出列表；必须回归其在合法输出授权下的行为。
- 本批固定新增旧平铺 `harmony.screenshot` 别名，采用既有格式 2 的 `device_envelope` 输入及 `{"kind":"value","wrapped":false}` 结果投影，原样保留宿主 `{result:null,artifacts:[宿主产物元数据]}`。`wrapped:true` 只提取空业务值，不能用于本绑定。既有 `kind:artifact` 仅返回选中产物的元数据，不满足本批保留完整数组的目标；不改变这一公共投影语义或其他别名。2026-10-12 实施审查纠正此前投影选择，原合同冻结版保存在根 `artifacts/harmony-screenshot-contract-812C67-20261012.md`。添加绑定不等于旧宿主兼容已经验收，须服务验证三入口实际产物包装。前端现有 `devices.invoke`、Job 查询及按产物 ID 下载足够，不要求新增 DTO、SDK 或手改生成文件。

前端消费边界见[前端 Harmony 截图产物消费边界](../../frontend/docs/Harmony截图产物消费边界.md)。两份文件中的截图合同均须经本批裁定后才计为批准范围。

## 3. 固定 argv、模板与传参安全

本地始终由既有工具进程库直接启动部署者配置的 HDC，不启动本地 PowerShell、`cmd` 或 Shell。每次 argv 固定为 `["-t", device_id, "shell", static_script]`。HDC 的远端 Shell 是本操作明确采用的固定模板例外；不是开放用户 Shell 接口。

`device_id` 只进入独立 `-t` 参数，不拼入脚本。插件每次生成 32 位小写十六进制随机所有权标识 `token`，严格根为 `/data/local/tmp/deviceforge-screenshot-<token>`，文件只有 `owner` 与 `screenshot.jpeg`。模板仅替换该受限标识及已验证的十进制大小；用户不能提供目录、文件名、命令或任意插值。路径均单引号包裹，所有权标识不包含引号、空白或 Shell 元字符。

以下是静态模板，`<token>` 为上述唯一替换点；它们是待实施合同，不是已执行命令。HDC 可能合并远端标准输出和错误，因此回执统一从有界返回文本解析，不假定远端 stderr 具有独立通道。

### 3.1 平台资格探测

```sh
printf 'DeviceForge' | base64 -w 0
probe_status=$?
printf '\nDF_PROBE_DONE:<token>:%s\n' "$probe_status"
```

仅当返回精确的 `RGV2aWNlRm9yZ2U=` 和本次 `DF_PROBE_DONE:<token>:0`，且无失败诊断时，确认无换行编码资格。HDC 零退出仍是附加条件。不同标识、重复回执、缺回执、未知非空内容和非零状态都失败；缺回执导致远端探测进程退出未确认，保留清理未确认状态。探测不创建远端文件。

### 3.2 独占目录与实际截图

```sh
umask 077
if ! mkdir '/data/local/tmp/deviceforge-screenshot-<token>'; then
  printf '\nDF_DIR_REJECTED:<token>\n'
  exit 1
fi
if ! printf '<token>\n' > '/data/local/tmp/deviceforge-screenshot-<token>/owner'; then
  printf '\nDF_OWNER_FAILED:<token>\n'
  exit 1
fi
printf 'DF_OWNER_READY:<token>\n'
snapshot_display -f '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg'
capture_status=$?
printf '\nDF_CAPTURED:<token>:%s\n' "$capture_status"
```

`mkdir` 不使用 `-p`，撞目录立即拒绝且不删除已有目录。目录按 `umask 077` 创建；在派发前把预计远端根及阶段登记到租约。`DF_OWNER_READY` 确认所有权文件建立；`DF_CAPTURED` 只能在前台原截图命令返回后发出，是本批远端 writer 已退出的正向确认。成功还须同时验证本次固定路径的完整官方成功诊断及非零尺寸，不能仅凭 `DF_CAPTURED:0` 或本地 HDC 零退出。

非零 `DF_CAPTURED` 说明前台命令已返回，可进入所有权清理，但不能发布图片。`DF_OWNER_FAILED` 表示已创建目录而所有权文件未完成，本批保守返回 `cleanup_failed`。没有本次完整 `DF_CAPTURED` 时，不能推定截图子进程已退出，不能用一次 `rm` 把状态改成已确认。

### 3.3 已完成图片的大小资格

```sh
if [ "$(cat '/data/local/tmp/deviceforge-screenshot-<token>/owner')" != '<token>' ]; then
  printf '\nDF_SIZE_REJECTED:<token>\n'
  exit 1
fi
if [ ! -f '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg' ] || [ -L '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg' ]; then
  printf '\nDF_SIZE_REJECTED:<token>\n'
  exit 1
fi
image_size=$(wc -c < '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg')
size_status=$?
printf '\nDF_IMAGE_SIZE:<token>:%s:%s\n' "$size_status" "$image_size"
```

只在已确认 `DF_CAPTURED` 后执行。插件严格解析本次标识、状态及十进制大小；允许 `wc` 数值两侧 ASCII 空白，禁止额外行、符号、溢出及未知诊断，要求 `0 < size <= 67,108,864`。图片超过限额时不接收，执行已知无 writer 的远端清理。本方案对本地接收和发布施加硬限额；远端真实截图文件在检查前已由系统工具生成，不宣称其临时写入本身有 64 MiB 配额。

### 3.4 有界 ASCII 回传

```sh
if [ "$(cat '/data/local/tmp/deviceforge-screenshot-<token>/owner')" != '<token>' ]; then
  printf '\nDF_READ_REJECTED:<token>\n'
  exit 1
fi
base64 -w 0 '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg'
read_status=$?
printf '\nDF_READ_DONE:<token>:%s\n' "$read_status"
```

只读取当前调用已经完成的文件，不启动新的 writer。编码器在前台运行，末尾完整 `DF_READ_DONE:<token>:0` 确认该 reader 已退出；缺失、重复、错标识、失败诊断或非零状态不能发布。回执是接收帧尾部，不能交给 Base64 解码器当图片内容。实际设备输出行为须由真机验证，不能根据源码声明所有 HDC 构建完全一致。

### 3.5 已知无 writer/reader 的远端清理

```sh
if [ "$(cat '/data/local/tmp/deviceforge-screenshot-<token>/owner')" != '<token>' ]; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
if ! rm -f '/data/local/tmp/deviceforge-screenshot-<token>/screenshot.jpeg'; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
if ! rm '/data/local/tmp/deviceforge-screenshot-<token>/owner' || ! rmdir '/data/local/tmp/deviceforge-screenshot-<token>'; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
if [ -e '/data/local/tmp/deviceforge-screenshot-<token>' ] || [ -L '/data/local/tmp/deviceforge-screenshot-<token>' ]; then
  printf '\nDF_CLEAR_REJECTED:<token>\n'
  exit 1
fi
printf 'DF_CLEARED:<token>\n'
```

只有已收到本次 `DF_CAPTURED`，且接收未派发或已收到本次 `DF_READ_DONE`，才允许把此回执作为完整远端资源确认。清理只删除已知两个文件，目录中出现未知文件时 `rmdir` 失败；不使用全局清扫、模糊 PID、`pkill` 或关闭共享 HDC daemon。成功要求完整标识匹配、零 HDC 退出、无失败诊断、全部删除动作成功及路径不存在检查，缺一个条件都保留 `cleanup_failed`。

不能把 `DF_CLEARED` 从其他调用、重试或不同所有权标识借用。派发截图后若没有 `DF_CAPTURED`，本批不新增远端 PID 管理或等待守护程序，也不尝试以删除目录掩盖可能晚到的 writer；可以保留本地诊断和未确认资源状态，但不得返回 `CleanupOutcome::Complete`。没有完成回执时即使当前目录看似不存在，也可能是尚未执行的创建动作，因此不能据此判为清理成功。

## 4. 接收、本地 I/O 与发布

| 对象 | 上限及实现要求 |
| --- | --- |
| 解码后的 JPEG | `67,108,864` 字节，即 64 MiB；逐块写入前检查累计长度与整数溢出。 |
| Base64 正文 | `4 × ceil(67,108,864 / 3) = 89,478,488` 字节；不能把 64 MiB 原字节限额直接作为编码限额。 |
| 编码帧接收文件 | 预留最多 128 字节的固定帧尾及末尾换行空间，stdout 硬限 `89,478,616` 字节；公共流接口在向通道提交块前限额，插件每次文件写入前再次检查累计量，不在完整接收后才检查。严格解析仍拒绝多余内容，预留不表示允许任意诊断进入图片。 |
| 探测、截图、大小及清理文本 | stdout 和本地 stderr 各不超过 1 MiB；失败诊断优先。远端两流可能合并，不能只检查本地 stderr。 |
| 本地工作 | 复用租约单槽工作池，分块读取及解码，建议固定 64 KiB 输入缓冲；不将整份编码或 JPEG 读入内存。所有异步和阻塞工作都携带原截止点及取消检查。 |

接收写入私有目录内 `.b64`，使用现有公共 `spawn_stream_with_lease`。现有 `capture_to_file_with_lease` 成功时仅返回 `()`，不能把成功退出的 stderr 提交给插件业务诊断，因此本批不使用它直接接收截图，也不新增公共文件捕获 API。

具体接法为：`ToolCommand` 使用 Restricted 环境；`StreamOptions.execution` 保留原绝对期限，stdout 上限设为 `89,478,616`、stderr 为 `1,048,576`；分片 `8192` 字节、通道容量 `8`、不发送 stdin。独立文件协调任务持续调用 `StreamingProcess::recv()`，按 `OutputStream` 分流：stdout 检查累计长度后送入唯一容量为 `8` 的写文件通道，stderr 保存在有界缓冲并提交失败诊断规则。通道排队、写入和等待都检查原期限与取消。必须先完整消费两流直到通道关闭再调用 `wait()` 获取 `StreamExit`；`wait()` 会排空并丢弃尚未消费的块，不能提前调用它而漏掉成功退出的 stderr。

单个受限 `spawn_blocking` writer 独占 `std::fs::File`，持工作槽、租约及关闭失败守卫；只消费上述写文件通道，在每次真实写入前再核累计上限，并检查取消与原截止点。结束时真实 `flush` 并关闭文件，协调任务须等该 worker 的 JoinHandle 实际终态。禁止用丢弃 Tokio File 或文件写入 Future 代替操作系统 I/O 结束；阻塞写入超过清理点时 worker 仍持租约及文件，返回未确认，不假装强行终止线程。

文件协调任务也持有租约，公共后台监督持有另一份租约到直接进程退出确认。文件写入失败、输出超限或取消时撤销流输入和业务，继续完成直接进程等待与句柄收尾；stdout 不再送入失败文件，受限诊断仍按实际已收到内容处理。只有两流结束、真实进程等待、writer 的 flush、关闭和实际工作结束全部确认后，文件任务才能释放租约。等待者丢弃 Future 时取消标识被触发、`unresolved` 保持粘性，独立任务不被 abort；首次固定两秒内不能确认就报告 `cleanup_failed`，后台仍持租约，不能借其晚到退出续预算或改写成功。

正常接收要求 `StreamExit.status.success()`、两路计数与插件计数一致、stderr 无失败诊断、stdout 的唯一完整 `DF_READ_DONE:<token>:0` 全部成立。成功 HDC 退出但 stderr 包含失败诊断同样失败。收到有界帧后从文件尾读取不超过 128 字节，先验证完成回执，再把正文范围交给严格流式 Base64 解码。

正文只接受规范字母表、正确 padding 和规范尾部位；允许编码器正文末尾至多一个 LF 或 CRLF，正文内部不允许空白、换行或诊断。截断、额外回执、无效字符、尺寸不一致、超过 64 MiB 和整数溢出全部失败。解码累计字节须精确等于此前 `DF_IMAGE_SIZE`。本批不新增 `sha256sum` 平台依赖，不宣称做了远端独立摘要比对；宿主仍按实际发布原字节生成和核验本地产物摘要。

JPEG 资格检查统一调用主代理新增的公开 `deviceforge_data_codec::jpeg::Validator`，插件 `jpeg.rs` 只作原截止点、取消及错误映射的薄适配，不能复制另一套解析。验证器为不操作 I/O 的纯增量模块：`new()` 或 `Default` 创建，`push(&[u8]) -> jpeg::Result<()>` 分块推进，`finish(self) -> jpeg::Result<Info>` 确认完整结束，`Info` 含 `width`、`height`；模块内固定 64 MiB 与 65,536 段上限，`jpeg::Error` 区分 `Limit`、`Invalid`、`Unsupported`。

共享验证器检查 SOI、EOI、段边界及长度、SOF0/SOF2 非零宽高、SOS 与扫描区标记转义，拒绝不完整或不支持的结构；不执行完整熵解码，不宣称结构通过就代表像素可解码、视觉正确或真机截图成功。通用宿主在既有受限文件 worker 内分块调用同一验证器；不增加 Harmony 设备分支，不修改现有 JSON/MessagePack 错误类型或其 16 MiB 上限。

本地解码 JPEG 与授权输出均不得通过符号链接或已有文件覆盖目标。授权根检查、私有目录建立、复制、元数据校验和删除都放入受限工作，并等待实际任务结束；遵守已有 Android 输出授权的边界，但实现归 Harmony 插件，不依赖具体 Android 插件模块。

发布顺序固定为：接收并确认 reader → 严格解码和 JPEG 资格 → 登记预期授权输出并派发创建 worker → 授权输出 `create_new`、分块复制、`flush` 及关闭 → 远端删除并确认不存在 → 本地私有目录删除并确认不存在 → 原上下文最终检查 → 向既有运行库交付唯一输出声明。

登记必须发生在首次 `create_new` 或派发输出 writer 之前：租约先记录授权根、预期 `screenshot.jpeg` 位置及“尚未取得本次创建所有权”，然后才启动持租约和创建守卫的受限 worker。worker 在 `create_new` 成功取得句柄时立即由同一守卫记录“本次实际创建”，在任何取消检查、写入或跨任务返回前完成该记录并继续持租约。登记失败不能假称未创建，守卫及租约保留未确认状态；`EEXIST` 没有本次创建所有权，禁止删除既存文件。预计位置记录本身不构成删除授权。

失败、取消或等待 Future 丢弃时，必须先等实际 writer 的 flush、关闭和 worker 终态，再删除本次实际创建且尚未移交的输出，并在同一清理点内确认不存在。尚持句柄、创建所有权未确认或超过固定点均为未确认清理，不通过删除动作猜测文件 I/O 已结束。

输出移交节点不是 `create_new`、flush 或文件存在：只有所有资源确认、原上下文最终检查成功后，`finish_output` 同步形成成功 `Execution` 并把唯一 `ArtifactOutput` 交给既有插件运行库响应流程，插件才把该输出从“本次创建、待交付”转为“交付运行库”。后续产物导入、Job 取消优先级及授权目录回收由既有宿主流程接管；宿主实际导入后才存在可供消费者使用的产物实体。失败、取消和未确认分支不声明已写但未交付的文件；不新增宿主确认消息或 SDK 字段，交付后的文件不再由插件失败路径删除。

单次任务可能同时保留编码帧、私有 JPEG 和授权输出，文件内容总上限约为 `223,696,344` 字节，不含文件系统元数据；必须及时清理每个阶段的私有文件。这是单次任务本地数据上限，不是整个服务器或设备文件系统配额。

## 5. 同一业务截止点及首次固定清理点

资格探测、目录建立、截图、大小查询、回传、解码、资格检查、输出复制、正常远端和本地清理共用协议 4 原 `30000ms` 绝对截止点。Ready/Start 等待已消耗的时间照常扣减；不能每条 HDC 命令或每个 I/O 阶段重新获得 30 秒。正常路径的远端删除也是业务预算内工作。

失败、取消、超时或丢弃等待首次进入清理时，调用既有 `Lease::cleanup_point()`：第一次固定为当前单调时钟 `now + 2s`，之后每次取得同一 `Instant`。终止及排空直接 HDC、确认文件句柄、固定远端清理和本地删除全部共享这同一个两秒点。没有剩余时间就返回 `cleanup_failed`，不能分别给每个资源、每条清理命令或每次重试续两秒。

取消后允许插件私有清理入口使用新的清理取消标识运行固定删除模板，但它只能取得已固定的清理截止点；不得复用已取消的业务标识立即跳过清理，也不得借新标识重新开始截图、接收或普通业务。任何未确认状态保持粘性，不能通过重置 `unresolved` 或释放本地客户端句柄改写成已确认。

| 失败或取消阶段 | 已知远端状态 | 本批允许的结果与清理 |
| --- | --- | --- |
| 尚未派发远端命令 | 没有本次远端资源 | 清理已知本地资源；真实工作结束且文件不存在后可确认。 |
| 探测完整回执但资格失败 | 固定探测前台工具已返回，未创建目录 | 返回准确资格失败；确认本地工具与工作全部结束。 |
| 已派发探测但缺完成回执 | 远端探测进程退出未确认 | 本地清理继续，最终 `cleanup_failed`，不假称全量确认。 |
| 精确 `DF_DIR_REJECTED` | 独占 `mkdir` 未成功，没有本次目录及截图 writer | 不删除碰撞目录；准确失败，确认直接工具及本地资源。 |
| 建目录、写 owner 或截图进行中；缺 `DF_CAPTURED` | 可能有晚到创建或活动 writer；owner 失败也未完成所有权记录 | 不以 `rm` 或杀客户端表示成功；清理已知本地资源并保留 `cleanup_failed`。 |
| 有完整 `DF_CAPTURED`，接收尚未派发 | snapshot writer 已返回，可能有 JPEG 或失败残片 | 固定清理模板确认所有权与目录不存在；确认后可以报告原业务失败或取消。 |
| 大小查询完整回执但失败或超限 | writer 及大小查询前台工具均已返回，没有编码 reader | 已知资源清理使用首次固定两秒点；回执及本地清理都成立才确认。 |
| 已派发大小查询但缺完成回执 | writer 已确认退出，`cat`/`wc` 前台工具退出未确认 | 本地收尾继续；远端子进程未确认仍使结果为 `cleanup_failed`，不能只确认没有截图 writer。 |
| 接收进行中或超编码限额，缺 `DF_READ_DONE` | snapshot 已退出，远端 reader 退出未确认 | 终止及排空本地 HDC，关闭本地文件；远端未知状态仍使结果为 `cleanup_failed`。 |
| 完整 `DF_READ_DONE` 后解码、资格或复制失败 | writer 和 reader 均已返回 | 同一两秒点内确认远端目录、本地私有目录和失败输出全部删除；任一未确认即 `cleanup_failed`。 |
| 正常清理失败、回执丢失、目录仍在或权限失败 | 无法确认资源全部释放 | 不发布成功；保留 `cleanup_failed`，不得使用本地文件已删除替代远端确认。 |
| 最终检查前取消、超时或调用 Future 丢弃 | 可能仍有待发布输出或独立工作持租约 | 合作取消并等待实际清理；不能由晚到成功覆盖取消或未确认终态。 |
| 插件卸载 | 当前代新操作已撤销 | 宿主既有取消与清理合同继续执行；未知 writer/reader 或剩余文件导致 `cleanup_failed` 与 `draining`，同 ID 重载保持禁止。 |

已观察完成回执不能清除此前因 Future 丢弃或资源未知而登记的粘性失败。本批清理能力允许准确报告未确认，不保证每次设备断连或取消都能在两秒内自动释放远端资源；这是可审核边界，不以新增守护系统掩盖它。

本文 `cleanup_failed` 表示既有合作清理失败或未确认错误语义，不是新增 `Job.status`。三层分别保留：Job 按当前宿主取消优先级进入既有成功、失败或取消终态并保存历史；插件执行返回既有 `CleanupOutcome::Complete` 或 `Failed`；来源卸载在未确认时保留既有 `draining`。不新增状态、响应字段或公共 SDK。清理晚到不得把失败/取消历史改写为成功，也不能解除已经登记的未确认标记；消费者只读 Job 实际终态及已发布产物。

## 6. 插件内接缝与下一生产独占写集

公共 SDK、协议 4、设备 API、DTO、前端公开接口及通用设备路由无需扩展。清单输出授权是既有合同的加法；Harmony 插件新增私有 `Control` 接缝与资源跟踪。同时，主代理必须新增 `data-codec` 的共享纯 JPEG 格式职责并补通用宿主产物映射、资格验证与测试，不能再写成宿主无需变更。不新建工具执行器或远端守护系统。

| 插件内变更 | 责任与不变边界 |
| --- | --- |
| `Control::capture_file` 候选私有方法 | 按第 4 节复用 `spawn_stream_with_lease`、`recv`、`wait`，双流均保留到业务诊断；返回已确认的计数与受限 stderr，而非仅 `()`。沿用 Restricted 环境、原截止点、单槽和租约；单有界写文件通道及单受限 blocking writer 持租约到真实 flush、关闭与实际终态，不复制通用进程管理。 |
| `Control::capture_cleanup` 候选私有方法 | 仅执行本模块固定清理 argv，允许业务取消或期限到达后使用新的清理标识；截止点必须来自既有首次固定 `cleanup_point()`。复用公共执行库，禁止变成任意业务超时后的备用执行入口。 |
| `Control::finish_output` 候选私有方法 | 接受既有公共 `Output`，保留当前 JSON 操作入口；检查所有租约、本地和远端状态，只有全部确认才返回含产物的 `Execution`。不改变公共运行库或其他操作结果。 |
| `Lease` 私有状态 | 登记所有权标识、远端预计根、派发阶段、owner/capture/read/clear 回执、本地目录、文件任务及授权输出的预期/本次创建/交付状态；未知状态保留粘性失败。远端预计根及输出预计位置都必须在派发前登记，不能只记录收到回执或 create_new 后的资源。 |

正常工具流程仍沿用原 `Control::capture` 的双流结果。清理流程在剩余两秒不足时不得启动新工作；公共执行库内部监督若尚未退出，仍持有租约，外层固定点到达就保留未确认，不把后台继续收尾表示为延长本批确认期限。

生产获批准后的后端开发独占写集限于 `backend/plugins/harmony-device/`；公共 JPEG 与通用产物接缝由主代理独占，具体如下：

| 文件 | 所有者与职责 |
| --- | --- |
| `src/screenshot.rs` | 后端开发；薄阶段编排，不拼混纯规则、远端模板、解码与文件发布。 |
| `src/screenshot/models.rs`、`rules.rs`、`scripts.rs` | 后端开发；阶段/回执模型、严格纯解析与常量静态模板，生成值受限插值。 |
| `src/screenshot/receive.rs`、`jpeg.rs`、`publish.rs` | 后端开发；有界接收与严格解码、公共 JPEG Validator 薄适配、授权输出及私有文件实际清理。不得在 jpeg.rs 复制解析器。 |
| `src/screenshot/tests.rs`、`src/screenshot/README.md` | 后端开发；模块行为测试和中文职责说明，不接管独立协议驱动。 |
| `src/control.rs`、`src/control/resources.rs`，按需新增 `src/control/file.rs`、`cleanup.rs` | 后端开发；上述私有接缝、持租约文件任务、首次固定清理点及实际工作结束确认。 |
| `src/operations.rs`、`src/operations/models.rs`、`src/lib.rs` | 后端开发；仅能力声明、严格输入及分发薄接线，不改应用详情或连接模块。 |
| 插件双 manifest、`aliases.example.json`、根 `README.md` | 后端开发；十一贡献/十能力、JPEG 输出授权与明确平台资格。 |
| 插件 `tests/`、真实宿主/假 HDC 服务驱动 | 测试助理独占；根据冻结生产输入实现独立协议及服务验证，后端开发不写其文件。 |
| `backend/crates/data-codec/src/jpeg.rs`、`src/lib.rs`、中文 `README.md` | 主代理独占；新增上述纯增量 Validator、Info 与独立 jpeg::Error，lib.rs 仅增加 pub mod jpeg；不改原 JSON/MessagePack 错误与限额。 |
| `backend/crates/infrastructure/src/artifacts/mod.rs`、`validation.rs`、`tests/artifacts_jpeg.rs` | 主代理独占；增加 jpg/jpeg→image/jpeg，已有受限文件 worker 分块调用公共 Validator，验证通用上传、内容资格与原字节下载，不增加平台分支。 |
| 生成文件、根服务/构建调度、分发及根记录 | 主代理独占；没有 DTO 变更时不为了本批手改生成文件。根 `todo.md` 和交接记录由主代理集成更新。 |

本草案的当前独占写集只有 `backend/docs/Harmony截图插件实施裁定.md`。生产文件继续冻结；上述表格是下一批待批准所有权，不表示已经修改。网络、应用详情、公共 SDK、其他插件和旧 Electron 工程不在后端开发写集；主代理的通用 JPEG 接缝不由后端开发重复接手。

## 7. 验证清单与未完成边界

Hybrid 顺序固定：主代理先证明纯 JPEG 增量结构、分块边界、64 MiB/65,536 段及错误分类，再证明通用 JPEG 产物上传、内容拒绝、媒体类型和原字节下载；公共接口冻结且上述接缝验证后，后端开发实施实际截图流程，测试助理实施独立协议及服务验证。阶段证据分开记录，不用公共格式测试替代实际 snapshot、传输与清理。

后续库测试必须覆盖模板只接受系统标识、回执错标识/重复/缺失、失败诊断优先、成功退出但 stderr 失败、流接口未消费块不得被 `wait` 丢弃、编码边界与 padding、正文混入日志、64 MiB 精确边界与超限、大小不一致、公共 JPEG 验证器错误映射，以及授权输出派发前登记、创建到登记期间取消/丢弃、EEXIST 不删既存、真实关闭后删除及运行库交付节点。

独立协议与真实宿主假 HDC 验证须分别覆盖各阶段超时/取消/Future 丢弃、晚到目录与 writer、缺 reader 回执、清理回执丢失、删除失败、文件仍在、无剩余清理时间、卸载 `draining`、十一贡献/十能力、其他操作空产物、格式 2 平铺截图保留 artifacts、已写输出未交付不得声明、Job 历史与清理 outcome 分离、宿主 JPEG 元数据和 HTTP/MCP 原字节下载。假 HDC 必须真实派生可留存的模拟 writer/reader，核验生产不得把直接客户端退出或一次删除当作完成；模拟工具证据仍不等于真实设备。

本批当前仅完成固定官方源码取证与方案草拟，没有运行截图生产、构建、测试、服务、分发、真实 HDC、真机、浏览器或图片审核。真实平台工具资格、开发者模式、实际截图诊断、设备断连后的资源行为及 JPEG 解码/视觉须另行验收。既有连接批次通过数量不转计本次截图能力。
