# npx 统一发现独立验收辅助

本目录与 `../cli-smoke-unified-discovery.mjs` 仅提供主代理现有 cli-smoke 的加法接入。原调用脚本由主代理修改；本批不运行 Node/Cargo/npm、构建、测试或服务，不修改已冻结 RAW-NODE 夹具或后端源码。

## 稳定接口与调用顺序

```js
configureNpxUnifiedDiscovery(temporary, environment);
verifyNpxUnifiedDiscovery({
  root,
  temporary,
  pluginDirectory,
  runNpx,
  prefix,
  dataDirectory,
  base,
  mcp,
  headers,
});
```

两个函数从 `../cli-smoke-unified-discovery.mjs` 导出。配置函数须在 configureNpxAlias 之后、宿主启动之前调用；verify 由主代理在同一实际 npx 服务就绪后调用。mcp 是独立监听器的完整 `/mcp` URL，headers 可省略，也可包含调用方当前私有令牌。helper 不启动、停止或查杀宿主，不自行执行 npm pack，不把 HTTP 在线上传冒充实际 CLI 安装。

configure 读取 environment.APK_OPERATION_BINDINGS，按当前工作目录解析相对路径，再核对真实路径处于本次 temporary 内。只修改这个已有文件，不另造配置或改变环境路径。保留全部原 bindings，将 format_version 升为2，追加：

| 旧入口          | 真实目标                           | 专用结果profile            | 协议 / 设备API |
| --------------- | ---------------------------------- | -------------------------- | -------------- |
| android.devices | device_discovery / raw_npx_android | device_discovery / android | 2 / 3          |
| harmony.devices | device_discovery / raw_npx_harmony | device_discovery / harmony | 3 / 3          |

input 的线格式为字符串 `'identity'`，不猜内部tag。绑定中没有自行指定目标operation；真实发现由加载owner解析。发现业务模式为object且禁止额外字段；旧名冲突、文件越界、数量或64KiB上限均在写入前拒绝，不覆盖原绑定。

配置返回 `{path,formatVersion:2,preservedBindings,addedAliases,providerIds}`。preservedBindings 为原绑定数，不是覆盖数量；返回前重新读取核对原绑定完整保留。

## verify 的真实执行边界

verify 每次创建新的 phaseId 与 `temporary/unified-discovery-npx/<phaseId>`。两包分别含本次独立绝对控制目录，调用前不允许已有同ID贡献；CLI安装失败不删除或覆盖已有部署。TGZ通过冻结RAW-NODE构包，写入临时文件后实际调用：

```text
runNpx([...prefix, 'plugin', 'install', tgzPath, '--data-dir', dataDirectory])
```

runNpx 由现有主调用提供，必须采用 execFile 的成功resolve/非零reject语义；helper另检查若有code字段须为0。安装归档在调用前后读取并校验实际字节SHA256，记录零退出，不复制stdout/stderr。CLI安装与load之后均断言夹具尚未执行，provider API3、平台与加载generation来自真实公开响应。

两个包各做 refresh/direct/alias × HTTP/MCP 六次成功，全部业务input严格 `{}`，label仅走管理员文件。覆盖 recovery/sideload/bootloader、未知原文首尾空白与100 UTF-8字节；新目录归一化状态保持unknown，原文逐字节保真。

refresh返回本次目录回执；direct/alias按本次Job ID等待目录匹配，不靠后来GET猜refresh回执。每次核对历史入口原名、空输入、唯一新增Job、queued/running/succeeded事件、同一个discovery_job_id、唯一request_id/PID和真实进程退出。direct/refresh保留协议2/3真实result/artifacts包装，alias精确返回旧四字段数组，由宿主完成profile映射，夹具不映射。

正常已安装包另控制输出101 UTF-8字节坏原文，分别用HTTP/MCP验证发现502 dependency_failed或同领域工具错误；单Job失败、一次执行、成功清理退出、无目录。此为运行失败，不能当作安装错误。

每个协议再启动一次hold发现并在途卸载：协议3要求实际cancel_received、cleaned、response_written、stdin_eof、process_exit及返回当下PID不存在；协议2仅确认同一个直接PID不存在，未观察到退出码时保留null，不伪造合作确认或外部资源清理。

