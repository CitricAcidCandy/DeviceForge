# Frida基础消费真实宿主验收

本驱动实际导入前端`createApiClient`及`createHttpFrida`，调用真实Rust宿主与Frida插件。只使用既有公开六贡献，生产与前端源码不注入测试分支。

## 入口与冻结

先由主代理完成当前宿主及Frida插件的debug构建，再独立编译既有标准库假工具：

    rustc --edition=2024 backend/plugins/frida/tests/fixtures/tool.rs -o artifacts/frida-consumption-fixtures-20261012/frida-tool.exe
    node scripts/frida-consumption-smoke.mjs

编译目录须先创建。本轮补强使用Windows实际OS等待句柄，因此入口要求Windows与Node24。`--tool=<实际工具路径>`可明确指定已编译入口；`--frozen-input=<目录>`消费主代理冻结的`apk-server.exe`、`deviceforge-frida-plugin.exe`和`manifest.json`，否则仅在主代理明确重建稳定后读取对应target目录。`--release`只消费重建后的release程序，不自行构建或将debug结果转计。

实际宿主、插件、清单、工具、OS探针与权限脚本模板复制到每轮独立目录。运行前后分别核对原输入、驱动导入依赖、Node、Frida全源码、前端导入闭包、部署配置/清单、实际程序快照及固定工具输出计划的摘要。动态release门闩及真实观测单独保留。

## 范围

- 动态六贡献、MCP目录与未刷新目录时零任务提交。
- 服务器二进制/UTF-8脚本实际上传、SHA-256与原字节下载。
- 观察状态、进程列表、服务部署、限时运行、脚本及权限分析的实际HTTP工厂；HTTP/MCP共享原Job。
- 授权副本、全部11个工具的固定argv、固定黄金回执、脚本/通知/权限与操作产物原字节；安装/状态stdin精确金样，限时运行stdin独立核对本次所有权关键子句。
- MCP新提交与前端恢复；中断等待保留票据，显式取消原任务。
- 卸载撤销、历史/产物保留和新请求拒绝，无隐式重发。
- 全部八Job唯一终态与卸载后同份HTTP/MCP事件历史，七次前端提交和一次MCP提交，恢复零重发。
- 响应/任务/唯一插件request_id与终态码日志关联，普通日志不记录脚本/工具stdout；输入摘要稳定、宿主正常退出与监听释放。
- 每个工具在真实ready门闩后取得OS句柄再释放；实际工具路径与父插件路径/创建身份、退出码及私有目录物理清理。取消工具不释放正常门闩，其非零OS退出必须独立确认。

假工具保存固定样例的argv、stdin、上传副本和退出计划，不读取用户设备或任意环境值。本轮原`tool.rs`与其已编译程序不改，改由驱动独立释放11个门闩，使用已有原生探针获取实际OS等待结果。文件退出计划仅保留为诊断，不能冒充退出码。

本次OS证据只覆盖本地工具及其直接父插件；合成OWNED/CLEAN回执仍不证明真实远端进程、server/su/watch/timer或设备状态。真实ADB/su/Frida/Java、注入效果、派生树、跨平台、真机和产品界面另行验收。权限脚本使用既有固定模板和手写三项camera配置生成独立预期字节，不调用生产生成器作为oracle。

每次报告为`artifacts/frida-consumption-service-<模式>-<唯一ID>/report.json`。失败原件持续保留，结束时回收本轮真实宿主和自有探针，不扫描或结束未知PID。源码/语法检查不能替代实际服务运行。

首轮`3973e971-10a2-4acd-8d51-36dda9e5dbce`真实揭露`.bin/.js`上传白名单未接通，原件保留；驱动不换扩展名绕过，须等待主代理窄修上传与授权副本接缝、重建冻结后再运行。

## 2026-10-12实际完成证据

主代理修后独立冻结`plugin-formats-debug-frozen-56f8cffe-a0c6-489e-b38a-901fd5a688fe/frida`实际运行，报告为`artifacts/frida-consumption-service-debug-82ce7a9e-0e3d-4e52-b593-566f6dd5d634/report.json`。驱动终端实际退出0，七项检查及八Job全部符合预期：七成功、一显式取消；11工具先取得真实OS句柄，十正常退出0、取消工具退出1，八独立父插件全部退出0，11探针全部退出0。

67项输入含31项实际前端导入，另有36项固定夹具输入、部署与程序快照前后身份稳定；七次实际前端提交及一次MCP提交，恢复没有新任务。六次产物下载覆盖操作JSON、日志、脚本、JSONL通知和权限脚本，卸载后原历史及原字节保持；812条日志关联229个响应ID和八个唯一插件request_id。宿主PID51272正常退出0，56587监听释放。

修后首轮`f3a88e0c-2700-4741-9173-99a07ee01ac2`已越过原上传阻断，但取消用例误读`JobWaitFailure.ticket`而退出1；依据公开`job`与`submitLogId`修正驱动取票据后重跑，两个失败原件均保留，生产和冻结程序没有改动。这里的完成只指本节可控工具消费范围，不能扩大为真实Frida注入、设备或正式分发验收。
