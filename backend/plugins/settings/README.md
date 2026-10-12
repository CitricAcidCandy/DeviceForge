# 配置业务插件

迁移旧 custom_config 与设置中心的配置读写职责，通过已有任务、HTTP/MCP 和公开协议 4 接入，不依赖宿主源码。

部署时将 `settings.config.example.json` 调整为旁置 `settings.config.json`，或在清单中传入 `--config` 与绝对配置路径。存储根路径由部署者固定；请求只能使用 `scope`（user/workspace）、`owner_id` 和 `section`。默认没有多用户身份鉴权，owner_id 是配置命名空间。

贡献为 `plugin.settings.list/get/set/delete/import`。修改必须提供规范十进制 `expected_revision`，初始修订为 `"0"`。独立进程间的文件锁覆盖读取、CAS 和临时文件原子替换；旧版本、无效内容、超过 1 MiB 或修订冲突均保留原文件。用户和工作区分别落入 users/workspaces。锁等待使用调用原截止点与取消，不重新授予预算。

旧配置导入通过 `sections` 映射提交 JSON，例如 deviceInfo、dynamicSnalysisHooks 和 permissions；不接受任意服务器文件路径，不自动读取旧工程。导入按同一修订事务合并，可先 list 查看结果。

远端旧服务通过部署配置 remote 指定 base_url（以 / 结尾）和专用 headers。remote.load、remote.save 复用 scope/owner_id/section/expected_revision，save 携带 value；配置区限定旧服务十二个公开名称。实际调用 GET get_config/{section} 与 POST update_config/{section}，兼容旧 success/status 两种封套，不传播原始响应错误或凭据。

读取成功按本地修订更新备份；网络或业务失败回退已有备份，source 为 local。远端成功而本地 CAS 冲突时返回 source=remote、backup_updated=false、revision=null；保存另返回 remote_committed=true，明确远端已经写入，不能因备份失败重复保存。旧远端接口没有 CAS，远端与本地不是分布式事务。保存失败不写备份、不自动重试；取消或期限到达不回退成本地成功。响应逐块限制 1 MiB，禁用重定向，所有网络和锁等待使用原截止点。

`remote.save` 另接受可选布尔 `write_local_backup`，省略时沿用本接口默认值 `true`；旧 renderer 的保存函数省略该选项时不写备份，迁移调用应显式传 `false` 保留这一行为。关闭备份仍在 POST 前取得归属锁并校验修订，锁覆盖完整成功响应确认；不会增加本地修订或修改备份内容。成功返回 `remote_committed:true`、`backup_updated:false`、`revision:null`，其中 null 表示本次没有提交本地备份，原修订可由 get/list 取得。该选项不适用于本地写入或远端读取；显式 null、字符串与数字均拒绝。失败、取消和提交未知仍不得自动重试。

保存失败、取消或到期不保证远端未写入。POST 发起后没有取得可交付的完整成功确认时，应按提交状态未知处理，不自动重试；插件清理完成不表示远端事务回滚。请求前的 CAS 冲突或修订耗尽明确不会发送保存请求；完整成功响应中的 remote_committed=true 才表示已确认远端提交，备份状态单独判断。

本地锁按 scope/owner_id 隔离，旧远端服务仅按 section 定位且没有远端 CAS；不同归属或外部客户端仍可能覆盖同一区配置。独立真实宿主专项在 debug/release 各18项通过，覆盖合成服务先写入再断开响应、写入后 HTTP/MCP 取消：本地备份不变、POST仅一次、远端写入仍在，连接关闭和插件排空不等于回滚。该证据不代表真实外部服务，也不证明插件已解析完整成功响应后再取消的窗口。

旧字段语义升级和具体设置 UI 仍需继续迁移。单元测试不能替代真实外部配置服务与旧配置内容验收。

Windows文件事务在受控目录及链接检查后使用规范长路径，避免深层部署目录下首次提交或替换因Win32路径长度失败。原修订/CAS、跨进程锁和原子替换规则不变；真实占用导致替换失败时保留旧文件并回收临时文件。长路径回归包含首次提交、替换、过期修订、取消及禁止删除共享句柄；实际构建和宿主验收结果分别记录，不以单元测试代替部署验证。
