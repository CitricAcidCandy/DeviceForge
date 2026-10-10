# Harmony 核心设备插件

插件通过公开设备 API3 和协议4 提供发现、应用列表、HAP 安装与应用卸载。部署旁置 `harmony-device.config.json`，仅配置 `tools.hdc` 与可选绝对 `scratch_root`；请求不能选择工具路径或 shell 字符串。

HDC 使用固定独立参数。安装前校验唯一 `/input/artifact_id`、HAP 后缀、64 MiB 上限与 SHA-256，并使用私有 `input.hap`。取消或到期沿原调用期限停止业务，在首次确定的两秒清理点内等待直接进程、文件工作线程和目录实际释放；确认后返回 `cleanup=complete`，未确认、Future 丢弃或工作线程异常保持粘性失败并保留目录。共享 HDC daemon 与真实设备状态归部署者与宿主管理，插件不执行全局 kill-server 或 disconnect。

四个短贡献为 `discover`、`packages`、`app.install`、`app.uninstall`。发现输入为 `{}`；设备贡献封套为 `{device_id,input}`，应用列表的业务输入为 `{}`，安装为 `{artifact_id}`，卸载为 `{package}`。旧格式2绑定来自 `aliases.example.json`；宿主协议4结果统一包装为 `{result,artifacts:[]}`，旧三项设备能力绑定使用 `wrapped:true` 提取业务值。

`config` 管配置资格与沿原期限的有界读取；`operations` 管严格输入和四项编排；`rules` 管纯业务资格与 HDC 文本；`discovery` 管整份发现解析；`control` 管进程租约、固定清理点和未确认标记；`session` 管私有 HAP 目录、副本与文件工作线程。新增业务不进入通用宿主路由。

源码、清单和测试落盘不代表 Cargo、服务、分发或真机通过。请按 `backend/docs/Harmony核心设备插件实施裁定.md` 分层执行验证。
