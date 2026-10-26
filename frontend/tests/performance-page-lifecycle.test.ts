import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { createProductServices } from '../src/app/product/services.ts';
import type { ProductServices } from '../src/app/product/services.ts';
import type { PerformancePage, PerformanceSession } from '../src/features/performance/index.ts';
import { directory } from './device-fixtures.ts';
import { deferred, requestUrl, success } from './fixtures.ts';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const request = {
  target: { device_id: '192.168.208.237:8100', package: 'com.ChillyRoom.DungeonShooter' },
  interval_ms: 1000,
  duration_secs: 60,
};
function session(id = firstId, state: PerformanceSession['state'] = 'running', samples = 0): PerformanceSession {
  return { id, request, state, samples, revision: state === 'running' ? 0 : 1, started_at: 1000, updated_at: 2000, error: null };
}
function page(id: string, state: PerformanceSession['state'], after: number, count: number, total = after + count): PerformancePage {
  return {
    session: session(id, state, total), next_after: after + count,
    readings: Array.from({ length: count }, (_, index) => ({
      sequence: after + index + 1, captured_at: 1000 + (after + index) * 1000,
      pid: 26755, logical_cpus: 8, cpu_share_percent: index === 0 ? null : 18,
      cpu_core_percent: index === 0 ? null : 144, pss_kib: 141642, rss_kib: 235932,
    })),
  };
}
function pageModule(value: unknown): value is { PerformancePage: ComponentType<{ services: ProductServices }> } {
  return typeof value === 'object' && value !== null && 'PerformancePage' in value && typeof value.PerformancePage === 'function';
}
async function settled(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 300 && !condition(); attempt++)
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 10)); });
  assert.ok(condition(), message);
}

