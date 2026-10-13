# 表格插件独立功能验收

入口只消费主代理已经冻结的新 Rust 宿主、spreadsheet 插件及实际前端工厂，不执行 Cargo、前端构建、共享服务或性能压测。

```powershell
node scripts/spreadsheet-smoke.mjs --help
node scripts/spreadsheet-smoke.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --profile=debug
```

宿主目录包含 `apk-server.exe`，插件目录包含 `deviceforge-spreadsheet-plugin.exe` 和协议 4 的 `manifest.json`。清单直接指向冻结 Rust 插件，无 Node 代理进程。本轮建立独立 UUID 目录、快照、数据库与监听端口；运行前后核二进制、清单、脚本闭包、实际前端相对导入闭包和输入原字节的 SHA-256。失败报告保留，不覆盖或删除旧证据。

## 真实输入及范围

`fixtures.mjs` 使用标准 ZIP 的本地头、CRC32、中央目录与 EOCD 生成真正 OOXML 文件，包含类型表、根关系、工作簿、工作簿关系和三张工作表。单元格分别使用 inlineStr、数值与布尔类型，避免用文件扩展名或仅 ZIP magic 伪造工作簿。无需新增仓库依赖。

黄金工作簿包含“中文数据”“分页”“空表”。中文表预留所有原表头，`A,A,A__2` 必须生成 `A,A__3,A__2`，空第 4 列与原有“列4”冲突时使用“列4__2”；数字 0、布尔 false 和缺测 null 分开，内部空行过滤。分页表含 5 行，验证名称及索引精确选择、offset/limit、越总量空页；空表无表头和数据。

UTF-8 BOM CSV 包含中文、逗号、转义引号、单元格换行与空行；空字段为 null，`0` 和 `false` 保留字符串。另生成损坏 worksheet、膨胀维度、单元格/表头/行数以及 JSON 输出超限的真实格式输入。全部输入在真实 HTTP 上传后核摘要和原字节下载；最低格式准入与业务失败分别验证。

## 服务验收

- 初始无插件目录，加载后 HTTP/MCP 出现 inspect/read；实际前端 `createHttpSpreadsheet` 的目录、inspect/read 与分页结果符合冻结合同。
- HTTP/MCP 提交共享 Job，查询同一原文；错误工作表失败，非法参数返回带日志 ID 的错误且不生成 Job，不推测特定业务错误 code。
- 损坏、坐标与资源限额必须以实际 Job failed 和非空 error 核实。
- 卸载目录撤销，前端新提交拒绝；原 MCP 票据恢复历史不重新提交。新代可读取，旧历史不改写。
- 宿主实际 child close 为退出 0，监听重新绑定证明释放；全部响应日志 ID 以及各插件 Job 开始/结束和 request ID 配对正常落盘。日志最多 256 文件、单个 16MiB、合计 64MiB，报告按 4096 字节分批写。

## 当前状态与边界

驱动已编写，前端公开工厂尚未交接时只有适配 hook，不宣称已消费成功；只在新构建冻结且主代理交接后运行实服。

本批尚无真实 XLS 黄金样本，有限搜索未发现本地样本及已安装 xlwt，XLS 解析列未验。允许以后从官方 calamine 固定标签测试集取得授权样本，独立保存在 artifacts 并记录来源。

快速插件子进程通过宿主监督和任务起止记录确认；未捕获每笔插件原 OS 句柄，不宣称原句柄或完整派生树验收。插件只进行文件与 CPU 工作，没有外部设备工具。本批无确定性阻塞解析门闩，取消及 worker 收口另列未验。实际前端在 Node 执行，不替代浏览器页面、视觉、正式 npx/TGZ、registry、跨平台、另一 LAN 主机或性能测试。
