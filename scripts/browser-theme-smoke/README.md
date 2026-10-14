# 主题浏览器验收驱动

本目录只管理主题验收夹具、浏览器连接、冻结输入和原件保留。生产主题实现与原八项业务断言属于前端；本驱动不修改这些行为，也不修改公共 `scripts/browser-driver.mjs`。

## 职责

- `fixtures.mjs`：构造真实上传的可信主题包。
- `inputs.mjs`：解析单次验收参数，逐字核对冻结清单及全部 ES 模块。
- `driver.mjs`：持有自有隐藏浏览器原句柄，记录阶段、PID、有界诊断、退出和调试端口收口。
- `cdp.mjs`：连接 CDP，管理有界请求与断连失败传播；默认命令期限保持原驱动的 30 秒。
- `evidence.mjs`：保留本次业务原件并逐字建立索引。

## 执行

默认入口使用当前 debug 宿主和 `frontend/dist/assets`，`--release` 选择 release 宿主。显式冻结输入从指定目录的 `identity.json` 读取受检宿主及 ES 模块；清单模式须与命令模式一致，全部受检文件前后须保持原字节。

```powershell
Set-Location -LiteralPath 'G:\Rust\DeviceForge'
node scripts/browser-theme-smoke.mjs '--frozen-input=G:\Rust\DeviceForge\artifacts\theme-current-inputs-ff2dad2d-fa3c-43a2-a2c9-95435e657d53' --in-process-gpu
```

`--in-process-gpu` 只改变本次 headless 测试浏览器的 GPU 运行方式，不修改 Codex 或 Windows 权限。它针对已记录的 GPU 辅助子进程权限拒绝；不代表默认 GPU 路径、产品视觉或性能已通过。未提供该参数时保持原 headless 启动参数。

## 证据与当前边界

真实业务通过依据为终态报告的 `browser.checks` 原八项、正常退出以及输入身份复核。顶层 `checks`、参数检查、语法检查、最小连接探针和正常宿主退出均不能替代八项结果。

2026-10-14 最后一个探针在相同浏览器、相同进程内 GPU 参数和恢复原 30 秒期限后，仍在 `Runtime.enable` 超时，最小 `1+1` 和主题八项未执行。原浏览器与 Node 进程均已退出，调试端口释放；诊断与最新缺口见 [主题文档](../../frontend/docs/主题插件与宿主样式.md) 和 [原始终态](../../artifacts/browser-theme-connection-probe-9f43fb0e-4ef4-4da9-a21b-61e0ee8e5992/report-restored-30s.json)。后续需在能执行页面 Runtime 的正常环境使用同一冻结输入验收，不自动循环浏览器或参数。
