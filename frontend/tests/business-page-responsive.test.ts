import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { compile } from 'tailwindcss';
import type { DeviceSnapshot, HostContext, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import type { BoardSample } from '../plugins/performance/src/components/SampleBoard/index.tsx';
import type { TerminalViewportHandle } from '../plugins/terminal/src/view/TerminalViewport.tsx';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const releaseUi = installPublicUi();
const { PerformancePage } = await import('../plugins/performance/src/view.tsx');
const { createPerformanceServices } = await import('../plugins/performance/src/services.ts');
const { SampleBoard } = await import('../plugins/performance/src/components/SampleBoard/index.tsx');
const { TerminalPage } = await import('../plugins/terminal/src/view.tsx');
const { TerminalViewport } = await import('../plugins/terminal/src/view/TerminalViewport.tsx');
const { createTerminalServices } = await import('../plugins/terminal/src/services.ts');
const { FridaPage } = await import('../plugins/frida/src/view.tsx');
const { createFridaServices } = await import('../plugins/frida/src/services.ts');
const { AnalysisPage } = await import('../plugins/analysis/src/view.tsx');
const { createAnalysisServices } = await import('../plugins/analysis/src/services.ts');
const { AutomationPage } = await import('../plugins/automation/src/view.tsx');
const { createAutomationServices } = await import('../plugins/automation/src/services.ts');
const { AiPage } = await import('../plugins/ai/src/view.tsx');
const { createAiServices } = await import('../plugins/ai/src/services.ts');
const { SettingsView } = await import('../plugins/settings/src/view.tsx');
const { createSettingsServices } = await import('../plugins/settings/src/services.ts');
const { createRoot } = await import('react-dom/client');
after(async () => { imports.dispose(); await releaseUi(); });

function fixture() {
  const owner = new AbortController();
  let requests = 0;
  const snapshot: DeviceSnapshot = { providers: [], directories: [], selection: null, selected: null };
  const unavailable = async (): Promise<never> => { requests++; throw new Error('响应式单元不得提交任务、创建会话或访问设备'); };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    listOperations: async () => { requests++; return { data: [], logId: null }; },
    subscribeOperations: () => () => {}, onDispose: (release) => release, onCleanup: () => () => {},
    transport: { request: unavailable, bytes: unavailable, stream: unavailable },
    artifacts: { upload: unavailable, download: unavailable },
    devices: { snapshot: () => snapshot, subscribe: () => () => {}, select: () => {},
      refreshProviders: unavailable, refreshDirectories: unavailable, refreshProvider: unavailable, invoke: unavailable },
  };
  const performance = createPerformanceServices(context), terminal = createTerminalServices(context);
  return { context, performance, terminal, calls: () => requests,
    async close() { owner.abort(); performance.dispose(); await terminal.dispose(); } };
}
function requireClasses(element: Element | null, names: readonly string[]) {
  assert.ok(element, '缺少预期的业务容器');
  for (const name of names) assert.ok(element.classList.contains(name), `缺少容器适配类：${name}`);
}

test('独立性能页保留原标题与采集入口，短容器不强制560高度且空态按容器重排', async () => {
  const f = fixture();
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(PerformancePage, { services: f.performance })));
    const root = page.window.document.querySelector('[data-product-page="performance"]');
    requireClasses(root, ['@container/performance', 'h-full', 'min-h-0', 'min-w-0', 'overflow-hidden']);
    assert.equal(root?.classList.contains('min-h-[560px]'), false);
    assert.equal(root?.querySelector('h1')?.textContent?.trim(), '性能与调用栈');
    assert.match(root?.textContent ?? '', /持续采样/); assert.match(root?.textContent ?? '', /归档录制/);
    assert.match(root?.textContent ?? '', /开始采集/); assert.match(root?.textContent ?? '', /查看已有会话/);
    requireClasses(root?.querySelector(':scope > header') ?? null, ['shrink-0', 'min-w-0']);
    requireClasses(root?.querySelector('[data-performance-content]') ?? null, ['min-h-0', 'min-w-0', 'flex-1', 'overflow-y-auto']);
    const empty = root?.querySelector('[aria-label="采集准备"]');
    requireClasses(empty ?? null, ['@lg/performance:px-8']);
    const row = [...empty?.querySelectorAll('div') ?? []].find((element) => element.classList.contains('@lg/performance:flex-row'));
    assert.ok(row); assert.equal(row.classList.contains('sm:flex-row'), false);
    const compiler = await compile('@theme { --spacing: 0.25rem; --container-lg: 32rem; } @tailwind utilities;');
    const css = compiler.build(['@container/performance', ...empty?.classList ?? [], ...row.classList]);
    assert.match(css, /@container performance \(width >= 32rem\)/); assert.doesNotMatch(css, /@media/);
    assert.equal(f.calls(), 0, '静态响应式渲染不得启动业务请求');
  } finally { page?.window.close(); await f.close(); }
});

