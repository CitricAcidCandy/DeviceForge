# Excel 导入插件实施裁定

日期：2026年10月13日。模式：architecture-first；范式：Hybrid，先冻结公开输入输出与资源范围，后端、前端和独立服务驱动并行，集成时验证真实文件和取消清理。

## 目标与边界

迁移旧 ExcelImportPanel 的工作簿读取、工作表选择、分页、表头规范化及字段映射基础用例。支持 XLSX、XLS、UTF-8 CSV；本批不创建页面、不执行公式、不调用真实 GM 服务。旧 TestCaseTable 仅静态示例，不作为已存在的执行引擎迁移。用例表和 GM 的独立业务仍留迁移清单。

选择独立 Rust spreadsheet 插件，复用公开任务/产物/日志/插件生命周期。比较浏览器解析方案：浏览器会重复解析和资源限制且不能由 MCP 共用；独立插件让两种客户端共享真实解析。业务解析不加入宿主或通用路由。

## 职责与写权

| 单元与所有者 | 职责、输入输出及副作用 | 边界 |
| --- | --- | --- |
| 主代理/交付总监：产物格式模块、workspace成员、契约文档、集成和根记录 | 三类文件的有界格式准入、共享生成/门禁及证据；文件与构建副作用 | 不加入工作表规则，不修改无关改动 |
| 后端：plugins/spreadsheet | 授权副本读取及摘要校验、格式预检、工作簿解析、纯表头/分页规则、协议4受限阻塞工作与原期限取消 | 不依赖宿主生产模块，不执行宏/公式，不接任意服务器路径 |
| 前端：features/spreadsheet、所属测试/文档 | 动态目录、真实任务通信、纯结果验证、字段映射和分页导入 | 仅shared/SDK依赖，不手改生成类型，不创建页面 |
| 测试：scripts/spreadsheet-smoke及子目录 | 独立文件原字节、HTTP/MCP及实际前端消费、热装卸/历史/退出 | 不编辑生产文件、不擅自启动共享构建 |

## 第一版冻结合同

插件 ID 为 spreadsheet，公开操作 ID 为 plugin.spreadsheet.inspect 和 plugin.spreadsheet.read，本地操作名 inspect/read；协议4，总期限30000毫秒，仅 artifact_id 输入产物、无输出产物。

- inspect 输入：artifact_id；输出 format_version=1、artifact_id、source_filename、format（xlsx/xls/csv）、sheets（name/index）。工作表名字唯一且 index 从0连续，至少一项。CSV 单一工作表固定名称 CSV。
- read 额外输入：sheet 可为精确名称或非负整数索引；省略才取第一表，显式无效/空/null拒绝。offset默认0，limit默认100且1至500；offset至多10000，大于总行数允许空页。
- read 输出保留 inspect 字段，并增 sheet_name、headers、rows、total_rows、offset、limit。行数等于 min(limit,max(total_rows-offset,0))，行键严格等于headers，缺测为null。空工作表返回空headers/rows和total_rows=0。
- 第一非空行作为表头，trim文本，空表头为列N；重复名采用__N后缀并避开所有原始名称及已生成名称，不能覆盖已有A__2。数据空行省略，数字0和false保留；只读缓存值，不执行公式。
- 文件16MiB、工作表64、列256、数据行10000、单元格32768个UTF-8字节、表头及表名512字节、结果JSON序列化1MiB。XLSX展开64MiB、条目512，坐标/维度/共享字符串/单元格总量预检须在大范围分配前完成；XLS先核容器/BIFF记录边界及坐标再交库，不能仅解析后查上限。CSV严格UTF-8、无NUL，单元格保留字符串类型。

补充资源合同：单个XLSX条目展开至多32MiB；整本工作簿预分配矩形总量至多2560256单元格，XLS各表DIMENSIONS及实际cell坐标必须在交给calamine前检查。CFB声明长度/FAT链/循环、ZIP重复条目/加密/越界与XML外部关系拒绝；不提取到文件系统。

字段映射保留 previous→default→key→label，每个候选先精确后trim/小写匹配；缺映射和每行空值分开报告，0/false有效。过滤先接只读原始行，再按映射提取；分页导入只代表当前页，不能冒充整表。独立业务结果由前端校验，宿主生成DTO不重复定义。

## 实施与最低验收

可立即实施上述四写集。主代理只向workspace追加成员，锁文件由Cargo解析；calamine与csv新依赖须核官方版本/MSRV且不触及宿主。新增产物MIME与最低容器/UTF-8准入由基础设施承担，工作簿语义仍归插件。后台工作取消必须等真实阻塞句柄完成，不能只丢Future后声明cleanup完成。

最低证据：合法XLSX/CSV/XLS与表选择/表头/分页；错误参数/损坏/坐标膨胀/超限/摘要拒绝；公开协议4/服务任务的HTTP-MCP一致性、真实前端工厂、热装卸与历史、真实宿主退出和端口释放；共享架构/fmt/Clippy/workspace测试/构建及前端生成/check/test/build。缺少真实XLS样本或某确定性取消证据须单列，不能用元数据/伪格式替代。性能专项继续延后。
