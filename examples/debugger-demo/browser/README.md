# 浏览器组件

这是可直接上传的 SDK v2 原生 ESM 插件，入口 `src/index.js` 默认导出公开 `WebPlugin` 对象。没有运行时 importmap、React、npm 包或宿主类型路径依赖；所有导入都在本包内。SDK 指这里消费的公开对象接口，不要求另取 SDK 开发包。

提供面板、`developer.tools` 追加组件、`/echo` 自有模块、该模块页面的 replace 组件、浏览器回显服务 `demo.debugger.browser.echo@1` 和服务器回显命令。贡献 ID 各不相同。模块路由由宿主命名空间隔离，替换槽位 `page.demo.debugger.browser.echo` 属于本插件；不会替换设备或设置业务。模块和 replace 组件分别是该页可选择的贡献，不保证同时挂载。实际可用槽位及挂载结果以部署者发行版为准。

挂载只生成无样式的语义 HTML 功能样例；按钮只提交配套纯回显操作。`context.debug` 为可选接口，缺少时基本功能和清理照常执行。每次挂载单独登记语义状态节点、挂载/提交/成功事件，以及监听与等待资源；资源同时通过公开 `context.onDispose` 管理。不创建心跳或后台服务，不把消息正文记入调试元数据。

`src/debugger-client.js` 是自己的开发工具可以导入的公开服务消费示例，包含回执检查和 UI 冻结快照续页。它不会自动启动调试或选目标。完整使用步骤见随独立工程交付的根 README；本组件安装后仍需由宿主挂载，不能将 `index.js` 当作独立网页启动。

如只需要本组件，在本目录执行 `npm pack --ignore-scripts`；也可在独立工程根执行 `npm run pack` 生成 ZIP。前者的 TGZ 由 npm 生成标准 `package/` 外层。宿主不会运行构建或安装脚本。
