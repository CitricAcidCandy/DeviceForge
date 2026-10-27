# 文本规范化服务示例

这是独立原生服务器插件，不在宿主 Cargo 工作区中。只通过公开 SDK/运行库接入协议 6；每次调用复用宿主 Job、截止点、取消与资源监督，不建立常驻服务或 HTTP 旁路。

提供 `example.text.normalize@"1.0"`，映射已有 `normalize` 操作。输入 `{text:string}`，输出 `{text:string}`；规则为去除两端空白并转小写。服务版本是精确字符串，`"1"` 不匹配 `"1.0"`。

由主代理统一安排构建与安装，本轮未执行：

```powershell
cargo build --release --manifest-path examples/server-service-normalize/Cargo.toml --target-dir backend/target -j 1
New-Item -ItemType Directory -Force examples/server-service-normalize/bin
Copy-Item -LiteralPath backend/target/release/deviceforge-service-normalize.exe -Destination examples/server-service-normalize/bin/
npm pack ./examples/server-service-normalize
```

得到包后走既有插件安装入口，再加载；包内没有宿主可执行路径。`GET /api/v2/services` 观察当前代际，`POST /api/v2/services/example.text.normalize/calls` 传入 `{"version":"1.0","input":{"text":"  FORGE  "}}`，收到 202 Job 后使用原任务查询与取消。

本例与 `server-service-compose` 分别打包、分别装卸。先只加载消费者时，仅其 `compose` 入口不可用；`ping` 应继续可用。消费者加载不要求提供者已在目录中。

## 组合验收与可选标记

本例不在后端 workspace；必须显式构建，不能认为后端工作区构建已包含它。debug 构建去除 `--release`，仍共享 `backend/target`，由主代理与宿主/另一示例串行执行。两个示例及宿主构建完成后，运行 `node backend/scripts/service-composition-smoke.mjs`，发布模式加 `--release`。脚本消费已有程序并直接封装本轮 TGZ，无需先生成本例 `bin/` 或执行 npm。完整命令及矩阵见 [组合验收说明](../../backend/scripts/service-composition/README.md)。

默认无参数时业务行为不变。只有管理员显式传入 `--smoke-directory <已存在绝对目录>` 时，才记录请求 ID、PID、开始/结束与取消状态；不记录输入。该目录存在 `hold` 文件时，规范化等待最多六十秒并服从原 InvocationContext 的取消及截止点，供验收确定父子进程均已启动后再取消/卸载。目录仅由本轮部署参数传入，不接受业务请求指定服务器路径。

标记只是处理器证据，不替代协议清理确认和 OS 退出。当前仅做源码/静态检查交接，没有执行这两个独立 crate 的 Cargo 构建或 debug/release 真实组合验收。