test('性能时间轴的1132画布局部横滚，图表保留可用高度而不撑宽外部工作区', () => {
  const sample: BoardSample = { id: 'sample', t: 0, fps: 60, cpu: 10, pssKib: 1024, rssKib: 2048,
    frameUrl: null, stacks: [], note: null };
  const page = new JSDOM(renderToStaticMarkup(createElement(SampleBoard, {
    samples: [sample], span: 1, selected: 0, onSelect: () => {}, frameNote: '未采样画面', stackNote: '无栈样本',
  })));
  try {
    const root = page.window.document.querySelector('[data-performance-board]');
    requireClasses(root, ['min-h-[220px]', 'min-w-0', 'overflow-auto', 'overscroll-contain']);
    assert.equal(root?.classList.contains('min-w-[1132px]'), false);
    requireClasses(root?.querySelector('[data-shared-time-canvas]') ?? null, ['min-w-[1132px]']);
    assert.ok(root?.querySelector('[aria-label="帧率指标"]'));
    assert.ok(root?.querySelector('[aria-label="CPU指标"]'));
    assert.ok(root?.querySelector('[aria-label="内存指标"]'));
  } finally { page.window.close(); }
});

test('独立终端页保留原操作与服务器记录，根容器可收缩滚动且辅助读数按窄容器隐藏', async () => {
  const f = fixture();
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(TerminalPage, { services: f.terminal })));
    const root = page.window.document.querySelector('[data-product-page="terminal"]');
    requireClasses(root, ['@container/terminal', 'h-full', 'min-h-0', 'min-w-0', 'overflow-y-auto']);
    assert.equal(root?.classList.contains('min-h-[560px]'), false);
    assert.equal(root?.querySelector('h1')?.textContent, '终端');
    for (const text of ['新会话', '刷新目录', '关闭会话', '服务器终端记录', '聚焦终端']) assert.match(root?.textContent ?? '', new RegExp(text));
    requireClasses(root?.querySelector(':scope > header') ?? null, ['shrink-0', 'min-w-0', 'flex-wrap']);
    requireClasses(root?.querySelector('[data-terminal-console]') ?? null, ['grow', 'shrink-0', 'basis-auto', 'min-w-0']);
    requireClasses(root?.querySelector('[aria-label="终端输出"]') ?? null, ['min-h-[160px]', 'min-w-0']);
    const auxiliary = [...root?.querySelectorAll('span') ?? []].find((entry) => entry.textContent === '交互终端');
    requireClasses(auxiliary ?? null, ['hidden', '@sm/terminal:inline']);
    assert.equal(auxiliary?.classList.contains('sm:inline'), false);
    assert.equal(f.calls(), 0);
  } finally { page?.window.close(); await f.close(); }
});

