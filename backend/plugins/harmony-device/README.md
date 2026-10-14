# Harmony 核心设备插件

插件通过公开设备 API3 和协议4 提供发现、连接、断开、应用列表、HAP 安装、应用卸载、完整应用详情、应用启动、应用停止、数据重置、原 JPEG 截图与原生设备输入。部署旁置 `harmony-device.config.json`，仅配置 `tools.hdc` 与可选绝对 `scratch_root`；请求不能选择工具路径或 shell 字符串。

HDC 使用固定独立参数。安装前校验唯一 `/input/artifact_id`、HAP 后缀、64 MiB 上限与 SHA-256，并使用私有 `input.hap`。取消或到期沿原调用期限停止业务，在首次确定的两秒清理点内等待直接进程、文件工作线程和目录实际释放；确认后返回 `cleanup=complete`，未确认、Future 丢弃或工作线程异常保持粘性失败并保留目录。共享 HDC daemon 与真实设备状态归部署者与宿主管理，取消或卸载不执行全局关闭、反向断开或调试模式切换。

十二个短贡献为 `discover`、`connect`、`disconnect`、`packages`、`app.install`、`app.uninstall`、`app.detail`、`app.start`、`app.stop`、`app.reset`、`screenshot`、`input`；十一能力中九项为设备能力，两项为提供者能力。发现输入为 `{}`，设备 availability 包含九项设备能力，输入资格需实际探测；设备贡献封套为 `{device_id,input}`，应用列表与截图为 `{}`，安装为 `{artifact_id}`，卸载为 `{package}`，详情、启停和重置为 `{bundle}`，启动还可提供 `ability`，输入为 `{action}`。`app.detail@1` 为只读、30000 毫秒，直接返回完整 JSON 对象并保留未知字段；省略 `ability` 的启动另按首模块推导。格式2绑定来自 `aliases.example.json`；宿主协议4结果统一包装为 `{result,artifacts}`，其他动作产物为空且绑定使用 `wrapped:true` 提取业务值，截图绑定使用 `kind:value, wrapped:false` 保留完整宿主包装。

`screenshot@1` 为设备范围写操作、30000 毫秒原总预算，严格接受 `{device_id:"HDC001",input:{}}`，拒绝输入产物并要求宿主输出授权。先探测设备 `base64 -w 0`，再运行固定 `snapshot_display -f` 与带本次所有权标识的大小、读取、清理模板。原 JPEG 按有界流落入私有目录，调用公开 `deviceforge_data_codec::jpeg::Validator` 增量检查，随后以 `create_new` 复制至授权 `screenshot.jpeg`；返回 `value:null` 与唯一同名 `ArtifactOutput`。平铺 `harmony.screenshot` 输入仅为 `{device_id}`，格式2 `device_envelope` 绑定使用 `result:{kind:"value",wrapped:false}`。未知远端进程、缺回执或未关闭工作线程使清理失败，不以删除目录或直接 HDC 退出表示完成。详见 `src/screenshot/README.md`。

`input@1` 为设备范围写操作、30000毫秒原总预算，只接受官方固定 `uitest 5.0.1.1` 档案的点击、按速度滑动、原生按键和带定位的UTF-8文本；与Android同名能力的字段不等价。每条命令要求唯一完整远端完成帧，动作还须精确 `No Error`；缺帧、取消或丢弃保留未确认。发现当前单路执行，八秒窗口后不启动新资格探测，余项明确不可用，其他八能力保留；真实HDC和真机输入效果尚未验收。详见 `src/input/README.md`。

`connect@1`、`disconnect@1` 均为提供者范围写操作和 30000 毫秒原总预算，严格接受 `{device_id:null,input:{address}}`，地址不要求预先发现或在线。地址为规范 IPv4 或小写字面 `localhost` 与显式十进制端口 1–65535，最多 21 字节，字面值原样交给 HDC。固定 argv 为 `[tconn,address]` 或 `[tconn,address,-remove]`；连接只认 `Connect OK` 或 `[Info]Target is connected, repeat operation`，断开只认无失败诊断的静默完成，返回 `{output}`。任务不自动重发现或发布在线状态，调用方完成后显式刷新目录；客户端完成不表示实际断开、回滚或常驻会话完成。新增平铺示例绑定 `harmony.connect`、`harmony.disconnect` 只接受 `{address}`。

`config` 管配置资格与沿原期限的有界读取；`operations` 管严格设备/提供者封套与动作委派；`applications` 管完整详情、启停、重置与首模块推导；`network` 管连接地址、响应和固定命令；`rules` 管纯业务资格与 HDC 文本；`discovery` 管整份发现解析；`control` 管进程和阻塞工作租约、固定清理点与未确认标记；`session` 管私有 HAP 目录、副本与文件工作；`screenshot` 管远端独占截图、帧回执、流式解码及授权交付。新增业务不进入通用宿主路由。

源码、清单和测试落盘不代表 Cargo、服务、分发或真机通过。请按 `backend/docs/implementation/Harmony核心设备插件实施裁定.md`、`backend/docs/implementation/Harmony应用启停与重置插件实施裁定.md`、`backend/docs/implementation/Harmony应用详情插件实施裁定.md`、`backend/docs/implementation/Harmony连接与断开插件实施裁定.md` 与 `backend/docs/implementation/Harmony截图插件实施裁定.md` 分层执行验证。
