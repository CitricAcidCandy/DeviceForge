# 终端业务插件

通过公开协议5打开一个部署profile，使用同一真实工具进程持续收发原字节。原管道打开保持兼容；新增Windows ConPTY完整交互模式和resize。完整合同见 [完整交互终端实施裁定](../../docs/implementation/完整交互终端实施裁定-20261022.md)。

`manifest.json`声明唯一会话贡献 `plugin.terminal.open`，普通operations为空。Windows默认档案为 `powershell`，打开业务为 `{"profile":"powershell"}`，进入Windows PowerShell普通命令行，可执行 `cd`、`dir`、`echo` 等命令。固定启动参数跳过用户启动脚本、保持交互，并将标准输入、输出和外部程序输入设为UTF-8，供页面按UTF-8收发中文。

profile只选择部署者定义的程序、固定argv及可选工作目录。配置通过宿主保存到用户目录；没有宿主管理配置时兼容旁置 `terminal.config.json` 和 `--config`绝对路径，示例见 `terminal.config.example.json`。已有用户档案不会因默认模板更新被覆盖；需要切换时，在配置中新增 `powershell` 后从页面选择，已打开的会话仍保持原程序。非Windows部署者应将默认档案改为本机可用shell，例如 `/bin/sh` 配合 `["-i"]`；当前示例明确用于Windows。

完整交互打开为 `{"profile":"powershell","terminal":{"protocol":"deviceforge.terminal.v1","cols":120,"rows":30}}`。随后每个输入块都是独立UTF-8 JSON：`{"type":"input","text":"原始按键或粘贴文本"}` 或 `{"type":"resize","cols":120,"rows":30}`。列20至500、行5至200，拒绝未知字段和拼接/不完整消息。PTY输出保留ANSI、光标、颜色和终端查询，stdout/stderr在原生控制台合并；网页使用终端模拟器消费，不按行重排。方向键、Tab和Ctrl+C直接发送相应字节。

无terminal字段仍是原管道模式；Windows CMD在UTF-8代码页下读取管道中文存在提前退出问题，因此保留PowerShell默认档案。PTY模式只在当前合格Windows实现可用，其他系统明确返回不可用，不静默改为管道。

单块8192字节、通道8、累计输入1 MiB、双路合计输出16 MiB。输出保留UTF-8、非法UTF-8和零字节；EOF关闭工具stdin，取消仍可停止会话。所有行为消耗原截止点，取消、期限和背压不重新授予业务预算。工具使用Restricted环境，输入、配置和原始输出不进入生产诊断日志。

旧配置 `resource_scope:direct_process`继续兼容：原管道模式只承诺直接工具进程和管道。PTY模式额外使用出生归属Job的整个本地进程树监督，关闭须确认Job空、直接进程退出、PTY关闭和输出排空；未确认保留Failed。EOF在PTY模式表示关闭会话，键盘Ctrl+D仍作为原字节传递。该范围不能证明远端副作用已撤销，配置不是沙箱。

新增回归覆盖严格打开与控制消息，公共工具库另以真实Node TTY检查原字节、ANSI、resize、自然根进程退出后的子进程回收、取消、未读输出、Drop和启动失败。编译、专项执行、独占宿主HTTP及真实浏览器验证由主代理统一协调并记录实际结果；未执行的测试和跨平台能力不计验收完成。
