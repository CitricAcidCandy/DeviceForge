# 后端文档导航

按用途查找文档。新增文档放入对应类别，并在本页补入口；设计稿和图片保留在 `design/`。

| 目录 | 内容 |
| --- | --- |
| `guides/` | 开发手册、工程规则与部署说明 |
| `contracts/` | 对外接口、协议与消费契约 |
| `implementation/` | 设计方案、实施裁定与迁移接缝 |
| `verification/` | 验收矩阵、测试记录与来源证据 |
| `reference/` | 预算等查阅清单 |

## 开发手册

- [操作绑定部署](guides/操作绑定部署.md)
- [插件开发](guides/插件开发.md)
- [架构与开发约束](guides/架构与开发约束.md)
- [命令行部署与插件安装](guides/命令行部署与插件安装.md)
- [迁移清单](guides/迁移清单.md)
- [运行中插件生命周期](guides/运行中插件生命周期.md)
- [重写决策与文件骨架](guides/重写决策与文件骨架.md)
- [MCP服务](guides/MCP服务.md)

## 接口与协议

- [安装包分析接口](contracts/安装包分析接口.md)
- [安卓包插件部署与七操作契约草案](contracts/安卓包插件部署与七操作契约草案.md)
- [安卓设备插件第一批契约草案](contracts/安卓设备插件第一批契约草案.md)
- [包工具公共库迁出契约](contracts/包工具公共库迁出契约.md)
- [操作绑定第一批契约](contracts/操作绑定第一批契约.md)
- [插件产物协议](contracts/插件产物协议.md)
- [产物接口](contracts/产物接口.md)
- [反编译与SDK检测接口](contracts/反编译与SDK检测接口.md)
- [工具进程完整范围公共契约](contracts/工具进程完整范围公共契约.md)
- [合作取消插件协议](contracts/合作取消插件协议.md)
- [交互会话协议第五版裁定](contracts/交互会话协议第五版裁定.md)
- [接口设计](contracts/接口设计.md)
- [普通操作总期限第一批契约](contracts/普通操作总期限第一批契约.md)
- [日志与关联契约](contracts/日志与关联契约.md)
- [设备产物操作](contracts/设备产物操作.md)
- [设备输入接口](contracts/设备输入接口.md)
- [统一发现第二批契约](contracts/统一发现第二批契约.md)
- [性能采样插件协议](contracts/性能采样插件协议.md)
- [性能会话接口](contracts/性能会话接口.md)
- [在线插件接口](contracts/在线插件接口.md)
- [AAB构建接口](contracts/AAB构建接口.md)
- [APKS设备匹配接口](contracts/APKS设备匹配接口.md)
- [MessagePack插件接口](contracts/MessagePack插件接口.md)

## 设计与实施

