# 安卓离散设备插件

独立 `android-device` 通过公开设备 API3、协议4 和工具执行库接入宿主；生产不依赖宿主四层模块。首批部署目标为 Windows x64，源码及元数据落盘不代表编译、真实ADB或真机验收已通过。

## 名字与部署

八贡献为 `discover`、`connect`、`disconnect`、`packages`、`app.start`、`app.stop`、`app.uninstall`、`input`。贡献和真实 Request.operation 仅接受短名；对外完整ID由宿主映射为 `plugin.android-device.<短名>`，误发完整名被拒绝。发现不算能力，其余七项能力版本均为1。两个清单逐字节一致；便携包只包含清单、原生二进制和说明，配置不随公共包分发。

二进制旁部署文件为 `android-device.config.json`；唯一覆盖为部署参数 `--config <绝对路径>`。配置严格格式1且最多65536字节：

```json
{"format_version":1,"tools":{"adb":"adb"}}
```

tools或adb可省略；缺省旁置文件不存在等于空工具配置，显式文件不存在失败。没有ADB配置的执行返回确定依赖错误。ADB只接受合法绝对可执行路径或单一程序名；不接受自由参数或业务请求选择路径。受限环境仅继承PATH、SystemRoot、TEMP、TMP、HOME、USERPROFILE，不继承宿主令牌、APK_ADB或ADB server相关覆盖变量。

## 设备与结果

发现仅接收 `{}`，以 `devices -l` 返回公开 PluginDevice 数组，不自造宿主包装。最多128条；serial原文最多200个UTF-8字节、非全空白、无Unicode控制字符且不以连字符开头。动作保留原文，不收紧为ASCII标识。raw_state最多100字节，model可选且最多200字节；任一坏条目或重复标识使整次失败。

`device` 为online；`offline`、`unauthorized`分别归一；recovery、sideload、bootloader及其它合法原文归unknown并保留raw_state。只有online开放五项device能力；connect/disconnect是provider write，不放进每台设备的availability。

动作严格封套为 `{device_id,input}`：provider必须显式null，device必须合法serial，每层未知字段拒绝。地址为ASCII host:port，支持IPv4/DNS或方括号IPv6、端口1至65535。start/stop/uninstall包名必须是最多200字节的点分ASCII标识；start/stop比旧宽identifier收紧，这是兼容变化。

非input动作返回trim后的 `{output}`。packages只识别明确ADB诊断行，`package:com.failed.example`等合法包名不因子串被拒。connect必须明确connected to/already connected to；uninstall必须含独立Success行且无失败诊断。input保留可打印ASCII、单引号、空格到%s、字面%s分段及enter最后按键规则；返回 `{device_id,action,dispatched:true}`只表示命令完成，不证明界面已改变。错误只含固定中文，不回传工具诊断或输入文本。

旧绑定见 `aliases.example.json`：格式2的android.devices采用专用发现profile，七动作采用device_envelope和宿主真实值投影；加载必须显式指定该绑定，目标缺失不回退内置。清单能力预算是唯一设备预算，不声明普通execution。

## 期限和清理资格

发现与六能力总30000毫秒，app.uninstall总120000毫秒；排队、握手、配置、工具及结果处理共用宿主原D及协议4本地D_L。connect工具短点为min(D_L,启动前时间+5000ms)，其余直接同D_L，多笔input不刷新期限。短点先到且总期限未到时，接受既有宿主字符串失败映射dependency_failed。每笔工具前及成功交付前复核上下文。

直接客户端进程由公开capture_with_lease管理，真实PID退出才释放租约；未确认清理为粘性cleanup=failed。首批没有私有目录、worker、文件输出或后台采样。标准ADB可自动启动默认共享server，server及持久连接归部署者；取消/卸载不kill-server、不断开其它用户连接、不回滚设备状态。cleanup=complete只确认本次客户端声明范围，不证明daemon或派生树退出。

## 交付边界

本角色未运行Cargo、格式化、测试、服务或真实进程。所属纯单测在src内，独立协议/假ADB/PID/HTTP/MCP由其它写集验收。真实ADB自动启动、共享server、真机、其它宿主系统、APK/APKS安装、截图、Harmony、性能及常驻会话继续独立验收；不能借包插件测试计本设备插件完成。
