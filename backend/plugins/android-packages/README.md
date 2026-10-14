# 独立安卓包插件

插件 ID 为 `android-packages`，入口为 `deviceforge-android-packages-plugin`。每项任务通过公开协议4的 Ready/Start 获得执行上下文，独立进程执行七项普通包操作；没有设备、性能或安装贡献。首批发行目标是 Windows x64，`package.json` 只声明 `win32-x64`，发行方须放入实际构建的 `bin/deviceforge-android-packages-plugin.exe`，源码目录不包含占位二进制。

生产只依赖公开 `apk-plugin-sdk`、`deviceforge-plugin-runtime`、`deviceforge-tool-process`、`deviceforge-android-package-core` 和基础第三方库，不引用宿主 domain/application/infrastructure/server。ZIP、CRC、XML、签名报告、SDK 路径和输出树资格由公共核心处理；业务模块只做严格输入、固定 argv 和结果组合。

## 七项操作与期限

操作全名前缀为 `plugin.android-packages.`。全部输入根对象和规则/设备规格子对象拒绝未知字段，`artifact_id` 必须是36字符规范 UUID；调用者不能指定工具、目录、命令参数或期限。

| 后缀 | 输入 | 总预算毫秒 | 业务结果与固定输出 |
| --- | --- | ---: | --- |
| manifest | artifact_id；AAB 可选 module | 240000 | 清单值；无输出产物。APK 不接受 module；AAB 默认 base。 |
| signature | artifact_id | 240000 | 签名值；无输出产物。报告中私有输入路径替换为原 filename。 |
| extract_apk | artifact_id、entry | 360000 | entry；extracted.apk。精确相对成员路径，不接受遍历/反斜杠/控制符。 |
| build_apks | artifact_id、mode=default/universal | 120000 | mode、apk_count、universal_entry；built.apks。实际签名材料由部署者配置。 |
| decode | artifact_id | 480000 | files、unpacked_size；decoded.zip。 |
| scan_sdks | artifact_id、rules | 240000 | artifact_id、findings；无输出产物。输入是合格反编译 ZIP。 |
| extract_splits | artifact_id、device_spec | 120000 | device_spec、apk_entries；selected-apks.zip。纯离线匹配，不连接设备。 |

`manifest.json` 是便携七项 schema 与显式预算声明，`manifest.example.json` 是原生打包器读取的同内容标准示例。二者的 contribution.name 仅为上述短名，由宿主注册成完整外部 ID；宿主向插件的 Request.operation 同样发送短名。插件严格拒绝误发的完整外部 ID，不增加错误形状回退。打包器负责映射真实 executable，不在示例中放本机入口路径。

module 为1至80字符 ASCII 标识，显式 null 拒绝；entry 限500 UTF-8字节。rules 为1至100项，名称唯一且不含控制符，包路径和可选类名须是合法标识；class_name 缺省或 null 均表示只检测包路径。设备规格的 ABI/locale 列表唯一、非空，分别最多16/100项，每项为至多80字符 ASCII 标识；screen_density/sdk_version 均为1至10000整数。

上述预算是已裁定的部署政策，不是旧分阶段期限相加得到的等价证明。准备、复制、解析、监测、打包和发布都沿本次本地截止点，不能重启总计时。每次工具另外限120秒，实际截止点为本地总截止点与工具启动后120秒的较早者；到期与取消同时成立时优先到期。业务期限之外的有界清理不能用于继续业务或发布输出。

## 部署配置

有效 Start 后读取入口程序旁的 `android-packages.config.json`。唯一覆盖方式是清单 args 中的 `--config` 与一个不含越界的绝对文件路径；业务 JSON 不能覆盖配置。不自动下载/寻找 Android 工具，不继承宿主 `APK_*` 配置。

缺少配置文件采用空配置。不依赖外部工具的 extract_apk/scan_sdks 仍可执行；实际依赖缺失时明确失败。最小配置如下：

```json
{
  "format_version": 1,
  "tools": {},
  "signing": null,
  "scratch_root": null
}
```

实际工具配置形状如下。路径只是部署示例，不包含密码值；工具、JAR、签名材料必须由管理员实际提供，不会随在线包自动生成。

```json
{
  "format_version": 1,
  "tools": {
    "java": "java",
    "apkanalyzer": {"kind": "executable", "executable": "G:/DeviceForgeTools/apkanalyzer.exe"},
    "apksigner": {"kind": "java_jar", "jar": "G:/DeviceForgeTools/apksigner.jar"},
    "bundletool": {"kind": "java_jar", "jar": "G:/DeviceForgeTools/bundletool.jar"},
    "apktool": {"kind": "java_jar", "jar": "G:/DeviceForgeTools/apktool.jar"}
  },
  "signing": {
    "keystore": "G:/DeviceForgeSecrets/release.keystore",
    "alias": "release",
    "store_password_file": "G:/DeviceForgeSecrets/store.pass",
    "key_password_file": "G:/DeviceForgeSecrets/key.pass"
  },
  "scratch_root": "G:/DeviceForgeScratch"
}
```

配置最多64 KiB，严格版本1且每层拒绝未知字段。路径/字符串最多4096 UTF-8字节，不接受控制符；签名别名最多200字节。`scratch_root` 为可选绝对目录；缺省由插件创建临时私有目录。配置、JAR、签名文件拒绝链接/重解析点和特殊文件，实际用到相应依赖时再验证存在性。

