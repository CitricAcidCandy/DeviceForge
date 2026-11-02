import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import ts from 'typescript';
import { act, createElement, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HistoricalJob, HostContext, HostResult, JsonValue, PluginTransport } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';

registerHooks({
  resolve(specifier, context, next) {
    const aliases: Readonly<Record<string, string>> = {
      '@deviceforge/plugin-sdk': 'src/plugin-sdk/index.ts',
      '@deviceforge/tasks/view': 'plugins/tasks/src/view.tsx',
    };
    const path = aliases[specifier];
    return path ? { shortCircuit: true, url: pathToFileURL(resolve(import.meta.dirname, '..', path)).href } : next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return { shortCircuit: true, format: 'module', source: '' };
    if (url.startsWith('file:') && url.endsWith('.tsx')) return {
      shortCircuit: true, format: 'module',
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: url, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText,
    };
    return next(url, context);
  },
});
const { createTasksModel, decodePublication, downloadTaskArtifact } = await import('../plugins/tasks/src/model/index.ts');
const { createTasksPlugin } = await import('../plugins/tasks/src/index.ts');
const firstId = 'd3be1c0c-eee8-43a6-9f47-f963ddbfc725';
const secondId = '31a501f3-ab38-4f84-8c70-d74bf6c86520';
const result = <T>(data: T, logId: string | null = null): HostResult<T> => ({ data, logId });
function job(id = firstId, overrides: Partial<HistoricalJob> = {}): HistoricalJob {
  return { id, operation: 'plugin.sample.run', status: 'running', result: null, error: null,
    input: {}, createdAt: 1_792_000_000_000, ...overrides };
}
function deferred<T>() {
  let finish: (value: T) => void = () => {};
  const promise = new Promise<T>((resolveValue) => { finish = resolveValue; });
  return { promise, resolve: finish };
}
function fixture(overrides: Partial<HostContext> = {}) {
  const controller = new AbortController();
  const calls: string[] = [];
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal,
    listOperations: async () => { calls.push('operations'); return result([]); },
    submit: async () => { calls.push('submit'); return result(job()); },
    getJob: async (id) => { calls.push(`get:${id}`); return result(job(id)); },
    cancelJob: async (id) => { calls.push(`cancel:${id}`); return result(job(id, { status: 'cancelled' })); },
    subscribeOperations: () => () => {},
    onDispose: (dispose) => dispose,
    taskHistory: {
      list: async (query) => { calls.push(`list:${query.limit ?? ''}`); return result([job()]); },
      get: async (id) => { calls.push(`history:${id}`); return result(job(id)); },
      events: async (id) => { calls.push(`events:${id}`); return result([]); },
    },
    ...overrides,
  };
  return { context, controller, calls };
}
function transport(request: PluginTransport['request']): PluginTransport {
  return {
    request, bytes: async () => { throw new Error('未使用字节接口'); },
    stream: async () => { throw new Error('未使用流接口'); },
  };
}

test('任务插件从清单身份工厂注册页面、全部任务归属与开放工具点，激活不执行业务', async () => {
  const registry = createWorkspaceRegistry();
  const points = createPointRegistry();
  const input = fixture();
  const owner = { pluginId: 'custom_tasks', generation: 1, signal: input.controller.signal };
  const pointAccess = points.access({ ...owner, track: (release) => release });
  const context: HostContext = {
    ...input.context, ui: registry.access(owner),
    extensions: {
      points: pointAccess, catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: async () => result(null), callService: async () => result(null),
      subscribeEvent: () => () => {}, emitEvent: () => {},
      getState: () => undefined, setState: () => {}, subscribeState: () => () => {},
    },
  };
  const plugin = createTasksPlugin({ id: 'custom_tasks', version: '9.2.1' });
  await plugin.activate?.(context);
  assert.equal(plugin.version, '9.2.1');
  assert.equal(context.ui?.catalog().pages[0]?.route, '/tasks');
  assert.equal(context.ui?.catalog().pages[0]?.navigation?.order, 90);
  assert.equal(context.ui?.catalog().pages[0]?.taskPolicy, 'all');
  assert.equal(pointAccess.catalog().definitions[0]?.id, 'custom_tasks.toolbar');
  assert.deepEqual(input.calls, []);
  input.controller.abort();
  assert.equal(registry.catalog().pages.length, 0);
  registry.dispose();
  points.dispose();
});

test('构造不发请求，列表分页上限与显式查询使用公开历史接口', async () => {
  const input = fixture();
  const model = createTasksModel(input.context);
  assert.deepEqual(input.calls, []);
  await model.list({ limit: 50 }, input.controller.signal);
  await model.list({ limit: 100 }, input.controller.signal);
  await assert.rejects(model.list({ limit: 201 }, input.controller.signal), { code: 'invalid_task_limit' });
  assert.deepEqual(input.calls, ['list:50', 'list:100']);
  model.dispose();
});