卸载后provider/目录/真实操作/旧别名在HTTP/MCP均撤销。refresh、设备动作和direct/alias提交精确为404 not_found，零新Job与零执行。重载新generation后，旧代refresh/动作和新代未观测动作精确为409 conflict；重新成功发现只创建一次Job。原Succeeded/Failed/Cancelled历史及事件跨重载保持原样。

成功结束时先卸载本次安装的两个固定ID。CLI离线安装不生成在线包视图，在线包DELETE精确返回404；随后只清理已校验位于本次temporary内、真实直接子目录且manifest ID匹配的两个离线夹具目录，允许同一dataDirectory后续另一个phase重新安装。该步骤不表示生产在线包卸载或CLI卸载命令已实现。保留本次TGZ、控制、事件和数据库历史；不删除临时根、不删除无关部署。失败后不执行新的业务清理覆盖首次诊断，附带局部证据交由主代理决定服务收口与临时目录保留。

## 公开返回证据

verify 返回以下稳定根字段：

| 字段                                                       | 含义                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schemaVersion / phaseId / startedAt / completedAt / passed | 证据版本1、本次唯一阶段、实际时间及全部断言结果                                                                                                                     |
| packages                                                   | id/protocol/devicesApiVersion/platform/controlDirectory；tgz包含path/bytes/sha256，install包含command/exitCode/installedVersion                                     |
| entries                                                    | providerId/generation/protocol/entry/transport/operation/label/jobId/requestId/pid；jobCountDelta、executionCountDelta与process证据；成功条目附rawState与本次logIds |
| logIds                                                     | 本客户端所有真实HTTP/MCP响应日志ID去重排序，不含令牌或原始正文                                                                                                      |
| providerIds                                                | raw_npx_android、raw_npx_harmony                                                                                                                                    |
| history                                                    | jobId/operation/status/eventCount/httpMcpEqual/unchanged/eventsUnchanged                                                                                            |
| reloads                                                    | providerId/protocol/oldGeneration/newGeneration/cancelledJobId/process及精确rejections                                                                              |
| rejections                                                 | HTTP path或MCP tool、transport/status/code/logId；MCP业务错误仍为HTTP200                                                                                            |
| cleanup                                                    | 两个本次部署的卸载、清理标记、贡献/目录撤销和删除断言                                                                                                               |

成功entries为12次六入口矩阵加2次重载发现，共14条成功；另有2次坏原文失败、2次在途卸载取消。18份Job历史逐一比较，HTTP/MCP历史一致。任务列表要求少于200，若截断直接失败，不能把计数不完整写成单Job证明。

失败抛出的Error附 `unifiedDiscoveryEvidence`：passed=false、failure包含阶段、错误名称及有限请求定位；finally补completedAt与logIds。不会复制headers、环境、CLI输出、异常正文或任意业务输入。调用方须检查passed，不能把部分entries视为全部通过。

本helper不向现有artifacts写报告。主代理持久保存当前npx宿主pack、实际服务二进制/运行清单与TGZ摘要，并在正常shutdown后核对logIds已落盘；这些证据不由helper补造。这里的logIds只证明公开响应关联，直接进程退出只证明该PID边界；真机、常驻连接、阻塞存储/裁定竞态、真实浏览器和完整RAW24组由所属门禁分别验收。

## 文件职责与当前检查

- 主入口：阶段目录、真实CLI安装、两协议矩阵、移除本次部署与证据返回。
- config.mjs：已有临时绑定的有界升级，保持旧wire与原bindings。
- client.mjs：HTTP/独立MCP、可选私有令牌、日志关联与精确错误。
- checks.mjs：观测/旧数组/单Job单执行/完整历史的公开断言。
- lifecycle.mjs：在途卸载、直接PID证据、新旧代拒绝与历史保留。

本次仅核对文件差异、UTF-8、尾随空白与源码接口，不运行语法检查、构建或真实执行；最终通过结论等待主代理实际命令及退出码。
