# DeviceForge 插件 SDK

当前交付为 `@deviceforge/plugin-sdk@0.1.0` 的本地 TGZ 包，公开上下文保持 SDK v2。本包尚未发布到 npm registry；不要把包名当作可在线下载的发行地址。

取得实际交付的 `deviceforge-plugin-sdk-0.1.0.tgz` 后，在自己的独立插件工程执行：

```powershell
npm install --save-dev ./deviceforge-plugin-sdk-0.1.0.tgz
```

包已包含 ESM 和 `.d.ts`，不需要宿主源码、宿主构建工具或宿主生成器。离线环境先准备 `peerDependencies` 中明确列出的类型配套依赖；不要使用 `--legacy-peer-deps` 隐藏缺失依赖后把类型检查失败归因于 SDK。

```typescript
import type { HostContext, WebPlugin, PointRef } from '@deviceforge/plugin-sdk';
import { isJsonValue } from '@deviceforge/plugin-sdk/json';

const point: PointRef = { id: 'sample.tools', version: '1' };

export default {
  id: 'sample', version: '1.0.0', apiVersion: 2, panels: [],
  async activate(context: HostContext) {
    const points = context.extensions?.points;
    if (!points) throw new Error('当前宿主未提供开放扩展点');
    points.define({ ...point, title: '插件工具' });
    points.contribute({ id: 'sample.action', point, data: { title: '运行检查' } });
  },
} satisfies WebPlugin;
```

主入口导出公开上下文、扩展点、工作区、通信与数据源契约；`json` 子入口提供运行时 JSON 守卫。`HostError`、槽位标识辅助函数及 `hostUi()` 为轻量 ESM 辅助，不内联 React、Cordis 或宿主实现。`hostUi()` 只读取运行宿主已经提供的界面套件，在普通网页或 Node 环境调用会明确报错。

完整 UI 声明引用 React、Radix 和 clsx 的公开类型，包元数据列出相应配套依赖。这些声明依赖不能被偷偷改成宽泛对象；它们也不表示浏览器插件应再打包一份 React。插件构建时将 `react`、`react-dom`、JSX 运行时及 `deviceforge-host` 保留为 external，由宿主提供同一实例。

`extensions.points`、`ui`、`transport` 与 `data` 是 SDK v2 的可选能力，须先检查存在。跨端调用仍有取消、断线和结果未知；本包只提供契约，不在插件中创建另一套运行时、任务执行器或内置 Agent。

`ui.mount` 另为可选的渲染方法，纯工作区模型可以不提供。外壳插件检查后调用 `await ui.mount(instanceId,target,signal)`，把返回的 `Dispose` 纳入自身清理；该句柄只释放本次挂载，旧句柄不影响新代视图。调用方或提供者撤销会收敛本次挂载，挂载不自动重放业务写入。

数据源可声明 `persistence: 'memory' | 'persistent'`，分别表示内存保存和由提供者负责持久保存；省略表示未声明，不能据此猜测保存方式，也不能把 `applyPolicy: 'immediate'` 当作已经持久保存。

需要再次打包本交付目录时，可以使用标准 `npm pack --ignore-scripts`；本目录没有依赖宿主路径的安装、构建或发布脚本。宿主维护者生成新 SDK 的流程与插件开发流程分开，公开 MCP 指南提供后续能力与生命周期说明。
