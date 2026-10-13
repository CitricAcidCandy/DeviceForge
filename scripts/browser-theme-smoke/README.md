# 浏览器主题插件独立验收

主代理先完成前端严格检查与构建，以及当前后端同模式构建，再在根目录执行：

```powershell
node scripts/browser-theme-smoke.mjs
node scripts/browser-theme-smoke.mjs --release
```

驱动只启动自己的临时 Rust 服务、Vite 代理和隐藏浏览器，复用公开生产 `plugin-host.js` 及构建后的 `browser-theme-harness.js`。页面通过真实 HTTP 上传三份浏览器包，不直接登记内存插件对象，不接入产品路由。

矩阵覆盖无主题目标时的公开目录与精确错误、静态和动态主题、变量与 `color-scheme` 的 inline `important`、真实 computed CSS、显式选择、多提供者、释放与卸载恢复、激活失败回滚、子作用域及旧代入口和订阅撤销、新代相对模块加载、监听器异常及运行时销毁恢复。基线原值和 priority 在报告中保留。

主代理统一运行，脚本本身不安装依赖、不生成接口、不构建源码。每次报告写入唯一 `artifacts/browser-theme-smoke-<profile>-<run_id>/report.json`，成功和失败都保留临时目录原件的独立大小与摘要；宿主退出、端口释放及关键输入前后身份由已有独立验收工具核对。最终销毁组有意保留已停用的主题部署，报告原件中可查；部署删除与运行时清理分别验证。

本验收不提供产品界面、截图视觉、真机、另一局域网主机或容量性能结论。主题 CSS 按可信插件运行，节点属性不是断言依据。
