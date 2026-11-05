import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type {
  Dispose, HistoricalJob, HostContext, WorkspaceInstance, WorkspaceViewContext,
} from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

async function fixture(unit: TestContext) {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://127.0.0.1:7031/#/tasks', pretendToBeVisual: true,
  });
  const w = browser.window, document = w.document;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: w, document, navigator: w.navigator, HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement, HTMLButtonElement: w.HTMLButtonElement,
    Element: w.Element, Node: w.Node, NodeFilter: w.NodeFilter, MutationObserver: w.MutationObserver,
    DocumentFragment: w.DocumentFragment, CustomEvent: w.CustomEvent,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const timers = new Map<number, () => void>();
  let timerId = 0;
  Object.defineProperty(w, 'setInterval', { configurable: true, value: (callback: () => void, delay: number) => {
    assert.equal(delay, 10_000, '夹具只接管任务页原有十秒只读定时器');
    const id = ++timerId; timers.set(id, callback); return id;
  } });
  Object.defineProperty(w, 'clearInterval', { configurable: true, value: (id: number) => { timers.delete(id); } });
  unit.mock.method(globalThis, 'fetch', async () => { throw new Error('任务可见性单元禁止真实网络'); });
  const owner = new AbortController(), registry = createWorkspaceRegistry();
  const ui = registry.access({ pluginId: 'deviceforge_tasks', generation: 73, signal: owner.signal });
  const calls = { list: 0, get: 0, events: 0, forbidden: 0 };
  const job: HistoricalJob = { id: 'visible-task', operation: 'sample.read', status: 'running',
    input: { draft: '保留任务选择' }, result: null, error: null, createdAt: 1 };
  const forbidden = async (): Promise<never> => {
    calls.forbidden++; throw new Error('任务可见性不得派发、取消或读取实时业务任务');
  };
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, ui, onDispose: (release) => release,
    listOperations: forbidden, subscribeOperations: () => () => {},
    submit: forbidden, cancelJob: forbidden, getJob: forbidden,
    taskHistory: {
      async list(_query, signal) { signal.throwIfAborted(); calls.list++; return { data: [job], logId: 'tasks-list-log' }; },
      async get(id, signal) {
        signal.throwIfAborted(); calls.get++; assert.equal(id, job.id);
        return { data: job, logId: 'tasks-detail-log' };
      },
      async events(id, _query, signal) {
        signal.throwIfAborted(); calls.events++; assert.equal(id, job.id);
        return { data: [], logId: 'tasks-events-log' };
      },
    },
  };
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const releaseUi = installPublicUi();
  const { createTasksPlugin } = await import('../plugins/tasks/src/index.ts');
  const { mountTasks } = await import('../plugins/tasks/src/view.tsx');
  const plugin = createTasksPlugin({ id: 'deviceforge_tasks', version: '0.1.0' });
  await plugin.activate?.(context);
  const registered = registry.resolveView('deviceforge_tasks.list.main');
  assert.ok(registered, '必须通过真实任务插件登记的工作区视图挂载');
  const registeredDefinition = registered.definition, registeredInstance = registered.instance;
  const target = document.querySelector('main'); assert.ok(target);
  let release: Dispose | null = null;
  async function close() {
    const current = release; release = null;
    if (current) await act(async () => { await current(); });
  }
  unit.after(async () => {
    try {
      await close(); owner.abort(); registry.dispose(); await releaseUi();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      parser.dispose(); browser.window.close();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
  function view(visible = true) {
    const lifetime = new AbortController();
    let current: WorkspaceInstance = { ...registeredInstance.snapshot(), visible };
    const listeners = new Set<(visible: boolean) => void>();
    const instance: WorkspaceViewContext = {
      signal: lifetime.signal, snapshot: () => current,
      subscribeVisibility(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    return { instance, lifetime, listenerCount: () => listeners.size,
      setVisible(next: boolean) {
        current = { ...current, visible: next };
        for (const listener of [...listeners]) listener(next);
      },
    };
  }
  return { browser, document, target, context, calls, timers, view, close,
    async mount(instance?: WorkspaceViewContext) {
      await act(async () => {
        release = instance ? await registeredDefinition.mount(target, context, instance)
          : mountTasks(target, context);
      });
    },
    async tick() { await act(async () => { for (const callback of [...timers.values()]) callback(); }); },
  };
}

function query(root: ParentNode) {
  const input = root.querySelector<HTMLInputElement>('input[aria-label="按操作名、任务 ID 或日志 ID 查询"]');
  assert.ok(input); return input;
}
async function type(input: HTMLInputElement, value: string) {
  const w = input.ownerDocument.defaultView; assert.ok(w);
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set; assert.ok(setter);
  await act(async () => { setter.call(input, value); input.dispatchEvent(new w.Event('input', { bubbles: true })); });
}
function task(root: ParentNode) {
  const button = root.querySelector<HTMLButtonElement>('button[title="visible-task"]'); assert.ok(button); return button;
}

test('任务实例隐藏停止列表和选中项定时读取，恢复显示保留输入DOM、草稿及选择', async (unit) => {
  const f = await fixture(unit), current = f.view();
  await f.mount(current.instance);
  assert.equal(f.document.visibilityState, 'visible');
  assert.equal(f.calls.list, 1);
  const input = query(f.target);
  await act(async () => { task(f.target).click(); });
  assert.equal(task(f.target).getAttribute('aria-expanded'), 'true');
  assert.equal(f.calls.get, 1); assert.equal(f.calls.events, 1);
  await act(async () => { current.setVisible(false); });
  const hiddenCalls = { ...f.calls };
  await f.tick();
  assert.deepEqual(f.calls, hiddenCalls, '实例已隐藏时不得继续轮询列表或选中任务，即使DOM仍连接且无hidden属性');
  await type(input, '保留搜索草稿');
  await act(async () => { current.setVisible(true); });
  assert.equal(query(f.target), input);
  assert.equal(input.value, '保留搜索草稿');
  assert.equal(task(f.target).getAttribute('aria-expanded'), 'true');
  await type(input, '');
  const beforeTick = { ...f.calls };
  await f.tick();
  assert.ok(f.calls.list > beforeTick.list, '恢复可见后原只读列表刷新能够继续');
  assert.ok(f.calls.get > hiddenCalls.get && f.calls.events > hiddenCalls.events, '选中任务只读更新能够恢复');
  assert.equal(query(f.target), input);
  assert.equal(f.calls.forbidden, 0);
});

test('订阅间隙的最新任务可见性不会遗漏，实例退出撤销订阅与定时读取', async (unit) => {
  const f = await fixture(unit), current = f.view();
  let switched = false;
  const instance: WorkspaceViewContext = {
    ...current.instance,
    subscribeVisibility(listener) {
      if (!switched) {
        switched = true;
        // 父视图在快照读取后、实际登记前隐藏；不额外回放这次通知。
        current.setVisible(false);
      }
      return current.instance.subscribeVisibility(listener);
    },
  };
  await f.mount(instance);
  assert.equal(switched, true, '真实任务挂载必须接入当前工作区实例的可见性');
  assert.equal(instance.snapshot().visible, false);
  assert.ok(current.listenerCount() > 0);
  const hiddenCalls = { ...f.calls };
  await f.tick();
  assert.deepEqual(f.calls, hiddenCalls, '订阅后应核对最新快照，不能等下一次通知才停止轮询');
  await act(async () => { current.setVisible(true); });
  await f.tick();
  assert.ok(f.calls.list > hiddenCalls.list);
  const retainedCallbacks = [...f.timers.values()];
  await act(async () => { current.lifetime.abort(); });
  assert.equal(current.listenerCount(), 0);
  assert.equal(f.timers.size, 0, '实例取消后不得留下十秒任务定时器');
  const stoppedCalls = { ...f.calls };
  await act(async () => { for (const callback of retainedCallbacks) callback(); current.setVisible(true); });
  assert.deepEqual(f.calls, stoppedCalls, '取消前已取出的旧定时回调也不能再读取任务');
  await f.close();
  assert.equal(f.target.childElementCount, 0);
  assert.equal(current.listenerCount(), 0);
  assert.equal(f.calls.forbidden, 0);
});

test('旧直接任务挂载无需实例仍可用，移出DOM后不再轮询且返回保留草稿', async (unit) => {
  const f = await fixture(unit);
  await f.mount();
  assert.equal(f.calls.list, 1);
  const input = query(f.target);
  await act(async () => { task(f.target).click(); });
  const selectedCalls = { ...f.calls };
  f.target.remove();
  await f.tick();
  assert.deepEqual(f.calls, selectedCalls, '旧直接挂载的DOM已分离时也必须停止列表与选中项读取');
  await type(input, '离开时的搜索草稿');
  f.document.body.append(f.target);
  assert.equal(query(f.target), input);
  assert.equal(input.value, '离开时的搜索草稿');
  assert.equal(task(f.target).getAttribute('aria-expanded'), 'true');
  await type(input, '');
  await f.tick();
  assert.ok(f.calls.list > selectedCalls.list);
  assert.equal(query(f.target), input);
  await f.close();
  assert.equal(f.timers.size, 0);
  assert.equal(f.target.childElementCount, 0);
  assert.equal(f.calls.forbidden, 0);
});
