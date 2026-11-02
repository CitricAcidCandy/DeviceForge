import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { HostError, hostUi } from '../src/plugin-sdk/index.ts';
import type {
  Dispose, HostContext, HostEvent, UiAccess,
} from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { deferred } from './fixtures.ts';

const providerId = 'deviceforge_device_views';
const firstId = 'workbench_test.first', secondId = 'workbench_test.second';

async function fixture() {
  const parser = registerCompositionStartupImports();
  assert.deepEqual(parser.diagnostics, []);
  const browser = new JSDOM('<!doctype html><html><body><div id="workbench"></div><div id="unrelated">其他界面</div></body></html>',
    { url: 'http://127.0.0.1:7031', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: browser.window, document: browser.window.document, navigator: browser.window.navigator,
    HTMLElement: browser.window.HTMLElement, Element: browser.window.Element, Node: browser.window.Node,
    NodeFilter: browser.window.NodeFilter, DocumentFragment: browser.window.DocumentFragment,
    HTMLInputElement: browser.window.HTMLInputElement, HTMLButtonElement: browser.window.HTMLButtonElement,
    HTMLSelectElement: browser.window.HTMLSelectElement, HTMLFormElement: browser.window.HTMLFormElement,
    CustomEvent: browser.window.CustomEvent, MutationObserver: browser.window.MutationObserver,
    getComputedStyle: browser.window.getComputedStyle.bind(browser.window),
    requestAnimationFrame: browser.window.requestAnimationFrame.bind(browser.window),
    cancelAnimationFrame: browser.window.cancelAnimationFrame.bind(browser.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { installPublicUi } = await import('../src/app/public-ui.ts');
  const removeUi = installPublicUi();
  const { WorkbenchChild } = await import('../plugins/devices/src/workbench-child.tsx');
  const publicUi = hostUi(), lifetime = new AbortController(), resources: Dispose[] = [];
  const registry = createWorkspaceRegistry();
  const access = registry.access({ pluginId: 'workbench_test', generation: 1, signal: lifetime.signal });
  const provider = registry.access({ pluginId: providerId, generation: 1, signal: lifetime.signal });
  access.register({ workspaces: [{ id: 'workbench_test.workspace', title: '工作台测试' }] });
  provider.register({ views: [{ id: `${providerId}.screen`, title: '设备画面', mount: async () => () => {} }] });
  for (const instanceId of [firstId, secondId]) access.open({
    instanceId, workspaceId: 'workbench_test.workspace',
    provider: { pluginId: providerId, viewId: `${providerId}.screen` },
  });
  const eventListeners = new Set<(event: HostEvent) => void>(), requests: string[] = [];
  const attempts: {
    readonly instanceId: string; readonly signal: AbortSignal; readonly element: HTMLElement;
    readonly input: HTMLInputElement; readonly ready: ReturnType<typeof deferred<Dispose>>;
    readonly releaseDone: ReturnType<typeof deferred<void>>;
    releaseCalls: number; holdRelease: boolean; released: boolean;
  }[] = [];
  const ui: UiAccess = {
    ...access,
    mount(instanceId, target, signal) {
      signal.throwIfAborted();
      const element = browser.window.document.createElement('section');
      element.dataset.instance = instanceId;
      const input = browser.window.document.createElement('input');
      input.setAttribute('aria-label', `${instanceId} 的草稿`);
      element.append(input); target.append(element);
      const ready = deferred<Dispose>(), releaseDone = deferred<void>();
      const attempt = {
        instanceId, signal, element, input, ready, releaseDone,
        releaseCalls: 0, holdRelease: false, released: false,
      };
      attempts.push(attempt);
      const release = async () => {
        if (attempt.released) return;
        attempt.released = true; attempt.releaseCalls++;
        if (attempt.holdRelease) await releaseDone.promise;
        element.remove();
      };
      // 受控公开挂载尊重原信号，晚到完成只清理所属节点。
      return new Promise<Dispose>((resolve, reject) => {
        let settled = false;
        const aborted = () => {
          if (!settled) { settled = true; reject(signal.reason); }
          element.remove();
        };
        signal.addEventListener('abort', aborted, { once: true });
        ready.promise.then(async () => {
          if (signal.aborted || settled) await release();
          else { settled = true; resolve(release); }
        }, (error: unknown) => {
          element.remove();
          if (!settled) { settled = true; reject(error); }
        }).finally(() => {
          if (!settled || signal.aborted) signal.removeEventListener('abort', aborted);
        }).catch(() => {});
      });
    },
  };
  const forbidden = async (name: string): Promise<never> => {
    requests.push(name); throw new Error(`挂载测试不得调用 ${name}`);
  };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, ui,
    listOperations: () => forbidden('listOperations'), submit: () => forbidden('submit'),
    getJob: () => forbidden('getJob'), cancelJob: () => forbidden('cancelJob'),
    subscribeOperations: () => () => {},
    onDispose(release) { resources.push(release); return release; },
    extensions: {
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: () => forbidden('executeCommand'), callService: () => forbidden('callService'),
      subscribeEvent(name, listener) {
        assert.equal(name, 'host.plugins.changed');
        eventListeners.add(listener); return () => { eventListeners.delete(listener); };
      },
      emitEvent() {}, getState: () => undefined, setState() {}, subscribeState: () => () => {},
    },
  };
  let changeInstance: (instanceId: string) => void = () => { throw new Error('界面尚未挂载'); };
  function View() {
    const [instanceId, setInstance] = publicUi.React.useState(firstId);
    changeInstance = setInstance;
    return publicUi.React.createElement(WorkbenchChild, { instanceId, context, ui });
  }
  const root = browser.window.document.getElementById('workbench');
  assert.ok(root);
  let releaseRoot: Dispose = () => {};
  await act(async () => { releaseRoot = publicUi.mountReact(root, publicUi.React.createElement(View)); });
  return {
    attempts, root, browser, requests,
    eventCount: () => eventListeners.size,
    async loaded(pluginId = providerId) {
      await act(async () => {
        for (const listener of [...eventListeners]) listener({
          name: 'host.plugins.changed', pluginId: 'host', generation: 1,
          data: { pluginId, stage: 'loaded' },
        });
      });
    },
    async resolve(index: number) {
      const attempt = attempts[index]; assert.ok(attempt);
      await act(async () => { attempt.ready.resolve(() => {}); });
    },
    async reject(index: number, error: unknown) {
      const attempt = attempts[index]; assert.ok(attempt);
      await act(async () => { attempt.ready.reject(error); });
    },
    async change(instanceId: string) { await act(async () => { changeInstance(instanceId); }); },
    async unmount() { await act(async () => { await releaseRoot(); }); },
    async dispose() {
      try {
        await act(async () => {
          for (const attempt of attempts) {
            attempt.holdRelease = false; attempt.releaseDone.resolve();
            attempt.ready.resolve(() => {});
          }
          await releaseRoot(); lifetime.abort();
          for (const resource of resources.reverse()) await resource();
        });
        assert.equal(eventListeners.size, 0, '卸载必须撤销宿主事件订阅');
        assert.deepEqual(requests, [], '挂载与重试不得提交或读取真实业务');
      } finally {
        registry.dispose(); await removeUi(); parser.dispose(); browser.window.close();
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}
type WorkbenchFixture = Awaited<ReturnType<typeof fixture>>;
function attempt(f: WorkbenchFixture, index = 0) {
  const entry = f.attempts[index];
  assert.ok(entry, `应存在第 ${index + 1} 次挂载`);
  return entry;
}
async function reopen(f: WorkbenchFixture) {
  const button = [...f.root.querySelectorAll<HTMLButtonElement>('button')]
    .find((entry) => entry.textContent === '重新打开');
  assert.ok(button, '失败后应提供显式重试');
  await act(async () => { button.click(); });
}

test('正常在途挂载不会被 loaded 通知取消或重建，完成后的草稿及挂载身份保持', async () => {
  const f = await fixture();
  try {
    assert.equal(f.attempts.length, 1);
    const first = attempt(f);
    first.input.value = '用户在慢挂载期间输入的草稿';
    await f.loaded('other_plugin');
    await f.loaded();
    assert.equal(first.signal.aborted, false, '正常在途挂载不能被插件 loaded 通知取消');
    assert.equal(f.attempts.length, 1, '正常挂载只调用一次');
    await f.resolve(0);
    assert.equal(f.root.querySelector('[role="status"]'), null);
    await f.loaded();
    assert.equal(f.attempts.length, 1);
    assert.equal(f.root.querySelector('input'), first.input);
    assert.equal(first.input.value, '用户在慢挂载期间输入的草稿');
    assert.equal(first.releaseCalls, 0);
  } finally { await f.dispose(); }
});

for (const failure of [
  { name: '普通业务错误', value: new Error('业务读取失败，不能自动重放'), message: '业务读取失败，不能自动重放' },
  { name: '未知拒绝', value: { reason: '写入结果尚未确认' }, message: '插件视图暂时无法显示' },
]) {
  for (const timing of ['before', 'after']) {
    test(`${failure.name}在 loaded ${timing === 'before' ? '先到' : '后到'}时均不自动重放，显式重新打开才挂载新代`, async () => {
      const f = await fixture();
      try {
        if (timing === 'before') await f.loaded();
        await f.reject(0, failure.value);
        if (timing === 'after') await f.loaded();
        assert.equal(f.attempts.length, 1, '普通或未知失败不能被 loaded 自动重放');
        assert.equal(f.root.querySelector('[role="alert"]')?.textContent, failure.message);
        await f.loaded();
        assert.equal(f.attempts.length, 1, '重复 loaded 也不能重放失败操作');
        await reopen(f);
        assert.equal(f.attempts.length, 2, '只有用户显式重试才再挂载');
        const retried = attempt(f, 1);
        await f.resolve(1);
        assert.equal(f.root.querySelector('[role="alert"]'), null);
        assert.equal(f.root.querySelector('[role="status"]'), null);
        retried.input.value = '显式重试后保留的草稿';
        await f.loaded();
        assert.equal(f.attempts.length, 2);
        assert.equal(f.root.querySelector('input'), retried.input);
        assert.equal(retried.input.value, '显式重试后保留的草稿');
      } finally { await f.dispose(); }
    });
  }
}

for (const timing of ['before', 'after']) {
  test(`明确提供者撤销兼容旧宿主 loaded ${timing === 'before' ? '先到' : '后到'}，只补挂一次且不影响成功实例`, async () => {
    const f = await fixture();
    try {
      if (timing === 'before') {
        await f.loaded();
        assert.equal(attempt(f).signal.aborted, false, 'loaded 先到时仍须等待原挂载给出明确失败');
        assert.equal(f.attempts.length, 1);
      }
      await f.reject(0, new HostError('cancelled', 'workspace_provider_revoked', '旧宿主尚未完成提供者就绪'));
      if (timing === 'after') {
        assert.equal(f.attempts.length, 1, '没有就绪事件时不自动连环补挂');
        await f.loaded();
      }
      assert.equal(f.attempts.length, 2, '明确撤销与就绪通知无论先后都只补挂一次');
      await f.resolve(1);
      const restored = attempt(f, 1);
      restored.input.value = '兼容恢复草稿';
      await f.loaded();
      await f.loaded();
      assert.equal(f.attempts.length, 2);
      assert.equal(restored.signal.aborted, false);
      assert.equal(f.root.querySelector('input'), restored.input);
      assert.equal(restored.input.value, '兼容恢复草稿');
      assert.equal(f.root.querySelector('[role="alert"]'), null);
      assert.equal(f.root.querySelector('[role="status"]'), null);
    } finally { await f.dispose(); }
  });
}

test('换实例撤销原信号，旧释放晚到只回收自有节点，卸载清理新实例及事件订阅', async () => {
  const f = await fixture();
  try {
    const previous = attempt(f);
    previous.holdRelease = true;
    await f.resolve(0);
    previous.input.value = '旧实例草稿';
    await f.change(secondId);
    assert.equal(previous.signal.aborted, true);
    assert.equal(previous.releaseCalls, 1);
    assert.equal(f.attempts.length, 2);
    const current = attempt(f, 1);
    assert.equal(current.instanceId, secondId);
    assert.equal(current.signal.aborted, false);
    await f.resolve(1);
    current.input.value = '新实例草稿';
    await act(async () => { previous.releaseDone.resolve(); });
    assert.equal(f.root.querySelector('input'), current.input);
    assert.equal(current.input.value, '新实例草稿');
    assert.equal(current.releaseCalls, 0);
    assert.equal(previous.releaseCalls, 1);
    await f.unmount();
    assert.equal(current.signal.aborted, true);
    assert.equal(current.releaseCalls, 1);
    assert.equal(f.eventCount(), 0);
    assert.equal(f.root.childElementCount, 0);
    assert.equal(f.browser.window.document.getElementById('unrelated')?.textContent, '其他界面');
  } finally { await f.dispose(); }
});
