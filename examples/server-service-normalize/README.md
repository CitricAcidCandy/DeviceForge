# 文本规范化服务示例

这是独立原生服务器插件，不在宿主 Cargo 工作区中。只通过公开 SDK/运行库接入协议 6；每次调用复用宿主 Job、截止点、取消与资源监督，不建立常驻服务或 HTTP 旁路。

提供 `example.text.normalize@"1.0"`，映射已有 `normalize` 操作。输入 `{text:string}`，输出 `{text:string}`；规则为去除两端空白并转小写。服务版本是精确字符串，`"1"` 不匹配 `"1.0"`。

由主代理统一安排构建与安装，本轮未执行：

```powershell
cargo build --release --manifest-path examples/server-service-normalize/Cargo.toml
New-Item -ItemType Directory -Force examples/server-service-normalize/bin
Copy-Item -LiteralPath examples/server-service-normalize/target/release/deviceforge-service-normalize.exe -Destination examples/server-service-normalize/bin/
npm pack ./examples/server-service-normalize
```

得到包后走既有插件安装入口，再加载；包内没有宿主可执行路径。`GET /api/v2/services` 观察当前代际，`POST /api/v2/services/example.text.normalize/calls` 传入 `{"version":"1.0","input":{"text":"  FORGE  "}}`，收到 202 Job 后使用原任务查询与取消。

本例与 `server-service-compose` 分别打包、分别装卸。先只加载消费者时，仅其 `compose` 入口不可用；`ping` 应继续可用。消费者加载不要求提供者已在目录中。
