import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import type { HostUiHolder } from '../src/app/public-ui.ts';
import { deferred } from './fixtures.ts';

const requests: string[] = [];
const loading = deferred<void>();
let engineLoads = 0;
interface ChartInstance {
  readonly target: HTMLElement;
  readonly options: unknown[];
  width: number;
  height: number;
  disposed: number;
  clicks: ((event: { offsetX: number; offsetY: number }) => void)[];
}
const instances: ChartInstance[] = [];
let rejectCreate = false;
const engine = {
  ready: loading.promise,
  create(target: HTMLElement, width: number, height: number) {
    if (rejectCreate) throw new Error('本次图表引擎初始化失败');
    const value: ChartInstance = { target, width, height, options: [], disposed: 0, clicks: [] };
    instances.push(value);
    return {
      getWidth: () => value.width, getHeight: () => value.height,
      resize(size: { width: number; height: number }) { value.width = size.width; value.height = size.height; },
      setOption(option: unknown) { value.options.push(option); },
      containPixel: () => true, convertFromPixel: () => 12,
      getZr: () => ({
        on(_name: string, handler: ChartInstance['clicks'][number]) { value.clicks.push(handler); },
        off(_name: string, handler: ChartInstance['clicks'][number]) { value.clicks = value.clicks.filter((item) => item !== handler); },
      }),
      dispose() { value.disposed++; },
    };
  },
};
const key = '__deviceforgeChartEngineUnit';
const previousEngine = Object.getOwnPropertyDescriptor(globalThis, key);
Object.defineProperty(globalThis, key, { configurable: true, value: engine });
const imports = registerCompositionStartupImports();
const observer = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'echarts' || specifier.startsWith('echarts/')) requests.push(specifier);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/components/MultiTrackChart/runtime.ts')) {
      engineLoads++;
      return { format: 'module', shortCircuit: true, source: `
        await Reflect.get(globalThis, '${key}').ready;
        export function createChart(...args) { return Reflect.get(globalThis, '${key}').create(...args); }
      ` };
    }
    return next(url, context);
  },
});
after(() => {
  observer.deregister(); imports.dispose();
  if (previousEngine) Object.defineProperty(globalThis, key, previousEngine); else Reflect.deleteProperty(globalThis, key);
});
const { installPublicUi } = await import('../src/app/public-ui.ts');

test('公共UI启动不加载图表引擎，工作台首屏不必等待无关ECharts模块', async () => {
  const holder: HostUiHolder = {};
  const release = installPublicUi(holder);
  try {
    assert.ok(holder.__DEVICEFORGE_HOST_UI__?.MultiTrackChart);
    assert.deepEqual(requests, [], '引擎只能在实际图表需要尺寸后加载');
    assert.equal(engineLoads, 0);
  } finally { await release(); }
});

async function fixture() {
  const browser = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const target = browser.window.document.getElementById('root'); assert.ok(target);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const measurements = new Set<ResizeObserverCallback>();
  let width = 0, height = 0;
  class ChartResizeObserver {
    readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; measurements.add(callback); }
    observe() {}
    unobserve() {}
    disconnect() { measurements.delete(this.callback); }
  }
  Object.defineProperty(browser.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(browser.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => height });
  for (const [name, value] of Object.entries({ window: browser.window, document: browser.window.document,
    navigator: browser.window.navigator, HTMLElement: browser.window.HTMLElement, ResizeObserver: ChartResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target), holder: HostUiHolder = {};
  const uninstall = installPublicUi(holder), ui = holder.__DEVICEFORGE_HOST_UI__; assert.ok(ui);
  const picked: number[] = [];
  const onPickX = (value: number) => picked.push(value);
  const render = () => root.render(createElement(ui.MultiTrackChart, {
    tracks: [{ id: 'cpu', series: [{ id: 'cpu', points: [{ x: 0, y: 5 }, { x: 1, y: null }] }] }],
    xDomain: [0, 1], insets: { left: 10, right: 10 }, ariaLabel: '按需图表', onPickX,
  }));
  return { target, root, browser, picked, measurements,
    render: async () => { await act(async () => { render(); }); },
    resize: async (nextWidth: number, nextHeight: number) => {
      width = nextWidth; height = nextHeight;
      await act(async () => { browser.window.document.dispatchEvent(new browser.window.Event('visibilitychange')); });
    },
    async close() {
      await act(async () => root.unmount()); await uninstall();
      assert.equal(measurements.size, 0, '图表销毁必须释放尺寸观察');
      browser.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('无尺寸图表不载入引擎，实际需要后卸载不接收晚到模块或创建画布', async () => {
  const f = await fixture();
  try {
    await f.render();
    assert.equal(engineLoads, 0); assert.equal(instances.length, 0);
    await f.resize(640, 240);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engineLoads, 1); assert.equal(instances.length, 0);
    await act(async () => { f.root.render(null); });
    loading.resolve();
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.equal(instances.length, 0, '已卸载图表不能因模块晚到重新创建画布');
    assert.equal(f.measurements.size, 0);
  } finally { loading.resolve(); await f.close(); }
});

test('按需图表保持缺测点、选点和尺寸更新，同实例只创建一次并释放事件及画布', async () => {
  const f = await fixture(), before = instances.length;
  try {
    await f.resize(640, 240); await f.render();
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.equal(instances.length, before + 1);
    const instance = instances[before]; assert.ok(instance);
    assert.equal(instance.target, f.target.querySelector('[aria-label="按需图表"]'));
    assert.match(JSON.stringify(instance.options), /\[1,null\]/);
    instance.clicks[0]?.({ offsetX: 20, offsetY: 20 });
    assert.deepEqual(f.picked, [12]);
    await f.resize(320, 180);
    assert.equal(instances.length, before + 1); assert.equal(instance.width, 320); assert.equal(instance.height, 180);
    assert.equal(instance.clicks.length, 1);
    await act(async () => f.root.render(null));
    assert.equal(instance.disposed, 1); assert.equal(instance.clicks.length, 0);
  } finally { await f.close(); }
});

test('图表初始化失败只显示本地错误，显式重试不重建插件页面', async () => {
  const f = await fixture(), before = instances.length;
  rejectCreate = true;
  try {
    await f.resize(640, 240); await f.render();
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.equal(f.target.querySelector('[role="alert"]')?.textContent, '图表初始化或绘制失败');
    const group = f.target.querySelector('[aria-label="按需图表"]'); assert.ok(group);
    const retry = f.target.querySelector<HTMLButtonElement>('button'); assert.ok(retry);
    rejectCreate = false;
    await act(async () => { retry.click(); });
    assert.equal(instances.length, before + 1);
    assert.equal(f.target.querySelector('[aria-label="按需图表"]'), group);
    assert.equal(f.target.querySelector('[role="alert"]') === null, true);
  } finally { rejectCreate = false; await f.close(); }
});
