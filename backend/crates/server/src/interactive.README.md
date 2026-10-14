# 持续会话HTTP与MCP边界

`interactive.rs`定义边界请求和确认类型，`interactive_routes.rs`装配v2路由，`interactive_mcp.rs`提供管理工具及动态插件会话工具，`interactive_openapi.rs`从同一Rust类型生成公开模式。

HTTP提供session-definitions、sessions、详情/删除、输出、输入、EOF及取消。打开返回202及Opening记录，输入确认只表示有序准入，取消返回当前状态；终态区分业务与资源清理。业务路径不选择服务器程序，普通Job仍沿原接口。

MCP工具目录在同一个注册快照中读取普通操作和会话贡献，插件加载、卸载与重载后重新tools/list即可取得当前目录，旧修订分页拒绝。插件会话操作按自身完整ID打开，返回会话ID；后续通过通用会话工具输入、读取、EOF和取消。浏览器插件不自动成为服务器工具，当前没有主动工具列表变化通知。

成功/失败HTTP响应与MCP结果复用现有日志关联层，不另造日志ID，不记录业务字节。输出是JSON中的原字节数组及真实序号，不冒充UTF-8文本或模型token流。输出页长1至100，输入单块8192字节；实际限额由应用用例统一执行。

具体方案见 `backend/docs/implementation/宿主交互会话实施.md`。本模块存在不表示真实协议、网络服务、浏览器和正式分发已验收。