- [安卓安装截图插件实施裁定](implementation/安卓安装截图插件实施裁定.md)
- [安卓安装截图插件实施裁定候选](implementation/安卓安装截图插件实施裁定候选.md)
- [安卓安装截图宿主撤除接缝](implementation/安卓安装截图宿主撤除接缝.md)
- [安卓包插件第一批实施裁定](implementation/安卓包插件第一批实施裁定.md)
- [安卓设备插件安装与截图接缝草案](implementation/安卓设备插件安装与截图接缝草案.md)
- [安卓设备插件第一批实施裁定](implementation/安卓设备插件第一批实施裁定.md)
- [安卓设备七能力宿主撤除裁定](implementation/安卓设备七能力宿主撤除裁定.md)
- [安卓设备七能力宿主撤除接缝](implementation/安卓设备七能力宿主撤除接缝.md)
- [安卓APKS安装插件实施裁定](implementation/安卓APKS安装插件实施裁定.md)
- [包分析薄适配第一批裁定](implementation/包分析薄适配第一批裁定.md)
- [包工具公共库第一批实施裁定](implementation/包工具公共库第一批实施裁定.md)
- [包工具退出与目录租约裁定](implementation/包工具退出与目录租约裁定.md)
- [包核心薄适配实施接缝](implementation/包核心薄适配实施接缝.md)
- [插件脚本与录像产物接缝](implementation/插件脚本与录像产物接缝.md)
- [插件嵌套输入产物实施](implementation/插件嵌套输入产物实施.md)
- [插件执行上下文第四版裁定](implementation/插件执行上下文第四版裁定.md)
- [非设备长任务执行期限方案](implementation/非设备长任务执行期限方案.md)
- [工具来源缓存回退裁定](implementation/工具来源缓存回退裁定.md)
- [工具运行时功能迁移裁定](implementation/工具运行时功能迁移裁定.md)
- [交互会话连续输出实施](implementation/交互会话连续输出实施.md)
- [交互终端迁移实施裁定](implementation/交互终端迁移实施裁定.md)
- [旧操作绑定迁出实施](implementation/旧操作绑定迁出实施.md)
- [六项业务迁移实施](implementation/六项业务迁移实施.md)
- [平台适配器迁出实施](implementation/平台适配器迁出实施.md)
- [普通期限共享传输兼容裁定](implementation/普通期限共享传输兼容裁定.md)
- [设备适配器插件架构](implementation/设备适配器插件架构.md)
- [设备提供者第一阶段实施](implementation/设备提供者第一阶段实施.md)
- [设备原始状态与统一发现实施方案](implementation/设备原始状态与统一发现实施方案.md)
- [剩余包操作薄适配第二批裁定](implementation/剩余包操作薄适配第二批裁定.md)
- [剩余包操作薄适配实施接缝](implementation/剩余包操作薄适配实施接缝.md)
- [宿主交互会话接入裁定](implementation/宿主交互会话接入裁定.md)
- [宿主交互会话实施](implementation/宿主交互会话实施.md)
- [投屏直播插件实施](implementation/投屏直播插件实施.md)
- [性能采样迁出最小实施裁定](implementation/性能采样迁出最小实施裁定.md)
- [性能动态提供者生命周期实施方案](implementation/性能动态提供者生命周期实施方案.md)
- [原生插件分发](implementation/原生插件分发.md)
- [在线插件安装架构](implementation/在线插件安装架构.md)
- [终端业务插件实施裁定](implementation/终端业务插件实施裁定.md)
- [AI SDK桥接实施裁定](implementation/AI SDK桥接实施裁定.md)
- [AI实时CLI输出插件实施裁定](implementation/AI实时CLI输出插件实施裁定.md)
- [Android Unicode输入插件实施裁定](implementation/Android Unicode输入插件实施裁定.md)
- [Android包公共库提取方案](implementation/Android包公共库提取方案.md)
- [Android游戏电气温度采集实施](implementation/Android游戏电气温度采集实施.md)
- [Android游戏指标Rust采集实施](implementation/Android游戏指标Rust采集实施.md)
- [Android游戏FPS采集实施](implementation/Android游戏FPS采集实施.md)
- [Android指标部分缺测实施](implementation/Android指标部分缺测实施.md)
- [AndroidRoot堆栈与帧画面实施](implementation/AndroidRoot堆栈与帧画面实施.md)
- [AndroidRoot录制资源与归档交接](implementation/AndroidRoot录制资源与归档交接.md)
- [APKS高级匹配插件实施裁定](implementation/APKS高级匹配插件实施裁定.md)
- [DEX产物资格接缝](implementation/DEX产物资格接缝.md)
- [DEX直接分析插件实施裁定](implementation/DEX直接分析插件实施裁定.md)
- [Excel导入插件实施裁定](implementation/Excel导入插件实施裁定.md)
- [Harmony核心设备插件实施裁定](implementation/Harmony核心设备插件实施裁定.md)
- [Harmony截图插件实施裁定](implementation/Harmony截图插件实施裁定.md)
- [Harmony连接与断开插件实施裁定](implementation/Harmony连接与断开插件实施裁定.md)
- [Harmony输入插件实施裁定](implementation/Harmony输入插件实施裁定.md)
- [Harmony应用启停与重置插件实施裁定](implementation/Harmony应用启停与重置插件实施裁定.md)
- [Harmony应用详情插件实施裁定](implementation/Harmony应用详情插件实施裁定.md)
- [JPEG通用产物资格实施](implementation/JPEG通用产物资格实施.md)
- [MCP目录通知实施](implementation/MCP目录通知实施.md)

## 验收与证据

- [安卓包插件七操作服务验收矩阵](verification/安卓包插件七操作服务验收矩阵.md)
- [包核心薄适配独立验收矩阵](verification/包核心薄适配独立验收矩阵.md)
- [包核心独立验收矩阵](verification/包核心独立验收矩阵.md)
- [旧操作绑定验收矩阵](verification/旧操作绑定验收矩阵.md)
- [跨进程期限与平台迁出独立验收补充](verification/跨进程期限与平台迁出独立验收补充.md)
- [普通操作真实长进程验收方案](verification/普通操作真实长进程验收方案.md)
- [普通操作总期限第一批验收矩阵](verification/普通操作总期限第一批验收矩阵.md)
- [设备原始状态统一发现验收矩阵](verification/设备原始状态统一发现验收矩阵.md)
- [剩余包操作独立验收矩阵](verification/剩余包操作独立验收矩阵.md)
- [异步与日志性能验收](verification/异步与日志性能验收.md)
- [Android游戏采集来源证据](verification/Android游戏采集来源证据.md)

## 参考清单

- [实际平台插件普通任务预算清单](reference/实际平台插件普通任务预算清单.md)

