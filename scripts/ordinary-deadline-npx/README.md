# 普通操作真实 npx 总期限验收

状态：LONG-NPX 新写集，等待主代理统一语法与真实执行。只完成调用方源码和静态文本核对，尚未执行 Node、npm、Cargo、构包、安装或服务。

主代理完成正式运行包与 TGZ 后执行：

```text
node scripts/ordinary-deadline-npx-smoke.mjs --archive artifacts/正式CLI原包.tgz
```

入口仅接受 `--archive` 与已有正式 `.tgz` 路径，不执行 `npm pack`、prepare:runtime 或构建。运行模式取决于正式归档中的实际 runtime；不存在用 `--release` 偷换缓存二进制的路径。本脚本会真实调用 npx 获取本次原归档、CLI 安装可信夹具并默认无 token 启动。本轮源码交接不代表这些命令已运行。

## 职责与冻结接口复用

| 文件                               | 职责                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| 根 ordinary-deadline-npx-smoke.mjs | 原归档参数、独占目录、真实 npx 编排、首次失败 checkpoint 与 finally 收尾             |
| host.mjs                           | 独立 argv 启动 npx、安装/列举命令、默认 LAN/无 token、独立 HTTP/MCP 端口与关闭       |
| identity.mjs                       | 原 TGZ 保留、缓存全成员、shim 实际调用目标、loadRuntime 资源/served 字节及结束后身份 |
| packages.mjs                       | CLI plugin install 原夹具 TGZ、显式 HTTP/MCP load、操作预算目录                      |
| history.mjs                        | 本批开始前基线与新增八 Job 子集；已有 Job 不被本批改写                               |
| cases.mjs                          | 八 Job 场景适配，两个长分支并行且都收束后再收尾                                      |
| evidence.mjs                       | npx 专属范围、失败快照、保留证据与独立报告/最新索引                                  |

只读复用已冻结 `ordinary-deadline-http` 的 `clientFor(base,report,{mcp})`、`sharedJob/jobEvents`、`submit/terminal/cancel`、`ready/release/processVisible`、`verifyProcess/collectKnownProcesses`、`verifyLogs/verifyPackageBytes` 和证据函数。只读复用 Galileo `ordinary-deadline/fixtures.mjs#createFixtures`；不复制 TAR 构造器，不修改冻结十一文件或夹具。

冻结 `installFixtures` 只走在线上传，`verifyMatrix/verifyHistory` 要求空库总八 Job，故本目录最小适配真实 CLI 安装与基线编排。结果包装、错误、控制原因、进程事件与历史比较沿用已冻结断言，不能将任意错误视为通过。

## 八 Job 与期限证据

| 场景  | 提交/取消入口     | 必须核对                                                                                                |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| L2    | HTTP              | 协议2声明120000；ready后实际保持至少61000ms；超过60000ms同Job仍Running、夹具PID存在，release后Succeeded |
| L3    | MCP               | 协议3声明120000；与L2并行，但各自用本侧驱动/夹具单调时间独立核对                                        |
| S2-D  | HTTP              | short=10000，无release；Failed且error精确“执行超时”；实际PID退出，不伪造合作标记                        |
| S3-D  | MCP               | 同短D，线上匹配cancel reason严格timeout，command/control_request_id/id_matches精确核对                  |
| S2-C  | MCP提交、HTTP取消 | ready后且短D内主动取消；Cancelled/error=null/result=null，协议2仅证明EOF/直接PID退出                    |
| S3-C  | HTTP提交、MCP取消 | 同主动取消；匹配reason严格cancelled，cleaned/响应/EOF/零退出自报与实际PID消失分别核对                   |
| M2/M3 | 分别HTTP/MCP      | default省略声明；目录60000/source=default，有限即时响应成功                                             |

