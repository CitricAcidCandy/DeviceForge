# 前端文档导航

按用途查找文档。新增文档放入对应类别，并在本页补入口；新设计稿和图片放在 `design_docs/`，`design/` 保留历史稿件。

| 目录 | 内容 |
| --- | --- |
| `guides/` | 开发手册、工程规则与部署说明 |
| `contracts/` | 对外接口、协议与消费契约 |
| `implementation/` | 设计方案、实施裁定与迁移接缝 |
| `verification/` | 验收矩阵、测试记录与来源证据 |
| `design/` | 产品设计稿、视觉规格和图片资源 |

## 开发手册

- [插件开发](guides/插件开发.md)
- [插件开发者快速开始](guides/插件开发者快速开始.md)
- [产品界面依赖与组件来源](guides/产品界面依赖与组件来源.md)
- [架构与开发约束](guides/架构与开发约束.md)
- [静态分发与访问](guides/静态分发与访问.md)
- [前端目录与组件约束](guides/前端目录与组件约束.md)
- [前端运行架构](guides/前端运行架构.md)
- [主题插件与宿主样式](guides/主题插件与宿主样式.md)

## 接口与协议

- [安卓APKS安装公开接口消费合同](contracts/安卓APKS安装公开接口消费合同.md)
- [产物配额消费边界](contracts/产物配额消费边界.md)
- [交互终端公开接口消费边界](contracts/交互终端公开接口消费边界.md)
- [平台适配器迁出边界](contracts/平台适配器迁出边界.md)
- [普通操作总期限消费契约](contracts/普通操作总期限消费契约.md)
- [任务历史与事件公开接口裁定草案](contracts/任务历史与事件公开接口裁定草案.md)
- [任务历史与事件公开接口第一批裁定](contracts/任务历史与事件公开接口第一批裁定.md)
- [日志ID与接口消费](contracts/日志ID与接口消费.md)
- [剩余迁移接口消费清单](contracts/剩余迁移接口消费清单.md)
- [统一发现发布回执消费边界](contracts/统一发现发布回执消费边界.md)
- [投屏直播消费契约](contracts/投屏直播消费契约.md)
- [Android Unicode输入消费合同](contracts/Android Unicode输入消费合同.md)
- [Harmony截图产物消费边界](contracts/Harmony截图产物消费边界.md)
- [Harmony设备插件公开接口消费合同](contracts/Harmony设备插件公开接口消费合同.md)
- [MCP目录消费契约](contracts/MCP目录消费契约.md)

## 设计与实施

- [插件生命周期与功能级服务组合](implementation/插件生命周期与功能级服务组合.md)
- [插件槽位与路由可靠性](implementation/插件槽位与路由可靠性.md)
- [共享 UI 入口生成与测试串行](implementation/共享UI入口生成与测试串行.md)
- [安卓安装截图产物消费接缝](implementation/安卓安装截图产物消费接缝.md)
- [插件产物传输第一批裁定](implementation/插件产物传输第一批裁定.md)
- [产品界面实施方案](implementation/产品界面实施方案.md)
- [非设备长任务消费方案](implementation/非设备长任务消费方案.md)
- [服务器插件生命周期消费](implementation/服务器插件生命周期消费.md)
- [工具来源缓存消费](implementation/工具来源缓存消费.md)
- [旧操作绑定迁出接入](implementation/旧操作绑定迁出接入.md)
- [任务历史与事件插件接入示例](implementation/任务历史与事件插件接入示例.md)
- [设备能力与插件面板](implementation/设备能力与插件面板.md)
- [设备提供者第一阶段实施](implementation/设备提供者第一阶段实施.md)
- [设备原始状态接入方案](implementation/设备原始状态接入方案.md)
- [性能会话动态提供者消费方案](implementation/性能会话动态提供者消费方案.md)
- [在线插件与开放扩展](implementation/在线插件与开放扩展.md)
- [中后台工作台布局](implementation/中后台工作台布局.md)
- [Android调用栈火焰图](implementation/Android调用栈火焰图.md)
- [Android指标部分缺测消费](implementation/Android指标部分缺测消费.md)
- [TypeScript维护源码迁移裁定](implementation/TypeScript维护源码迁移裁定.md)

## 验收与证据

- [安卓安装截图浏览器验收记录](verification/安卓安装截图浏览器验收记录.md)
- [安卓设备插件第一批消费核对](verification/安卓设备插件第一批消费核对.md)
- [产品界面验收](verification/产品界面验收.md)
- [当前源码门禁记录](verification/当前源码门禁记录.md)
- [局域网插件加载复验说明](verification/局域网插件加载复验说明.md)
- [平台插件迁出消费验收矩阵](verification/平台插件迁出消费验收矩阵.md)
- [任务历史浏览器验收记录](verification/任务历史浏览器验收记录.md)
- [三业务消费验收说明](verification/三业务消费验收说明.md)

## 设计稿与图片

新设计稿一律放 `design_docs/<日期>-<功能名>/`（可编辑源文件 + PNG 预览 + 中文说明）；`design/` 下为 2026-10-26 之前的历史稿件，不再新增。

### 新稿件：design_docs

- [设置界面 · V5 视觉规格与交付](design_docs/2026-10-27-设置界面/设置界面-V5-视觉规格与交付.md)（根据“AI 味太重”反馈改为连续工作面与 36px 控件；默认态与失败整页，等待确认，不是前端实现）
- [设置界面 · V4 历史交付](design_docs/2026-10-27-设置界面/设置界面-V4-视觉规格与交付.md)（用户否定风格，保留原图层与历史，不作为选定实施稿）
- [设置界面 · 旧视觉探索说明](design_docs/2026-10-27-设置界面/设置界面-视觉探索说明.md)（保留被否定方向与此前生图失败历史，不作为 V4 实施依据）
- [数据分析界面 · 视觉规格与差异](design_docs/2026-10-26-数据分析/数据分析界面-视觉规格与差异.md)（预览图 `数据分析界面-1424x805.png`；源文件 Ardot `740621490972341` 节点 `2:1`）
- [插件接管态 · 视觉规格与差异](design_docs/2026-10-26-插件接管态/插件接管态-视觉规格与差异.md)（V5-01~06：设备页整页接管、右栏应用面、三种状态条、设置插件卡、市场槽位对账、侧栏插件分组）

### 历史稿件：design

- [产品页面接口清单](design/2026-10-14/产品页面接口清单.md)
- [产品页面视觉规格](design/2026-10-14/产品页面视觉规格.md)
- [产品页面视觉验收](design/2026-10-14/产品页面视觉验收.md)
- [独立站新版设计与交互方案](design/2026-10-14/独立站新版设计与交互方案.md)
- [界面方向与交互方案](design/2026-10-14/界面方向与交互方案.md)
- [首页精修与工坊内页](design/2026-10-14/refinement-v3/首页精修与工坊内页.md)
- [visual-audit-v4](design/2026-10-14/refinement-v3/visual-audit-v4.md)

