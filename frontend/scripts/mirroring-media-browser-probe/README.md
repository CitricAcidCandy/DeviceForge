# 投屏原生媒体浏览器探针

本探针独立启动真实 Edge、临时本机 Vite 源码服务和专属浏览器配置目录，直接导入当前冻结的 browser-sink。它不修改产品页面、生成类型、生产构建入口或冻结媒体逻辑，不运行性能测试。

在 frontend 目录执行：

```powershell
node scripts/mirroring-media-browser-probe.ts
```

可选 DEVICEFORGE_TEST_BROWSER 指定 Edge 可执行文件。默认采用现有独立浏览器验收的 headless 与 disable-gpu 模式，核对软件媒体功能；不据此宣称硬件加速能力。可选参数 --in-process-gpu 只用于本次专属进程的受限令牌诊断，实际启动参数完整记录于报告，不修改用户浏览器设置。

## 真实验证规则

- 查询原生 VideoEncoder/VideoDecoder 的 H264 配置支持；编码器从 64×64 红绿画布产生真实 Annex B 关键帧和差分帧，不使用 DFML 假字节或模拟解码器。
- 从实际编码包提取 SPS/PPS，与关键帧分开交给当前 browser-sink。检查首关键帧前差分帧忽略、原生解码尺寸和微秒 PTS、真实像素、交付后 VideoFrame 关闭、新连接重新配置及取消后晚到帧拒绝。
- 真实 AudioContext 经 CDP 用户激活运行，使用原生音源、AudioBuffer 和 AnalyserNode 验证 PCM16 双声道转换、实际音频图处理、取消/重置/销毁的停止与断开。GainNode 静音，仅证明内部调度与资源回收，不证明扬声器听觉或产品自动播放规则。
- 音频观测仅包装真实节点的方法并调用其原实现，不替换 AudioContext，不返回假节点。共享上下文由探针拥有并最终关闭，sink 自己只回收音源。
- 每轮独立 artifacts/mirroring-media-browser-* 目录记录报告、实际版本/参数、原始编码媒体、源码字节与 SHA256 前后稳定性，以及专属进程终态；页面和服务器最终关闭。

## 当前证据边界

2026-10-13 当前 managed 执行令牌中，Edge 155.0.4283.45 已启动并可取得 Browser.getVersion；新标签在 Runtime.enable 前返回 CDP -32000 Target crashed。默认软件模式启动日志同时出现 GPU 子进程退出码 -1073741790（0xC0000022 拒绝访问）和 GPU process isn't usable；进程内 GPU 模式没有 GPU 子进程错误，但标签仍崩溃。

实际失败报告分别为：

- artifacts/mirroring-media-browser-2026-10-13T04-47-14-364Z-5c4b0d2d-3735-4945-9060-d89c64322359/report.json：默认软件模式，browserExited=true、inputsStable=true。
- artifacts/mirroring-media-browser-2026-10-13T04-49-44-966Z-e532130c-d94d-43e4-bf80-6209adf3b7f9/report.json：进程内 GPU 模式，browserExited=true、inputsStable=true。

这两份报告只证明当前环境无法建立媒体执行上下文；WebCodecs/WebAudio 支持查询、真实 H264 解码、PCM 图调度未执行，不能判定编解码器不支持，也不能写成播放通过。需在能正常创建 Edge 标签的执行环境复跑同一探针。已有定点测试证明的纯规则和模拟生命周期保持独立，不代替该原生媒体证据。

首次导航/收口诊断失败报告同样保留，其中一轮未通过 browserExited 终态门禁；之后对应专属调试端口已不可连接，未按旧 PID 终止其他或系统进程。最终两轮均明确回收。