L2/L3 各自产物结果保持真实 SDK 测量摘要，宿主 PublishedArtifacts 包装按冻结端口解包。各实际 request_id、case_id、plugin_id、Job/PID映射一致；每个 case 只有一项 ready，八个不同 request_id。超过60秒的采样同时核对 npx 包装进程句柄未退出；最终日志要求恰一次宿主启动/成功结束，不把该采样宣称为直接 Rust PID 未重启证明。

short 仍使用生产10000ms，夹具合作1250ms/终止500ms和宿主正常关闭观察10秒均不延长。协议3严格沿用冻结 `verifyProcess` 的取消原因、受控文件清理、匹配响应、EOF、退出事件及 PID 消失检查；取消/到期还须有同Job/request宿主 cleanup=complete 日志。协议2强制终止时允许真实缺失 exit/diagnostic、受控 resource 留存；只证明直接PID结束，不声称外部资源或合作清理。

基线在真实宿主就绪、本批八 Job 启动前从公开 GET 读取，保留完整快照用于内存比较；报告只写基线ID/数量。列表 limit=100，最多允许91条基线以保留有界完整比较空间。结束后按差集严格要求八个新增Job，旧Job原文不变；各新Job用HTTP/MCP读取相同id/operation/input、历史和唯一终态事件。独占临时库碰巧为空也不能把代码改回整库总八项的假设。

## 原归档、shim 与实际宿主身份边界

`--archive` 原件由主代理提供，本次读取压缩 SHA256 并原样保存于独立 artifacts 目录。所有 npx 命令使用该原件绝对路径和本次独占 npm cache；结束时核对原件、副本和缓存未变化，禁止另打包文件替代。归档成员数按实际解析记录，不固定24或任何历史数量。

复用 `captureNpxRuntime/verifyArchiveCache` 将本次原 TGZ 的所有普通文件逐项与唯一实际缓存比较，解析 npm shim 的真实执行行/目标，核对 package.json bin、runtime清单、校验器、Rust binary与前端host资源摘要。`loadRuntime` 从实际缓存选择本机宿主，HTTP读取的 `/assets/plugin-host.js` SHA只与该缓存资源匹配。

公开CLI没有直接暴露Rust PID。本报告明确 `rust_os_pid.directly_collected=false`、`pid=null`、未直接采集OS Rust退出码；归档→shim→缓存→loadRuntime为静态身份链，served host字节不能推成OS PID。动态证据另有真实夹具PID、Job/request、各自单调时间、单次宿主启动/成功结束日志及npx包装exit0，不假装已拿到直接Rust ChildProcess句柄。

## 失败保留与退出

报告位于独立 `artifacts/ordinary-deadline-npx-*/report.json`，最新索引为 `artifacts/ordinary-deadline-npx-smoke.json`。首次失败先写 `failure-before-cleanup.json`，保留原stage、失败请求和在途快照；之后shutdown不能覆盖。报告不保存凭据、环境或任意CLI stdout/stderr/插件正文。

正常关闭要求 HTTP shutdown200/响应日志ID、npx包装正常exit0且无强杀、HTTP与MCP端口各自重新监听成功。失败时优先走同一公开关闭，必要时仅由既有helper终止本次持有的npx管理进程；任何强制收尾都维持passed=false，不称正常退出或进程树清理证明。

退出后严格核对本批八Job/request/提交logID同记录关联、全部公开响应ID落盘以及原日志文件SHA256；不将请求总数扩大为逐Job关系数。实际夹具PID单独有界观察，未知PID不扫描/不终止。本次原CLI归档副本、夹具TGZ、控制文件、checkpoint、日志与独立npm缓存成功/失败都保留，不删除临时根或无关文件。

本批不验证 npm公开发布、跨平台、另一机器、浏览器、真机或常驻资源；内部父D、存储池、排队和成功资格竞争仍关联独立Rust测试。正式归档的本轮真实npx通过须由主代理动态报告证明，不能借用在线HTTP smoke或旧npx记录。
