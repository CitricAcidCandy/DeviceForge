# 浏览器插件独立构建工具

`@deviceforge/plugin-tools@0.1.1` 提供 `buildBrowserPlugin()`，将一个独立插件工程编译成可在 DeviceForge 加载的 ESM、延迟模块和资源，并提供从单清单生成服务契约的 `generatePluginContracts()`。工具不依赖宿主源码，不执行工程的 Vite、PostCSS 配置，不修改插件源码，也不代替清单打包或注入插件身份。

当前只有本地 TGZ 发行渠道，未发布到 registry。分发时必须同时交付 `deviceforge-plugin-tools-0.1.1.tgz`，不能只提供包名或虚构下载地址。旧 `0.1.0` 归档保留为历史制品，不包含契约生成入口。安装时还需从自己的依赖渠道提供包内声明的 Vite、React 构建插件、Tailwind 和 Rolldown 依赖；本地验证复用已安装的真实工具链，没有重新联网安装。

```powershell
npm install --save-dev .\deviceforge-plugin-tools-0.1.1.tgz
```

要求 Node.js 22.18 以上。实际使用的工具链固定为 Vite 8.3.3、`@vitejs/plugin-react` 6.1.2、Tailwind 与 `@tailwindcss/vite` 4.3.3、Rolldown 1.2.13。

## 公开接口

```ts
import { buildBrowserPlugin } from '@deviceforge/plugin-tools';

const result = await buildBrowserPlugin({
  root: process.cwd(),
  outputDir: './dist',
  // 默认依次选择 src/index.ts、src/index.tsx，也可显式提供工程内入口。
  entry: './src/index.tsx',
  dependencies: {
    // 可选：精确的公开说明符 → 已解包发行物中的绝对模块路径。
    // 普通 node_modules 依赖不需要重复提供。
  },
  theme: '@custom-variant dark (&:where(.dark, .dark *));',
  signal: new AbortController().signal,
});

console.log(result.entryFile, result.buildId);
```

## 从单清单生成服务契约

`generatePluginContracts(manifest)` 从单一 `manifest.json` 的服务器服务声明生成前后端共用的 TypeScript 源码。开发者在自己的工程里执行，不读取宿主源码，不执行宿主生成器；输入清单保持不变，函数也不写文件。

```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { generatePluginContracts } from '@deviceforge/plugin-tools';

const manifest: unknown = JSON.parse(await readFile('./manifest.json', 'utf8'));
const generated = generatePluginContracts(manifest);
await writeFile('./shared/service-contracts.ts', generated.source, 'utf8');
console.log(generated.services);
```

调用方负责创建自己的 `shared/` 目录。返回的每项服务元数据包含 `id/version/operation/exportName`；相应源码导出 `<exportName>Input`、`Output`、`Ref`、`Schema`、同名服务描述和 `<exportName>Submit`。描述中的 `ref/inputSchema/outputSchema` 可以继续用于公开服务注册和目录校验，不维护另一份手写类型。

生成的提交函数只调用传入 `ServerServiceAccess.submit` 一次，保持调用信号、提供者代次及 `HostResult<Job>` 回执，不新增目录查询、轮询、自动重试、超时或后台取消。`queued/running` 不是业务成功；调用方仍应遵守原 Job 查询、终态和未知结果规则。它不是把服务器服务伪装成浏览器同步 `services.call`。

该工具仅生成明确支持的 JSON Schema 数据结构，不是完整 Schema 标准实现。不支持、无效或有歧义的结构会在生成前报出具体清单路径，不静默放宽成 `any`。长度、正则和数值范围等运行期约束保留在原 Schema 中，不能仅凭 TypeScript 类型宣称已校验。生成物只导入公开 SDK 类型，服务器执行时不需要加载生成器或浏览器依赖。

## 浏览器构建参数与边界

- `root` 必须是存在的工程目录。相对 `entry` 和 `outputDir` 均相对 `root`；绝对入口仍必须在该工程内。
- `outputDir` 必填，必须是工程内的子目录，不能覆盖工程本身、入口或 `node_modules/.git`。符号链接解析后的实际目录同样受此约束。
- `dependencies?: Readonly<Record<string, string>>` 只做精确匹配，不按前缀替换。目标必须是带同名 `package.json` 的实际发行包中的 JS、MJS、CJS、JSON 或 CSS 文件；TS 私有源码入口不接受。普通第三方依赖从正常 `node_modules` 解析，不启用 workspace 的 `development` 条件。
- `theme?: string` 接受调用方交付的 Tailwind 主题和变体指令，最大 512 KiB，不接受额外 `@import`、`@source` 或资源 URL。工具不自行读取宿主 CSS。默认暗色变体仅匹配 `.dark` 类，不跟随系统偏好；调用方提供同名变体时沿用该定义。
- `signal?: AbortSignal` 可取消本次构建。构建与输出提交共用 180 秒期限，取消或失败先回收自有构建子进程再返回，不把停止等待描述成完成构建。

入口的默认导出、具名导出和延迟加载均保留。插件工厂及身份由原清单打包流程处理，本工具不会再次包一层身份工厂。

## 共享 React 与依赖闭包

以下六个裸模块名是当前 DeviceForge 的公开 importmap 契约，构建始终保留：

| 说明符 | 宿主公开入口 |
| --- | --- |
| `deviceforge-host` | `/plugin-host.js` |
| `react` | `/plugin-react.js` |
| `react/jsx-runtime` | `/plugin-jsx-runtime.js` |
| `react/jsx-dev-runtime` | `/plugin-jsx-dev-runtime.js` |
| `react-dom` | `/plugin-react-dom.js` |
| `react-dom/client` | `/plugin-react-dom-client.js` |