test('性能页创建后选择返回ID，空首屏继续增量读取、补齐终态并取消旧观测', async () => {
  const browser = new JSDOM('<div id="performance-test"></div>', { pretendToBeVisual: true, url: 'http://localhost:7031' });
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef, document: windowRef.document, navigator: windowRef.navigator,
    Element: windowRef.Element, HTMLElement: windowRef.HTMLElement, Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment, MutationObserver: windowRef.MutationObserver,
    HTMLInputElement: windowRef.HTMLInputElement, HTMLSelectElement: windowRef.HTMLSelectElement,
    HTMLTextAreaElement: windowRef.HTMLTextAreaElement, HTMLButtonElement: windowRef.HTMLButtonElement,
    HTMLFormElement: windowRef.HTMLFormElement, Document: windowRef.Document,
    Event: windowRef.Event, CustomEvent: windowRef.CustomEvent, FocusEvent: windowRef.FocusEvent,
    KeyboardEvent: windowRef.KeyboardEvent, MouseEvent: windowRef.MouseEvent, NodeFilter: windowRef.NodeFilter,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const calls: { id: string; after: number; signal: AbortSignal | null | undefined }[] = [];
  let mode: 'flow' | 'hold' | 'late' | 'inspect-fail' = 'flow';
  let starts = 0;
  let flowCompleted = false;
  const observedErrors: unknown[] = [];
  const submissions: unknown[] = [];
  const pending = deferred<Response>();
  const deviceDirectory = directory('android-device', 'g1', [request.target.device_id]);
  const deviceName = '性能测试设备';
  const services = createProductServices({
    baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path.endsWith('/operations')) return success(['start', 'inspect', 'samples', 'list', 'pause', 'resume', 'stop'].map((action) => ({
        id: 'android.performance.' + action, title: action, input_schema: { type: 'object' },
      })));
      if (path.endsWith('/devices')) return success([{
        ...deviceDirectory, devices: deviceDirectory.devices.map((device) => ({ ...device, model: deviceName })),
      }]);
      if (path.endsWith('/device-providers')) return success([deviceDirectory.provider]);
      if (path.endsWith('/jobs')) {
        assert.equal(typeof init?.body, 'string');
        const body: unknown = JSON.parse(String(init?.body));
        assert.ok(typeof body === 'object' && body !== null && 'operation' in body && 'input' in body);
        const operation = body.operation;
        const value = body.input;
        submissions.push(body);
        assert.ok(typeof operation === 'string' && typeof value === 'object' && value !== null);
        let result: unknown;
        if (operation.endsWith('.start')) {
          assert.deepEqual(value, request);
          starts++;
          result = session(starts === 1 ? firstId : secondId);
        } else if (operation.endsWith('.list')) {
          assert.deepEqual(value, { after_id: null, limit: 25 });
          result = { sessions: [], next_after_id: null };
        }
        else if (operation.endsWith('.inspect')) {
          assert.ok('session_id' in value && typeof value.session_id === 'string');
          if (mode === 'inspect-fail')
            return success({ id: 'inspect-failed-job', operation, input: value, created_at: 1, status: 'failed', result: null, error: '测试读取失败' }, 'inspect-failure-log');
          result = flowCompleted && mode === 'flow'
            ? session(value.session_id, 'completed', 102)
            : session(value.session_id);
        } else {
          assert.equal(operation, 'android.performance.samples');
          assert.ok('session_id' in value && typeof value.session_id === 'string' && 'after' in value && typeof value.after === 'number');
          calls.push({ id: value.session_id, after: value.after, signal: init?.signal });
          if (mode === 'hold') return pending.promise;
          if (mode === 'late' || mode === 'inspect-fail') result = page(value.session_id, 'running', value.after, 0);
          else if (calls.length === 1) result = page(firstId, 'running', 0, 0);
          else if (value.after === 0) result = page(firstId, 'running', 0, 1);
          else {
            result = page(firstId, 'completed', value.after, Math.min(100, 102 - value.after), 102);
            flowCompleted = true;
          }
        }
        return success({ id: 'performance-job', operation, input: value, created_at: 1, status: 'succeeded', result, error: null }, 'performance-query-log');
      }
      throw new Error('未预期请求：' + path);
    },
  });
  const server = await createServer({
    configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
    // 本用例验证会话和数据接线，不让 JSDOM 的 Canvas 缺失冒充业务失败。
    plugins: [{
      name: 'performance-lifecycle-chart-boundary', enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('/MultiTrackChart/index.tsx')) return '\0performance-lifecycle-chart';
      },
      load(id) {
        if (id === '\0performance-lifecycle-chart')
          return "import { createElement } from 'react'; export function MultiTrackChart() { return createElement('div', { 'data-chart-boundary': true }); }";
      },
    }],
  });
  const unsubscribeErrors = services.runtime.performance.subscribe((snapshot) => {
    if (snapshot.error !== null) observedErrors.push(snapshot.error);
  });
  const target = windowRef.document.getElementById('performance-test');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const button = (label: string, within: ParentNode = target) => {
    const found = Array.from(within.querySelectorAll('button')).find((item) => item.textContent?.trim() === label);
    assert.ok(found, '缺少操作：' + label);
    return found;
  };
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/pages/performance/index.tsx');
    assert.ok(pageModule(loaded));
    await services.runtime.operations.refresh(new AbortController().signal);
    await services.runtime.devices.refreshDirectories(new AbortController().signal);
    await services.runtime.devices.select({ providerId: 'android-device', generation: 'g1', localId: request.target.device_id });
    await act(async () => root.render(createElement(loaded.PerformancePage, { services })));
    const preparation = target.querySelector('[aria-label="采集准备"]');
    assert.ok(preparation, '尚未创建会话时应显示采集引导');
    assert.equal(preparation.querySelector('h2')?.textContent, '开始性能采集');
    assert.ok(preparation.textContent?.includes(deviceName), '引导应显示所选设备的真实名称');
    assert.equal(target.querySelector('[aria-label="采样数据面板"], [aria-label="等待采样数据"]'), null,
      '采集前不应展示会话内等待态或六条空轨');
    assert.doesNotMatch(target.textContent ?? '', /6 条轨道|图表区可滚动|无 CPU 观测|无内存观测/);
    assert.equal(submissions.length, 0, '渲染引导不能启动采集或读取会话');
    await act(async () => button('查看已有会话', preparation).click());
    const initialHistory = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(initialHistory, '历史入口应打开真实会话 Sheet');
    assert.ok(initialHistory.textContent?.includes('会话历史'));
    assert.deepEqual(submissions, [{ operation: 'android.performance.list', input: { after_id: null, limit: 25 } }],
      '历史入口只读取第一页历史，不得启动采集或选择会话');
    assert.equal(starts, 0);
    assert.equal(services.runtime.performance.snapshot().selection, null);
    assert.equal(calls.length, 0, '只打开历史不应启动样本轮询');
    await act(async () => button('关闭', initialHistory).click());
    assert.equal(windowRef.document.querySelector('[role="dialog"]'), null);
    assert.equal(button('开始采集').disabled, false);
    await act(async () => button('开始采集').click());
    const dialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /应用包名.*时长（秒）.*间隔（毫秒）.*先启动应用/,
      '引导按钮应打开原有真实采集配置');
    assert.equal(starts, 0, '打开配置不能直接启动采集');
    const field = dialog.querySelector('input[placeholder="com.forge.arena"]');
    assert.ok(field instanceof windowRef.HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(windowRef.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(field, request.target.package);
      field.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
      const checkbox = dialog.querySelector('[role="checkbox"]');
      assert.ok(checkbox instanceof windowRef.HTMLElement);
      checkbox.click();
    });
    assert.equal(button('开始采集', dialog).disabled, false, dialog.textContent ?? '');
    await act(async () => button('开始采集', dialog).click());
    assert.ok(submissions.length > 0, '未提交采集：' + dialog.textContent);
    assert.ok(submissions.some((value) => JSON.stringify(value).includes('android.performance.start')), JSON.stringify(submissions));
    await settled(() => services.runtime.performance.snapshot().selection === firstId, '创建成功后没有选中返回的会话ID');
    await settled(() => calls.length >= 2, '首轮没有样本后未继续读取');
    await settled(() => services.runtime.performance.snapshot().readings.length === 102, '未自动追加样本或未补齐终态分页');
    assert.deepEqual(calls.map((call) => call.after), [0, 0, 1, 101]);
    assert.match(target.textContent ?? '', /102 点/);
    assert.match(target.textContent ?? '', /已完成/);
    const finishedCalls = calls.length;
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 1100)); });
    assert.equal(calls.length, finishedCalls, '终态读完后仍在轮询');

    await act(async () => button('会话与明细').click());
    const historyDialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(historyDialog);
    const historyField = historyDialog.querySelector('input[placeholder="已知会话 ID"]');
    assert.ok(historyField instanceof windowRef.HTMLInputElement);
    assert.equal(historyField.value, firstId, '创建返回的ID没有保留供读取失败后重试');
    await act(async () => button('读取', historyDialog).click());
    assert.equal(services.runtime.performance.snapshot().readings.length, 102, '同ID重读清空了已完成会话的样本');
    await act(async () => windowRef.document.dispatchEvent(new windowRef.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    mode = 'hold';
    await act(async () => { await services.runtime.performance.select(secondId, new AbortController().signal); });
    await settled(() => calls.length > finishedCalls, '切换会话后未开始读取');
    const oldSignal = calls.at(-1)?.signal;
    assert.equal(oldSignal?.aborted, false);
    await act(async () => { await services.runtime.performance.select(firstId, new AbortController().signal); });
    assert.equal(oldSignal?.aborted, true, '切换选择没有取消旧读取');
    mode = 'late';
    await act(async () => pending.resolve(success({ id: 'late-job', operation: 'android.performance.samples', input: {}, created_at: 1, status: 'succeeded', result: page(secondId, 'running', 0, 1), error: null })));
    await settled(() => calls.at(-1)?.id === firstId, '晚到响应阻塞了新会话读取');
    assert.equal(services.runtime.performance.snapshot().readings.length, 0, '旧样本污染了当前会话');

    mode = 'inspect-fail';
    await act(async () => button('重新采集').click());
    const retryDialog = windowRef.document.querySelector('[role="dialog"]');
    assert.ok(retryDialog);
    await act(async () => button('开始采集', retryDialog).click());
    await settled(() => services.runtime.performance.snapshot().selection === secondId, '读取失败时没有保留已创建的ID');
    await settled(() => observedErrors.length > 0, '读取失败没有进入可重试的错误状态：' + JSON.stringify(submissions));
    const readError = observedErrors.at(-1);
    assert.ok(readError instanceof Error && 'logId' in readError);
    assert.equal(readError.logId, 'inspect-failure-log', '读取失败没有保留真实日志ID');
    assert.equal(windowRef.document.querySelector('[role="dialog"]'), null, '创建成功后弹窗仍诱导重复创建');
    assert.equal(starts, 2);
    await settled(() => calls.at(-1)?.id === secondId, '读取失败后没有继续只读追踪已创建会话');
    const finalSignal = calls.at(-1)?.signal;
    await act(async () => root.unmount());
    assert.equal(finalSignal?.aborted, true, '卸载后仍保留读取或定时器信号');
    const closedCalls = calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    assert.equal(calls.length, closedCalls, '卸载后仍发出样本请求');
  } finally {
    unsubscribeErrors();
    await act(async () => root.unmount());
    await services.dispose();
    pending.resolve(success(null));
    await server.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    browser.window.close();
  }
});
