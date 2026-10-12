# Frida业务插件

本插件把旧ApkTool的Frida部署、运行、进程枚举、脚本与权限分析迁到独立进程。它只依赖公开的插件SDK、协议4运行库和工具执行库，不导入宿主内部四层。业务请求不含工具路径、命令字符串或远端自由路径。

## 部署配置

将示例另存为二进制旁的 frida.config.json。也可在部署参数中设置 --config <绝对路径>。这是部署者设置，不是浏览器输入。配置版本必须为1，最多65536字节；工具入口只能是单一程序名或普通文件绝对路径。绝对路径及祖先拒绝链接和Windows重解析点。

工具必须提供ADB、Frida CLI、frida-ps。CLI须支持 -D、-f、-n、-l、-q、--timeout、--exit-on-error，枚举须支持 frida-ps --json。CLI与server版本、设备架构由部署者匹配。直接工具进程使用受限环境，不继承宿主令牌；临时目录指向本次私有目录。

设备须提供可用的 su -c、Android shell、/proc、readlink、grep及支持小数秒的sleep。部署路径限定到 /data/local/tmp/ 下的固定普通路径，默认 /data/local/tmp/deviceforge-frida-server。本插件不安装root能力。

## 六项贡献

输入都采用 {device_id, input:{业务字段}}。未知字段拒绝；目标应用使用包名，mode为spawn或attach，附加按应用进程名进行。

| 贡献 | 业务字段 | 实际行为 |
| --- | --- | --- |
| server.deploy | artifact_id | 摘要核验后ADB push临时副本，以root检查版本、部署并设置700权限；只撤除本次上传副本 |
| server.status | 无 | root核验部署文件与版本，读取真实 /proc/*/exe 识别服务，返回观察到的PID |
| server.run | duration_ms | 独占目录复制server、启动、记录服务及看门狗/计时器身份；时长结束后清理本次进程 |
| processes | 无 | 调用 frida-ps -D <设备> --json，严格解析真实PID与名称 |
| script.run | package、mode、duration_ms、script_artifact_id | 使用-f或-n，从授权副本加载JS，以CLI超时退出；保留日志和脚本 |
| permissions.analyze | package、mode、duration_ms，可选modules、hooks、show_log | 生成权限脚本，执行真实CLI，要求Hook初始化统计；返回安装、缺失及报告异常诊断 |

时长为100至120000毫秒。所有阶段沿宿主Start帧给予的同一截止点，贡献总预算最长150000毫秒。CLI超时采用向上取整的秒数，结果返回cli_timeout_seconds，不把这一整秒观测窗口写成毫秒精度。服务看门狗最多多保留两秒作为断连兜底。

脚本操作需要已有可连接的服务。本插件不会为脚本自动启动或杀死共享服务；可在独立有界server.run期间运行脚本，也可连接部署者管理的服务。server.status只报告观察结果，不获得杀死观察到的进程的资格。

## 产物合同

部署输入授权必须唯一对应 /input/artifact_id，脚本授权必须唯一对应 /input/script_artifact_id。标识、字段、真实大小与SHA256逐项核对；普通文件及祖先拒绝链接、重解析点与特殊文件。输入最多64MiB，复制到本次独占目录后才交给工具。JS必须是UTF-8且不含空字节。

六项操作都需要授权输出目录，交付operation.json和frida.log。脚本另交付script.js、notices.jsonl；权限另交付permissions.js、notices.jsonl。输出以create_new创建，已有同名文件使本次失败；失败只撤除本次创建的输出，不删除宿主目录。标准输出最多8MiB，标准错误最多1MiB，notice最多10000条。

notices.jsonl是带专用前缀的通知逐行JSON。自定义JS原始send()与console.log()仍保留在有界frida.log，不猜测为权限通知。通知保留time/action/arg/messages/stacks/module，新增class/method/result帮助定位。show_log=false禁用权限通知，初始化诊断仍保留，作为实际加载证据。

## 旧业务对应

旧FridaManage.ts的root shell、目录切换、chmod与运行迁到server.deploy/server.run。旧实现只杀本地ADB shell，无法证明远端退出；新实现按本次目录、PID、启动ticks和可执行文件校验，清理本次服务、看门狗、计时器，不按名称全杀。

旧AppPermissionsAnalysis.ts的spawn、attach、createScript/load、resume迁为CLI的-f/-n/-l与现代CLI默认恢复。结果resume=cli_default表明依赖CLI默认恢复；附加为already_running。退出CLI不等于应用退出，target_process_cleanup=not_claimed。不沿用长期Node session、阻塞recv().wait()或实时前端消息握手。

旧Tools/frida/peromission.js分类映射：

- permissions：权限申请。
- phone：电话、SIM、基站、短信。
- system：安卓ID、序列号、剪贴板、厂商标识及内容查询。
- packages：应用列表与其他应用信息；按目标包排除自身，取消阻塞握手。
- location：定位、位置字段、地理编码。
- camera、network、bluetooth：摄像头、网络与蓝牙。
- files、media、sensor：文件访问、麦克风、传感器。

modules为空默认全部类别。hooks为{class,method,module?,action,messages,args?}数组，参数过滤为字符串完全匹配，不执行输入表达式。同一类方法多条规则共享一次原调用，各自报告。旧Hook在参数不匹配时返回null会改变结果，新实现只限制报告，保留原返回值和异常。

缺少类/方法时逐项返回missing诊断；summary统计已安装重载与缺失方法，不把部分安装写成全覆盖。网络IP报告保留原数值，不冒充旧脚本加工的IPv4文本。

## 清理资格与验收边界

只有确认直接工具进程、文件工作、远端本次所有者与私有目录清理完成，才返回协议cleanup=complete。取消或到期后只允许统一两秒窗口内的有限清理；失败、身份缺失/变化或文件工作未退出都返回cleanup=failed并保留资源。远端只移除验证过的本次固定文件与目录，长期部署文件保留。

源码实现不代表真机验收。本批尚未核验真实root方案、ADB断连传播、CLI/server版本匹配、厂商Hook覆盖、实际spawn恢复及消息采集。真机验收需分别证明六操作、11类Hook、自定义规则、取消后的所有者退出与无误杀。假工具或编译不能替代这些证据。
