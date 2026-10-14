# Android 指标部分缺测消费

日期：2026-10-13。实现模式：架构先行。本文记录已冻结的前端消费合同和本批门禁证据；后端生产诊断分类及设备采集资格由所属后端模块负责。

## 职责与落点

| 文件 | 职责 |
| --- | --- |
| [共享缺测规则](../../src/services/api/metric-missing.ts) | 以纯函数检查未知输入中原值与 CPU、内存缺测诊断的精确对应，供两个功能分别调用 |
| [会话结果消费](../../src/features/performance/utils/results.ts) | 在公开样本页入口连接共享规则，继续沿原规则检查时间、进程、FPS、帧窗口和设备观测 |
| [Profile 原始类型](../../src/features/android-profile/types/index.ts) | 保留进程累积计数，消费生成契约中的缺测对象，系统计数、核数和 PSS 使用可空类型 |
| [Profile 原始资格](../../src/features/android-profile/utils/metrics.ts) | 连接共享原始值规则，保留原字段白名单、身份、进程计数及观测资格 |
| [Profile 派生资格](../../src/features/android-profile/utils/derived.ts) | 保持派生版本 1 的固定八字段合同，并检查当前与紧邻前驱的 CPU 基线资格 |
| [缺测回归](../../tests/android-metric-missing.test.ts) | 通过公开分页、原始资格和归档索引入口验证兼容、拒绝和恢复链路 |

两个功能分别依赖 shared，没有互相导入。共享规则没有设备、文件、网络或时钟副作用。前端校验服务器的真实结果，不填零、不沿用上一样本，也不重新计算并替换服务器的派生值。

## 生成契约与值联动

会话读数继续直接索引生成的 PerformancePage.readings 项。ProfileMetricMissing 也索引该项的 metric_missing，未复制缺测 DTO。ProfileMetrics 的 system_ticks、logical_cpus、pss_kib 为 number 或 null，process_ticks、pid 和 process_start_ticks 的原资格保持不变。

缺测诊断版本必须为 1。每项原因包含 source、access、reason：source 是 1 至 80 字节稳定 ASCII 标识，字符限字母、数字、点、下划线和连字符；access 限 adb_shell 或 root_shell；reason 限 permission_denied 或 unsupported。空容器、两项均无真实原因、未知版本、额外字段和非法枚举均拒绝。

| 消费对象 | CPU 缺测资格 | 内存缺测资格 |
| --- | --- | --- |
| Profile 原始指标 | system_ticks 与 logical_cpus 均为明确 null，并有 cpu 原因 | pss_kib 与 rss_kib 均为明确 null，并有 memory 原因 |
| 会话派生读数 | logical_cpus 为明确 null，两种 CPU 百分比同时为 null，并有 cpu 原因 | pss_kib 与 rss_kib 均为明确 null，并有 memory 原因 |

值与原因双向对应：健康数值不能附带对应缺测原因，空值不能缺少原因，单边空值和矛盾组合均拒绝。CPU 与内存允许分别缺测或同时缺测；其余合格的 FPS、设备环境、原窗口和归档帧继续保留原值。

## 旧 JSON 与 null 兼容

metric_missing 省略或显式 null 时，按照健康旧记录的数值资格消费。健康旧 Profile 仍要求有效系统计数、核数与 PSS；RSS 保持原有可省略或为 null 的兼容性，不把历史 RSS 缺值重新解释为内存缺测。

存在真实缺测诊断时，健康的另一项允许在诊断中省略或为 null。只有 api_version，或 cpu 与 memory 均省略或为 null 的对象，仍不合格。前端保留旧记录的省略状态，不补诊断、不补 RSS，也不从当前设备目录补写历史内容。

## CPU 连续基线

ProfileDerived 继续保留 api_version、cpu_share_percent、cpu_core_percent、cpu_reason、fps、fps_reason、battery_net_power_mw、battery_reason 八个固定字段。缺失当前或紧邻前驱的系统计数、核数时，两种 CPU 百分比必须为空；缺测原因仍要求有限非空文本。

