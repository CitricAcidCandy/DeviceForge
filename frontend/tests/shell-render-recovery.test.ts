import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import type { DebugEventInput, Dispose, HostContext, PointAccess, UiAccess } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';

test('外壳挂载后的渲染异常可见且可显式恢复，同一业务DOM草稿保留并记录旧故障', async () => {
  const imports = registerCompositionStartupImports();
  const page = new JSDOM('<main></main>', { pretendToBeVisual: true, url: 'http://localhost/#/example' });
  const w = page.window, target = w.document.querySelector('main'); assert.ok(target);
  const globals: Readonly<Record<string, unknown>> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const owner = new AbortController(), registry = createWorkspaceRegistry(), points = createPointRegistry();
  const owned = { pluginId: 'fixture', generation: 1, signal: owner.signal };
  const pointAccess = points.access({ ...owned, track: (release) => release });
  let failed = false, renders = 0;
  const access: PointAccess = { ...pointAccess, list(ref) {
    if (failed) throw new Error('本次外壳渲染失败');
    return pointAccess.list(ref);
  } };
  registry.access(owned).register({ pages: [{ id: 'fixture.page', title: '原业务页', route: '/example', workspaceId: 'fixture.work',
    mount: async () => () => {} }] });
  const ui: UiAccess = { ...registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: owner.signal }),
    mount: async (_id, root) => {
      renders++; const input = w.document.createElement('input'); input.setAttribute('aria-label', '业务草稿'); root.append(input);
      return () => { input.remove(); };
    } };
  const forbidden = async (): Promise<never> => { throw new Error('恢复外壳不得派发业务'); };
  const reports: DebugEventInput[] = [];
  const context: HostContext = {
    apiVersion: 2, signal: owner.signal, ui, submit: forbidden, getJob: forbidden, cancelJob: forbidden,
    listOperations: async () => ({ data: [], logId: null }), subscribeOperations: () => () => {}, onDispose: (release) => release,
    extensions: { points: access, catalog: () => ({ components: [], modules: [], services: [], commands: [] }),
      callService: forbidden, executeCommand: forbidden, subscribeEvent: () => () => {}, emitEvent: () => {},
      getState: () => undefined, setState: () => {}, subscribeState: () => () => {} },
    debug: { emit: (event) => reports.push(event), registerNode: () => { throw new Error('未使用语义节点'); },
      registerResource: (_definition, release) => release },
  };
  const { mountShell } = await import('../plugins/default-shell/src/mount.tsx');
  let release: Dispose | undefined;
  try {
    await act(async () => { release = await mountShell(target, context); });
    const input = target.querySelector<HTMLInputElement>('[aria-label="业务草稿"]'); assert.ok(input);
    input.value = '不可丢失的原草稿'; assert.equal(renders, 1);
    failed = true;
    await act(async () => { pointAccess.define({ id: 'fixture.update', version: '1', title: '触发当前代刷新', modes: ['append'] }); });
    const failure = target.querySelector('[role="alert"]'); assert.ok(failure, '挂载后的异常不能留下无诊断空容器');
    assert.match(failure.textContent ?? '', /工作区显示中断/); assert.match(failure.textContent ?? '', /本次外壳渲染失败/);
    assert.equal(reports.filter((event) => event.name === 'shell.render.failed').length, 1);
    const retry = [...failure.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '重新显示工作区');
    assert.ok(retry); failed = false;
    await act(async () => { retry.click(); });
    assert.equal(target.querySelector('[role="alert"]'), null);
    assert.equal(target.querySelector('[aria-label="业务草稿"]'), input); assert.equal(input.value, '不可丢失的原草稿');
    assert.equal(renders, 1); assert.match(target.textContent ?? '', /显示故障历史 1/);
  } finally {
    await act(async () => { await release?.(); }); owner.abort(); registry.dispose(); points.dispose(); imports.dispose(); page.window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});