`apkanalyzer` 只接受 executable；`apksigner` 接受 executable 或 java_jar；`bundletool`/`apktool` 只接受 java_jar。executable/java 只能是绝对程序路径或单一程序名，不是 shell 命令；PATH 上的名称仍须可直接启动，Windows `.bat` 包装不冒称可直接启动的原生程序。JAR 必须为绝对路径，Java 前缀固定为 `-Xmx256m -jar <jar>`，之后拼业务固定 argv，不接受自由 prefix。签名只读取 keystore、alias 和两个密码文件路径，不把密码、配置路径或工具 stderr 输出到业务结果。

`package.json` 的 files 不包含本机配置或签名材料。管理员部署二进制旁配置，或在可信便携清单 args 中明确配置路径；不把局域网调用者的业务字段作为配置来源。除程序本身外，打包/安装不会执行安装脚本或自动加载插件。

## 旧名称与真实产物

`aliases.example.json` 提供七项 `android.package.*` 绑定。部署者合并到已有 `APK_OPERATION_BINDINGS` 指定的 JSON，保留其它 bindings 与现有格式版本；示例自身是普通格式1。目标是同名后缀的 `plugin.android-packages.*`，input 的 wire 是字符串 `"identity"`。别名预算由注册层复制目标预算，不在配置 operation 中新增 execution。

manifest/signature/scan_sdks 使用 `value(wrapped=true)`，保持原值字段及显式 null。其它四项使用严格宿主包装的 object 投影：source_artifact_id 从 input 的 artifact_id 取得；业务字段从 result 取得；artifact 只能匹配宿主实际发布列表中的固定 filename。每个字段 optional=false，缺失或重复产物拒绝，不能取第一个冒充。build_apks 的 default 模式保留 universal_entry=null。

直接插件操作返回宿主 `{result,artifacts}` 包装，旧名称返回投影后的旧 DTO。插件只交 `ArtifactOutput` 文件声明，不能构造宿主 Artifact 实体或产物 ID。未加载目标的旧名称不可用，没有静默回退；宿主旧七项装配撤除及在线/原包发布由主代理在完整验收后处理。

## 副本、限额和资源边界

输入仅按 SDK field=artifact_id 与同 ID 唯一关联，校验普通文件、size 和 SHA256，最多64 MiB，先复制为私有稳定输入。工具不访问宿主 SDK 输入目录；完整公共核心读取期间须保持私有文件字节稳定，Archive/TreeSnapshot 不是不可变快照。

工具使用独立 argv、受限环境和每路1 MiB stdout/stderr。build_apks 监测64 MiB文件，decode/extract_splits 监测输出树；最终输出资格在工具和监测退出后才检查。归档全目录重复成员拒绝，精确提取须完成长度/CRC 校验。Reverse 含目录最多10000项，Splits最多1000项，树深度128，普通文件累计与完成 ZIP 分别最多64 MiB。监测期允许最终必要文件尚未生成，完成期 Reverse 必需文件和 Splits APK 资格由核心严格验证。

每进程一个同步工作槽；真正的阻塞闭包和子工具持有自己的目录 lease 至真实结束，不因外层 Future 丢弃就释放许可或删除目录。资源统一交 Session.finish 收口；prepare 已创建目录后的清理未确认必须返回 cleanup=failed，不能用普通错误伪装 complete。只有工具、worker、监测确认结束后才删除本次私有目录；删除失败/超时或未确认风险保留失败状态，禁止发布成功。

直接 PID 退出、后台工作结束、目录删除和协议 cleanup 是不同证据。公共租约只在插件进程内生效；强制终止插件可能留下私有目录或派生进程，不自动清扫历史目录，不以独立进程宣称系统隔离。宿主四槽准入不是多个宿主实例之间的共享容量；常驻资源、设备连接和真机不在本插件范围。

## 错误与验收状态

`extract_splits`新增可选device_features/gl_extensions/codename/device_tier及modules/instant，缺省保持旧四字段规格与argv。规则归公共核心apks模块，匹配仍归bundletool；高级输入通过完整插件贡献提交，旧别名未扩写。本批新增6项所属回归尚未运行，详见[APKS高级匹配插件实施裁定](../../docs/implementation/APKS高级匹配插件实施裁定.md)。

当前公开 Response.error 为字符串。插件内部坏包/配置/工具错误沿通用插件失败通道，不能按文案还原原宿主 Invalid/Storage/TooLarge 分类；宿主 schema 仍负责提交阶段 invalid_input，取消/到期和未确认清理由公开期限及资源通道处理。错误消息采用有界中文固定诊断，不公开工具原文或签名参数。非零退出拒绝；离线分包另保留旧失败诊断关键词检查；清单、签名、构建和反编译按各自完整核心资格检查。

本批已落七项业务、严格输入回归、公开清单/便携元数据与旧别名示例。短贡献/短 Request.operation 接缝修复已落盘，新增完整外部 ID 拒绝回归；修复前编译检查不计为当前协议修复验收。格式、Clippy、单元/独立协议、真实包/工具、HTTP/MCP、热装卸、原包/npx 和空配置验收由主代理串行执行并记录真实证据。尚未撤除宿主七项装配；Android/Harmony设备插件、常驻、iOS和真机未因本实现完成。
