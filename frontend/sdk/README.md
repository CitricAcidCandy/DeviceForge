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

主入口同时提供 `ApiError`、`JobFailure`、`JobWaitFailure` 和 `readHostError()`。宿主与业务包复用同一错误定义；`ApiError` 保留 `(kind, code, message, status, logId, retryAfter)` 顺序，与 `HostError` 的日志参数位置不同。跨窗口或独立 SDK 副本不能只靠 `instanceof`：用 `readHostError(unknown)` 提取经过检查的公开字段，未知或不可读取的异常返回 `null`，不猜日志。任务错误保留原票据、提交日志及等待原因，不查询任务、不自动重放。

完整 UI 声明引用 React、Radix 和 clsx 的公开类型，包元数据列出相应配套依赖。这些声明依赖不能被偷偷改成宽泛对象；它们也不表示浏览器插件应再打包一份 React。插件构建时将 `react`、`react-dom`、JSX 运行时及 `deviceforge-host` 保留为 external，由宿主提供同一实例。

`extensions.points`、`ui`、`transport` 与 `data` 是 SDK v2 的可选能力，须先检查存在。跨端调用仍有取消、断线和结果未知；本包只提供契约，不在插件中创建另一套运行时、任务执行器或内置 Agent。

可选 `onCleanup` 为已经归属的外部资源提供限时释放回调。`CleanupContext` 只含独立 `signal`、绝对 `deadline` 与可选 `transport.request`；普通请求仍随所属作用域撤销。清理回调返回或超时后入口失效，不可保存后继续调用，也不可借它派发新业务或重放未知写入。调用方按具体资源契约核对释放终态；手动释放和自动卸载共享一次回调，旧失败不封锁独立新操作。

`ui.mount` 另为可选的渲染方法，纯工作区模型可以不提供。外壳插件检查后调用 `await ui.mount(instanceId,target,signal)`，把返回的 `Dispose` 纳入自身清理；该句柄只释放本次挂载，旧句柄不影响新代视图。调用方或提供者撤销会收敛本次挂载，挂载不自动重放业务写入。

数据源可声明 `persistence: 'memory' | 'persistent'`，分别表示内存保存和由提供者负责持久保存；省略表示未声明，不能据此猜测保存方式，也不能把 `applyPolicy: 'immediate'` 当作已经持久保存。

需要再次打包本交付目录时，可以使用标准 `npm pack --ignore-scripts`；本目录没有依赖宿主路径的安装、构建或发布脚本。宿主维护者生成新 SDK 的流程与插件开发流程分开，公开 MCP 指南提供后续能力与生命周期说明。

## 配套的清单纯规则包

`dist/deviceforge-plugin-manifest-0.1.0.tgz` 是另一个独立开发依赖包，不属于 SDK 主包的内嵌运行时。它公开 `normalizeManifest`、市场资料、组件身份包装、发布与依赖纯规则，只依赖 `semver@7.8.5`，不读文件、不联网、不运行宿主。取得实际归档后可在自己的工程安装；未发布 registry，不要求克隆宿主或使用不存在的仓库路径。

当前清单包为 11,918 字节、12 成员，SHA-256 `a92eab466714d671a115d33ba4a0eedb427bfe5e57915970b64493ab3456d18d`。已对真实 TGZ 在独立 NodeNext 工程中核对声明与运行时规范化/身份包装，不代表实际 npm 安装或市场插件安装通过；它也不是可导入市场的业务插件包。
