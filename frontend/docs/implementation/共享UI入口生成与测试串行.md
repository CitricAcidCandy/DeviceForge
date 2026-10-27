# 共享 UI 入口生成与测试串行

日期：2026-10-27。范围：共享 UI 契约、浏览器 ESM 入口与测试调度，不改变产品界面、插件管理器或后端。

## 契约与职责

| 文件或目录 | 职责 | 不承担的职责 |
| --- | --- | --- |
| `src/plugin-sdk/ui.ts` | 独立公开组件属性、宿主 React 与 DOM 运行时类型 | 不引用 app 或真实组件实现 |
| `src/app/public-ui.ts` | 发布宿主实际实例，用 `satisfies HostUi` 校验契约 | 不通过双重断言隐藏组件属性错误 |
| `src/app/public-ui-*.ts` | 六个原生 ESM 入口的唯一维护源 | 不加载或内联另一份 React |
| `scripts/generate-public-ui.ts` | 转译生成 `public/plugin-*.js`，或只读检查漂移 | 不代替全工程 strict 检查 |
| `vite.config.ts` | 启动、构建和入口源热更新时生成公共入口 | 不改变原 `/assets/plugin-host.js` 运行时入口 |
| `scripts/run-tests.ts` | 识别 Vite 值依赖，分阶段执行测试并汇总失败 | 不执行构建，不自动修复测试 |

`HostUi` 保留 `apiVersion: 1` 和原 `React`、`ReactDOMClient`、`jsx/jsxs/Fragment` 等成员，新增 `ReactDOM`、`jsxRuntime`、`jsxDevRuntime`、`jsxDEV`。旧插件继续可用；依赖新独立模块入口的插件要求更新后的宿主，旧宿主不能靠回退自带 React 混合运行。

`HostComponent<Props>` 从任意属性字典改为明确属性；Button、Field、FormRow、Select、Stepper、MultiTrackChart 等分别保留 DOM 事件、字符串回调、必需属性和枚举约束。SDK 仅依赖公开 React、Radix 与 clsx 类型，不穿透宿主组件目录。宿主组件实现变化不兼容时，`satisfies` 产生编译错误，需同步契约，不能转回 `Record<string, unknown>` 或双重断言。

## 独立入口

| 说明符 | 生成产物 | TypeScript 源 |
| --- | --- | --- |
| `deviceforge-host` | `public/plugin-host.js` | `public-ui-host.ts` |
| `react` | `public/plugin-react.js` | `public-ui-react.ts` |
| `react-dom` | `public/plugin-react-dom.js` | `public-ui-react-dom.ts` |
| `react-dom/client` | `public/plugin-react-dom-client.js` | `public-ui-react-dom-client.ts` |
| `react/jsx-runtime` | `public/plugin-jsx-runtime.js` | `public-ui-jsx-runtime.ts` |
| `react/jsx-dev-runtime` | `public/plugin-jsx-dev-runtime.js` | `public-ui-jsx-dev-runtime.ts` |

源文件位于 `src/app/`。各入口读取 `__DEVICEFORGE_HOST_UI__` 已安装实例；宿主未就绪明确抛错。`react` 公开标准 hooks/context 等命名 API，DOM 公开 portal，两个 JSX 模块分别公开生产与开发运行时；私有 React 内部字段及未进入公开类型的实验 API 不作兼容承诺。

生成产物携带中文生成标识，不得手改。执行方式：

```powershell
node scripts/generate-public-ui.ts
node scripts/generate-public-ui.ts --check
```

重复生成无变化不写文件。只读检查拒绝缺失或过期产物；Windows Git 检出造成的 CRLF/LF 差异不视为源码漂移。Vite 开发与构建复用同一生成器，构建沿用 public 目录原生复制，不将它重新打包进第二份 React。入口热更新会生成产物并要求整页刷新，避免仍保留旧 ESM 模块缓存。

## 测试调度

原入口始终四文件并发，会让多个 middleware Vite 竞争 `node_modules/.vite`。现以 TypeScript AST 检测值导入、重导出和字面量动态导入，再按项目路径解析本地传递依赖。Vite 类型导入、注释和普通字符串不占串行队列；循环依赖有访问去重。

普通测试先按最多四个子进程执行，全部结束后才逐个执行 Vite 测试。两阶段不重叠；SIGINT/SIGTERM 继续通知在跑子进程，停止后续调度。单文件非零退出继续收集其余文件，最终保持失败退出码。计算出来的动态模块名和运行中才拼接的依赖不属于静态检测保证，新增此类辅助起服方式时应改为可静态解析的入口。

实际只读规划快照为 141 文件、129 普通、12 Vite，仅证明分类，不代表执行通过。其他代理后续增加文件后以当次规划为准。所有新增 TS 源、脚本和测试均被既有 tsconfig include 与 strict 三项约束覆盖，无需扩大排除项。

## 定点证据与边界

- 红测：旧导入映射唯一地址数为 1 而非 6，React 标准命名导出缺失，入口测试 0/2；调度新接口不存在，加载测试明确失败。
- 非 Vite 最终：四文件共 9 项通过，覆盖原生 ESM 链接器命名导入、函数身份、生成漂移、CRLF 兼容、属性负例、传递依赖、独占调度、并发上限、中断及实际失败子进程汇总。
- Vite 第一轮：原三项 3/3 通过。扩展第二轮四个业务断言通过，但 JSDOM 全局恢复早于 React 延后任务，进程退出 1，不计通过。
- 测试收尾以 `act` 等待 React 任务并等待下一轮宏任务后再恢复全局；第三轮 `public-ui.test.ts` 最终 4/4、退出 0，包含 hooks 更新、宿主 context、开发 JSX、portal 和卸载清空。测试正常关闭 middleware Vite 与 JSDOM。
- 本轮 16 个维护入口及其依赖按原 tsconfig 严格类型检查，诊断 0。新增属性负例依赖 `@ts-expect-error` 被真实编译验证，不是运行时用例可代替的类型保证。
- 未执行完整 npm test、生产 build、真实浏览器、设备或视觉验收；JSDOM 与 Node 原生 ESM 证据不能扩大为这些门禁通过。

## 主代理集成

本角色未修改 `package.json`、SDK index、todo、生成 HTTP 类型或其他代理拥有的实现。建议主代理增加：

```json
{
  "generate:ui": "node scripts/generate-public-ui.ts",
  "check:ui-entries": "node scripts/generate-public-ui.ts --check"
}
```

将只读产物检查纳入 check；dev/build 已由 Vite 自动生成，无需重复添加前置生成。若需要从 SDK 总入口显式导出 `HostUiComponentProps`、图表类型或表单控制类型，由主代理修改 SDK index；现有 `HostUi` 的 `ComponentProps` 提取已可使用。主代理还需集成 todo/文档索引并在冻结工作区后运行全量门禁及实际生产浏览器 ESM 验收。