test('终端实际挂载容器缩放只调整行列，不重建输入节点或发送命令，卸载撤销尺寸观察', async () => {
  const page = new JSDOM('<div id="viewport"></div>', { pretendToBeVisual: true, url: 'http://localhost' });
  const callbacks = new Set<() => void>();
  class Observer {
    private readonly callback: () => void;
    constructor(callback: () => void) { this.callback = callback; callbacks.add(callback); }
    observe() {} unobserve() {} disconnect() { callbacks.delete(this.callback); }
  }
  const globals: Readonly<Record<string, unknown>> = {
    window: page.window, document: page.window.document, navigator: page.window.navigator,
    HTMLElement: page.window.HTMLElement, ResizeObserver: Observer, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
    cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window),
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  let width = 960, height = 480, inputs = 0;
  Object.defineProperties(page.window.HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => width }, clientHeight: { configurable: true, get: () => height },
  });
  // 只替换单元环境无法排字的终端依赖，保留业务视口原本的挂载、测量和清理逻辑。
  const emulator = registerHooks({
    resolve(specifier, context, next) {
      const name = specifier === '@xterm/xterm' ? 'terminal' : specifier === '@xterm/addon-fit' ? 'fit' : null;
      return name ? { url: `deviceforge-responsive-test:${name}`, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      if (url === 'deviceforge-responsive-test:terminal') return { format: 'module', shortCircuit: true, source: `
        export class Terminal {
          constructor(options) { this.options = options; this.cols = options.cols ?? 80; this.rows = options.rows ?? 24; }
          loadAddon(addon) { addon.activate(this); }
          open(node) { this.node = node; this.textarea = document.createElement('textarea'); node.append(this.textarea); }
          onData() { return { dispose() {} }; } attachCustomKeyEventHandler() {}
          resize(cols, rows) { this.cols = cols; this.rows = rows; } focus() {} write() {}
          dispose() { this.textarea?.remove(); }
        }` };
      if (url === 'deviceforge-responsive-test:fit') return { format: 'module', shortCircuit: true, source: `
        export class FitAddon {
          activate(terminal) { this.terminal = terminal; }
          proposeDimensions() { return { cols: Math.floor(this.terminal.node.clientWidth / 8), rows: Math.floor(this.terminal.node.clientHeight / 16) }; }
        }` };
      return next(url, context);
    },
  });
  const node = page.window.document.getElementById('viewport'); assert.ok(node);
  const root = createRoot(node), handle: { current: TerminalViewportHandle | null } = { current: null };
  const sizes: { cols: number; rows: number }[] = [];
  async function settle() {
    for (let attempt = 0; attempt < 12; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      if (sizes.at(-1)?.cols === Math.floor(width / 8)) return;
    }
    assert.fail('终端未在单元等待窗口内完成尺寸同步');
  }
  try {
    await act(async () => { root.render(createElement(TerminalViewport, {
      chunks: [], writable: true, handle, onData: () => { inputs++; }, onResize: (size) => sizes.push(size),
    })); });
    await settle(); assert.deepEqual(sizes.at(-1), { cols: 120, rows: 30 });
    const input = node.querySelector('textarea'), originalHandle = handle.current;
    assert.ok(input); assert.ok(originalHandle);
    width = 304; height = 160;
    await act(async () => { for (const callback of callbacks) callback(); });
    await settle();
    assert.deepEqual(sizes.at(-1), { cols: 38, rows: 10 });
    assert.equal(node.querySelector('textarea'), input); assert.equal(handle.current, originalHandle);
    assert.equal(inputs, 0); assert.equal(callbacks.size, 1);
  } finally {
    await act(async () => { root.unmount(); });
    assert.equal(handle.current, null); assert.equal(callbacks.size, 0);
    emulator.deregister();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    page.window.close();
  }
});

test('Frida原脚本配置与输出由独立插件呈现，分栏按挂载容器收起且长内容可滚动', async () => {
  const f = fixture(), services = createFridaServices(f.context);
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(FridaPage, { services })));
    const root = page.window.document.querySelector('[data-product-page="frida"]');
    requireClasses(root, ['@container/frida', 'h-full', 'min-h-0', 'min-w-0', 'overflow-y-auto']);
    assert.equal(root?.querySelector('h1')?.textContent, 'Frida');
    const configuration = root?.querySelector('[aria-label="Frida 执行配置"]');
    assert.ok(configuration); assert.match(root?.textContent ?? '', /检查状态/);
    assert.match(root?.textContent ?? '', /脚本与目标/); assert.match(root?.textContent ?? '', /尚无执行结果/);
    requireClasses(configuration.parentElement, ['min-w-0', '@min-[900px]/frida:grid-cols-[20rem_minmax(0,1fr)]']);
    assert.equal(configuration.parentElement?.classList.contains('lg:grid-cols-[20rem_minmax(0,1fr)]'), false);
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    const css = compiler.build([...configuration.parentElement?.classList ?? []]);
    assert.match(css, /@container frida \(width >= 900px\)/); assert.doesNotMatch(css, /@media/);
    assert.equal(f.calls(), 0);
  } finally { page?.window.close(); services.dispose(); await f.close(); }
});

