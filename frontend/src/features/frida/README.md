# Frida 业务用例

本模块消费六个真实贡献：`plugin.frida.server.deploy/server.status/server.run/processes/script.run/permissions.analyze`。`rules.ts` 校验设备、产物身份、100–120000 毫秒时长和结构化 Hook；`results.ts` 区分部署、观测、受控运行、进程枚举和脚本结果；`index.ts` 负责任务组合、上传、下载、恢复等待和显式取消。

`createFrida` 注入公开宿主的三个任务方法和 `ArtifactAccess`。业务请求固定为 `{device_id,input:{业务字段}}`，上传以产物 ID 引用，浏览器不传服务端路径或任意工具命令。脚本上传检查 UTF-8、空字节和 64 MiB 上限。任务成功结果严格消费 `{result,artifacts}`，校验 `operation.json`、`frida.log` 及脚本/通知文件；下载保持原字节，并核对大小和 SHA-256。

状态观测是 `observed_only`，服务器运行只消费本次调用的 `invocation` 清理证据。脚本结果区分派生默认恢复和已运行目标；`direct_cli_confirmed` 仅证明直接 CLI 清理，`target_process_cleanup:not_claimed` 不得显示为目标进程停止。权限分析要求实际 Hook 总计诊断，并包含麦克风与传感器模块。

取消等待后用已知任务身份恢复，不重复部署或执行脚本。当前提供框架无关消费和目标测试；真实设备、Frida CLI、权限 Hook 效果、产品页面和视觉验收需独立完成。
