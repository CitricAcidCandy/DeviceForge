# Android Root 与采样画面独立验收

本目录是独立真实服务驱动的准备写集。已通过的 FPS、设备电气/温度验收不重跑，不修改其入口、生产源码或证据。当前尚未冻结远端命令和画面媒体合同，未编译本批假 ADB、未启动本批实服，不计业务验收完成。

## 已准备

- `protocol.mjs` 独立按 Android 官方 `cmd_report_sample.proto` 编码 SIMPLEPERF 原字节，不导入生产解析器。黄金样本先于线程/符号表、时间乱序且含等时间双样本；未知符号为 int32 -1，调用链叶到根，丢样计数为 2。
- `downloads.mjs` 从公开产物详情与 content 下载校验大小和 SHA-256，有界流读、每次最多 4096 字节保存；固定产物名由最终合同确认。
- `zip.mjs` 独立核验 Stored ZIP 的 local/central/EOCD、CRC、实际大小、唯一名称、条目不重叠且无隐藏字节；最终归档所需文件和关联在业务场景中进一步核验。
- 三份模块 Node 语法退出 0；黄金一像素 PNG 的 IHDR/IDAT/IEND CRC 已核；已有 Stored ZIP 样本读取成功。这些只证明夹具准备，不证明后端业务。

## 等待冻结

- Root 资格为 none/adbd_root/su；su 成功、拒绝和无 Root 不阻断普通指标录制。stack_status 为 captured/unavailable，stack_reason 为空或固定理由，具体字面与无栈产物组成待后端交接。
- 单远端监督单元与 simpleperf 子进程的固定 argv/脚本、原 PID/starttime/UID、绝对期限、退出回执及清理，取消/卸载时必须证明原进程已退出且自有目录已清理。
- 用户最新要求为 scrcpy 连续流、按采样选 PTS 邻帧；不再冻结逐次 screencap 路由。时钟映射、解码与时间区间边界由主代理核定。
- 前端工厂及实际产物联合消费完成后复制冻结，通过 HTTP/MCP、Job 和真实下载字节校验历史、新代与身份。

## 证据边界

合成原字节和原生假 ADB 不替代 Root 真机、Android/OEM、实际游戏、scrcpy 实际采集、符号包或页面视觉验收。PNG 黄金只核原字节与关联，不据此作视觉结论。功能验收不提供容量、采集开销、压测或性能优化结论；性能专项按用户要求延后。