test('分析原上传与DEX工具由独立插件接回，来源分栏和字段均按本容器响应而非浏览器宽度', async () => {
  const f = fixture(), services = createAnalysisServices(f.context);
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(AnalysisPage, { services })));
    const root = page.window.document.querySelector('[data-product-page="analysis"]');
    requireClasses(root, ['@container/analysis', 'h-full', 'min-h-0', 'min-w-0', 'overflow-y-auto']);
    assert.equal(root?.querySelector('h1')?.textContent, '分析与数据');
    const source = root?.querySelector('[aria-label="分析文件来源"]'); assert.ok(source);
    requireClasses(source.parentElement, ['min-w-0', '@min-[800px]/analysis:grid-cols-[17.5rem_minmax(0,1fr)]']);
    requireClasses(source, ['@min-[800px]/analysis:border-r', '@min-[800px]/analysis:border-b-0']);
    assert.ok(source.querySelector('input[type="file"]'));
    for (const text of ['产物 ID', 'DEX', 'MessagePack', '读取 DEX 统计', '检查此 SDK 规则']) assert.match(root?.textContent ?? '', new RegExp(text));
    const fields = [...root?.querySelectorAll('div') ?? []].find((element) => element.classList.contains('@md/analysis-tool:grid-cols-2'));
    assert.ok(fields); assert.equal(fields.classList.contains('sm:grid-cols-2'), false);
    assert.ok(fields.closest('[class~="@container/analysis-tool"]'), '字段应响应右侧工具区，而不是整页总宽度');
    const compiler = await compile('@theme { --spacing: 0.25rem; --container-md: 28rem; } @tailwind utilities;');
    const css = compiler.build([...source.parentElement?.classList ?? [], ...source.classList, ...fields.classList]);
    assert.match(css, /@container analysis \(width >= 800px\)/);
    assert.match(css, /@container analysis-tool \(width >= 28rem\)/); assert.doesNotMatch(css, /@media/);
    assert.equal(f.calls(), 0);
  } finally { page?.window.close(); services.dispose(); await f.close(); }
});

test('分析窄栏标签与输入纵向排列，完整标识输入不再被固定标签列挤占', async () => {
  const f = fixture(), services = createAnalysisServices(f.context);
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement('div', null,
      createElement(AnalysisPage, { services }), createElement(AnalysisPage, { services }))));
    const document = page.window.document;
    const inputs = [...document.querySelectorAll('input')];
    assert.equal(new Set(inputs.map((input) => input.id)).size, inputs.length, '多实例输入标识必须各自归属');
    for (const section of document.querySelectorAll('[data-product-page="analysis"]')) {
      for (const text of ['产物 ID', 'DEX 规则名称', 'DEX 包路径', 'DEX 类名（可选）']) {
        const label = [...section.querySelectorAll('label')].find((element) => element.textContent === text);
        assert.ok(label);
        const input = document.getElementById(label.htmlFor);
        assert.ok(input && section.contains(input));
        assert.equal(input.parentElement, label.parentElement, '标签不能占用另一固定宽列');
        requireClasses(label.parentElement, ['grid', 'grid-cols-1', 'min-w-0', 'gap-1.5']);
        assert.equal(label.closest('.form-item'), null, '不再依赖有144像素标签列的旧表单规则');
      }
    }
    assert.equal(f.calls(), 0);
  } finally { page?.window.close(); services.dispose(); await f.close(); }
});

test('自动化原三工作区和真实操作保留，页签内容局部滚动且桌面输入分栏只按本容器响应', async () => {
  const f = fixture(), services = createAutomationServices(f.context);
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(AutomationPage, { services })));
    const root = page.window.document.querySelector('[data-product-page="automation"]');
    requireClasses(root, ['@container/automation', 'h-full', 'min-h-0', 'min-w-0', 'overflow-hidden']);
    assert.equal(root?.querySelector('h1')?.textContent, '自动化');
    for (const text of ['设备步骤', '桌面操作', '输入录制与回放', '添加第一个步骤', '执行一次点击', '开始录制轨迹'])
      assert.match(root?.textContent ?? '', new RegExp(text));
    const panels = [...root?.querySelectorAll('[role="tabpanel"]') ?? []];
    assert.equal(panels.length, 3);
    for (const panel of panels) {
      requireClasses(panel, ['min-h-0', 'min-w-0', 'flex-1', 'overflow-y-auto']);
      requireClasses(panel.firstElementChild, ['grow', 'shrink-0', 'basis-auto']);
    }
    const desktop = panels[1]; assert.ok(desktop);
    const split = [...desktop.querySelectorAll('div')].find((element) =>
      element.classList.contains('@min-[880px]/automation:grid-cols-[minmax(16rem,0.9fr)_minmax(0,1.6fr)]'));
    assert.ok(split); assert.equal(split.classList.contains('lg:grid-cols-[minmax(16rem,0.9fr)_minmax(0,1.6fr)]'), false);
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    const css = compiler.build([...split.classList]);
    assert.match(css, /@container automation \(width >= 880px\)/); assert.doesNotMatch(css, /@media/);
    assert.equal(f.calls(), 0, '渲染三个工作区不得派发设备、桌面或录制动作');
  } finally { page?.window.close(); services.dispose(); await f.close(); }
});

