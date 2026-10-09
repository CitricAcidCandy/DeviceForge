# 公开进程插件性能适配器

PluginPerformance 将协议 2 的 ProcessPlugin 适配为 PerformanceProbe；只依赖公开 JSON 样本结构，不要求插件链接宿主内部 crate。清单必须声明 performance.sample_operation 并贡献同名操作，插件不能同时声明产物读写。其他贡献操作仍可通过普通 HTTP / MCP 任务调用。

执行前验证设备 / 包名和插件输入模式；使用与任务相同的独占工作目录、环境去令牌、输出限制和响应关联检查。单次采样另有 10 秒上限，取消或超时丢弃执行 Future，直接子进程沿用 kill_on_drop；完整派生进程树回收仍待实现。

SDK PerformanceSample 显式转换为领域 RawPerformance，拒绝未知字段、无效计数、未经声明的帧窗口和过期样本。样本完成时间只接受宿主当前时间前 60 秒到后 5 秒范围。FPS 窗口 duration_ms 为 1–60000，frames 对应最高 1000 FPS 的边界，source 为最多 80 字节 ASCII 标识符；支持 FPS 的插件可以在本次无观测数据时省略 frame_window。

协议 2 响应 result 是 PerformanceSample，outputs 必须为空；任务层看到的 result / artifacts 包装由适配器解包，再进入现有性能会话持久化。能力查询动态报告插件来源与 FPS 支持，不证明插件的数据准确性。插件仍是管理员可信代码，没有操作系统沙箱或测量真实性验证。

验证：cargo test -p deviceforge-performance-demo-plugin；node scripts/runtime-smoke.mjs --performance-plugin。示例使用 synthetic_demo 合成来源，不是真实设备 FPS。