工具拒绝未知 React 子路径、覆盖共享模块的依赖映射，以及将实际 React 文件路径打入插件。其他依赖必须形成完整产物闭包，不允许残留任意裸导入、跨工程私有路径或计算型动态模块导入。

浏览器 Worker 使用同一公开依赖映射，但不能使用页面 importmap。若 Worker 直接或间接引用这些共享模块，构建明确失败；不会给 Worker 假造宿主 React 或 DOM。Worker 的 JS 和关联资源会真实生成到输出目录。

## Tailwind 与样式生命周期

工具通过虚拟 CSS 生成 Tailwind 主题与工具类，不写入 `src/*.ts`，不生成源码 CSS 文件，也不加入手写样式规则。默认不附带 Tailwind preflight。源码导入的第三方 CSS、动态 CSS 和资源仍由 Vite 处理；最终 CSS 文件保留，并汇总到 `styles.js`。

`styles.js` 导入时不操作 DOM，导出：

```ts
export const styleUrls: readonly string[];
export function acquireStyles(document: Document): () => void;
```

调用者在插件激活期间获取样式，并将返回的释放函数登记到该插件生命周期：

```ts
import { acquireStyles } from './dist/styles.js';

async function activate(context) {
  if (typeof document !== 'undefined')
    context.onDispose(acquireStyles(document));
  // 随后登记本插件的服务、页面或工作区。
}
```

每个模块按 Document 计数，重复获取不会重复插入 `<link>`；每个释放函数幂等，最后一次释放只删除本模块持有的链接。所有 CSS 在获取样式时开始加载，包括延迟页面的 CSS；浏览器异步加载完成与“链接已登记”是不同状态。`styleUrls` 可供调用方另行观察加载结果。

样式作用于文档，可覆盖 Radix 等挂载在根节点之外的门户；没有按单个根节点裁剪 CSS。它提供资源归属与回收，不是样式沙箱。无 Document 的纯登记场景应跳过获取，不能据此宣称样式已经加载。

主侧若增加激活包装入口，应保留原工厂、异步返回值与调用上下文，将额外入口列入最终分发闭包。工具输出的 `index.js` 和原构建报告不需要被修改。

## 输出、身份和原产物保护

成功返回 `BrowserPluginBuildResult`，同时写入 `plugin-build.json`：

- `entryFile` 为 `index.js`；`stylesFile` 为 `styles.js`，另附其独立声明。
- `files` 列出本次 ESM、Worker、CSS 和资源的相对路径、字节数与 SHA-256，不列报告自身，避免摘要自引用。
- `imports` 按 JS 文件列出 `static`、`dynamic` 和静态 `new URL()` 资源引用。
- `hostImports` 只列本次实际使用的共享模块；`css` 列出全部实际 CSS 文件。
- `buildId` 为本次文件摘要及导入目录的确定性 SHA-256，表示构建身份，不代替清单插件身份。

构建先写入自有临时目录并完成闭包核对，再提交输出。不会执行清空目录操作；无关文件和旧哈希块保留。已有归属报告允许更新工具自己的文件；首次遇到同名且内容不同、归属未知的文件会拒绝覆盖。提交中断会回滚已经修改的文件，不把失败构建替换为旧成功回执。同一进程中对同一输出目录的并发构建明确拒绝，不建立全局装卸队列。

系统暂存与工程可位于不同磁盘。提交时将每个新文件复制到目标同目录的独占临时文件，再同卷重命名，避免跨盘重命名的 `EXDEV`；只回收本次创建的临时文件。

工具等待每个自有 Node 构建子进程退出。正常完成后最多等待 5 秒；失败或取消先结束对应进程，必要时升级强制终止，并有界等待退出。它不启动开发服务器、不访问设备、不管理用户服务。

## 模块职责

| 模块 | 职责 | 边界 |
| --- | --- | --- |
| `types`、`index` | 公开输入、结果及稳定入口 | 不含宿主业务 |
| `paths` | 工程、依赖身份及输出边界 | 不执行构建或工程配置 |
| `worker` | 固定 Vite/React/Tailwind 编译及公开依赖解析 | 仅自有短生命周期构建进程 |
| `imports` | 产物静态闭包与资源目录 | 不执行插件模块 |
| `styles` | 生成显式获取和释放的样式模块 | 导入时无 DOM 副作用 |
| `commit` | 文件归属核对、更新及失败回滚 | 不清空旧目录 |
| `build` | 期限、取消、子进程回收和最终身份 | 不注入插件工厂或更改 CLI |

## 本地维护与验证

源码使用严格 TypeScript，`lib` 为实际编译的 ESM 与声明。维护时在具备声明工具链的工程执行：

```powershell
node node_modules/typescript/bin/tsc --project plugin-tools/tsconfig.json
node node_modules/typescript/bin/tsc --project plugin-tools/tsconfig.test.json
node --test tests/plugin-build-tools.test.ts
```

这些是本仓库维护命令，不是独立使用者的必要步骤。发行包已经含 `lib`，使用者无需宿主源码或宿主生成器。打包使用 `npm pack --ignore-scripts`，不执行安装或构建钩子。

直接单元共 9 项，已按影响范围分批通过，覆盖实际编译入口、共享 React 外置、延迟 CSS、CSS 资源、Worker、主题、样式释放、公开依赖边界、取消退出、重复构建及原产物保护。另实际验证 C 盘暂存向 G 盘工程提交、真实 TGZ 解包后的 NodeNext 严格声明消费、运行时公开入口和预取消。

TGZ 核对复用现有已安装的公开依赖，没有执行独立 `npm install`。没有执行宿主完整构建、全量测试、浏览器、真实服务或设备验收；插件业务、视觉与最终分发仍需在对应交付层验证。