test('AI原会话和输入区由业务插件保留，侧栏按本容器隐藏且低高度仍能滚动到输入区', async () => {
  const f = fixture(), services = createAiServices(f.context);
  const instance: WorkspaceViewContext = {
    signal: f.context.signal, subscribeVisibility: () => () => {},
    snapshot: () => ({ instanceId: 'responsive.ai', workspaceId: 'ai', pluginId: 'deviceforge_ai',
      providerGeneration: 1, generation: 1, provider: { pluginId: 'deviceforge_ai', viewId: 'main' },
      target: null, visible: true, state: 'ready', reason: null }),
  };
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(AiPage, { services, instance })));
    const root = page.window.document.querySelector('[data-product-page="ai"]');
    requireClasses(root, ['@container/ai', 'h-full', 'min-h-0', 'min-w-0', 'overflow-hidden']);
    const sidebars = [...root?.querySelectorAll('[aria-label="实时会话记录"]') ?? []];
    assert.equal(sidebars.length, 2);
    for (const sidebar of sidebars) {
      requireClasses(sidebar, ['hidden', 'min-h-0', '@min-[800px]/ai:flex']);
      assert.equal(sidebar.classList.contains('lg:flex'), false);
    }
    for (const log of root?.querySelectorAll('[role="log"]') ?? []) {
      requireClasses(log, ['min-h-[160px]', 'min-w-0', 'overflow-y-auto']);
      requireClasses(log.parentElement, ['min-h-0', 'min-w-0', 'overflow-y-auto']);
    }
    for (const input of root?.querySelectorAll('textarea') ?? []) assert.ok(input.id.startsWith('responsive.ai-'));
    for (const text of ['还没有对话', '检查配置', '新建会话', '原始结果']) assert.match(root?.textContent ?? '', new RegExp(text));
    const compiler = await compile('@theme { --spacing: 0.25rem; } @tailwind utilities;');
    assert.match(compiler.build([...sidebars[0]?.classList ?? []]), /@container ai \(width >= 800px\)/);
    assert.equal(f.calls(), 0, '自适应渲染不创建AI会话或派发命令');
  } finally { page?.window.close(); await services.dispose(); await f.close(); }
});

test('设置原分类及连接表单保留，窄容器用原分类选择而不被宽浏览器强制分栏', async () => {
  const f = fixture(), services = createSettingsServices(f.context, 'fixture.sections', 'fixture.settings');
  let page: JSDOM | undefined;
  try {
    page = new JSDOM(renderToStaticMarkup(createElement(SettingsView, { services })));
    const root = page.window.document.querySelector('[aria-label="设置工作区"]');
    requireClasses(root, ['@container/settings', 'h-full', 'min-h-0', 'min-w-0', 'overflow-hidden']);
    assert.equal(root?.querySelector('h1')?.textContent, '设置');
    const navigation = root?.querySelector('nav[aria-label="设置分类"]');
    requireClasses(navigation ?? null, ['hidden', '@min-[800px]/settings:block']);
    requireClasses(navigation?.parentElement ?? null, ['min-w-0', '@min-[800px]/settings:grid-cols-[209px_minmax(0,1fr)]']);
    assert.equal(navigation?.classList.contains('min-[1100px]:block'), false);
    const select = root?.querySelector('button[aria-label="设置分类"]'); assert.ok(select);
    requireClasses(select.parentElement, ['@min-[800px]/settings:hidden']);
    const source = root?.querySelector('section[aria-label="服务连接"]');
    requireClasses(source?.parentElement ?? null, ['@container/settings-content', 'min-h-0', 'min-w-0']);
    const row = [...source?.querySelectorAll('div') ?? []].find((entry) => entry.classList.contains('@lg/settings-content:grid-cols-[104px_minmax(0,520px)]'));
    assert.ok(row);
    for (const text of ['服务连接', '外观与主题', '工具配置', '插件扩展', '服务地址']) assert.match(root?.textContent ?? '', new RegExp(text));
    const compiler = await compile('@theme { --spacing: 0.25rem; --container-lg: 32rem; } @tailwind utilities;');
    const css = compiler.build([...navigation?.classList ?? [], ...row.classList]);
    assert.match(css, /@container settings \(width >= 800px\)/);
    assert.match(css, /@container settings-content \(width >= 32rem\)/); assert.doesNotMatch(css, /@media/);
    assert.equal(f.calls(), 0);
  } finally { page?.window.close(); services.operations.dispose(); services.settings.dispose(); await f.close(); }
});