有效 A → CPU 缺测 B → 恢复 C → 连续有效 D 的序列中，B 不提供百分比，C 只建立新基线，D 才恢复百分比。既有归档索引入口调用更新后的相邻资格函数，拒绝 C 跨 B 使用 A 的计数。进程换代、时间不递增、计数回退、系统跨度为零、核数变化及进程增量超过系统增量继续拒绝有效百分比。只有内存缺测时，不中断合格 CPU 差分。

## 本批新增回归

android-metric-missing.test.ts 的以下八项均在本批日志中逐名出现通过标记，单文件退出码为 0。

1. 健康旧页与旧档案兼容RSS省略或null，缺测诊断省略或显式null不反填。
2. CPU与内存可各自缺测或同时缺测，保留原FPS、环境、窗口及归档帧。
3. 缺测对象允许省略或null的健康项，保留Root通道与稳定来源边界。
4. 缺测诊断拒绝空容器、未知版本字段、非法来源权限原因和缺少诊断。
5. 原始值与缺测原因必须双向吻合，拒绝单边空值及非明确null。
6. 独立缺测不放宽身份、进程计数、有效内存、时间、帧和设备观测资格。
7. 有效到缺测再恢复的相邻CPU基线中断，恢复首样为空而下一有效样本恢复。
8. 只有内存缺测时CPU连续差分仍可消费，FPS电池及帧保持合格原值。

## 本批独立门禁统计

证据批次：android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b。主代理执行生成器与完整门禁；前端角色只读核对原始记录并独立统计，没有重复启动检查或服务。

| 门禁 | 实际证据 |
| --- | --- |
| API 生成 | 退出码 0；仅 generated.ts 变化，SHA-256 为 f50bf97498721ecb06bfd01e11db5b6fb26846b39057c2b20f66e3040947862c |
| 完整前端检查 | 包含架构、Svelte 与 TypeScript 无产物检查；原门禁进程 62352 最终退出码 0 |
| 架构 | 214 个源码文件，依赖方向、循环及网络边界检查通过 |
| Svelte | 0 错误、0 警告 |
| 全前端测试 | 69 个测试文件发现、执行、通过，失败文件 0；独立累加 69 份摘要得到 625 项测试、625 通过、失败 0、取消 0、跳过 0、待办 0 |
| 新缺测回归 | 八项逐名通过，单文件退出码 0 |
| 生产构建 | Vite 转换 209 个模块并完成构建，日志记录构建耗时 197 毫秒 |
| 维护输入 | 冻结与门禁后清单各 342 行、342 个唯一路径；逐路径比较 SHA-256 与字节大小，新增、删除、变化均为 0 |

原始证据入口：

- [完整前端门禁日志](../../../artifacts/android-partial-frontend-gates.log)。
- [生成变化记录](../../../artifacts/android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b/generation-delta.json)。
- [冻结维护输入](../../../artifacts/android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b/frontend-inputs-frozen.jsonl)。
- [门禁后维护输入](../../../artifacts/android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b/frontend-after-gates.jsonl)。
- [原进程退出记录](../../../artifacts/android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b/frontend-run-exit.json)，时间为 2026-10-13 21:19:37（北京时间）。
- [前端实现写前写后摘要](../../../artifacts/android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b/frontend/after.json)及同目录原件。

本说明文档在门禁后新增，不属于上述 342 项维护输入，不改变源码或生成契约。输入差异为 0 的结论适用于冻结清单与门禁后清单之间的同批范围。

## 验证边界

本批前端证据覆盖消费资格、纯规则、归档索引回归、静态检查和生产构建。测试使用合成数据及帧描述，不证明真实手机、真实 Root、浏览器媒体呈现、产品界面、视觉效果或设备性能。具体业务 UI、真机精度与性能专项仍需各自独立证据。
