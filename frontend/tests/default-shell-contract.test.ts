import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import createDefaultShell from '../plugins/default-shell/src/index.ts';
import type { HostContext, PointAccess, PointDefinition, PointContribution } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';

test('外壳是普通WebPlugin，用公开UI和扩展点登记且不自行抢占选择', async () => {
  const registry = createWorkspaceRegistry();
  const signal = new AbortController();
  const definitions: PointDefinition[] = [], contributions: PointContribution[] = [];
  let selections = 0;
  const releases: (() => void | Promise<void>)[] = [];
  const points: PointAccess = {
    define(value) { definitions.push(value); return () => {}; },
    contribute(value) { contributions.push(value); return { update() {}, dispose() {} }; },
    catalog: () => ({ definitions: [], contributions: [] }), list: () => [], selected: () => null,
    select() { selections++; }, subscribe: () => () => {},
  };
  const never = () => new Promise<never>(() => {});
  const context: HostContext = {
    apiVersion: 2, signal: signal.signal,
    ui: { ...registry.access({ pluginId: 'deviceforge_shell', generation: 1, signal: signal.signal }), mount: never },
    listOperations: async () => ({ data: [], logId: null }), submit: never, getJob: never, cancelJob: never,
    subscribeOperations: () => () => {}, onDispose(value) { releases.push(value); return value; },
    extensions: {
      points, catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      executeCommand: never, callService: never, subscribeEvent: () => () => {}, emitEvent() {},
      getState: () => undefined, setState() {}, subscribeState: () => () => {},
    },
  };
  const plugin = createDefaultShell({ id: 'deviceforge_shell', version: '0.1.0', apiVersion: 2 });
  await plugin.activate?.(context);
  assert.equal(plugin.id, 'deviceforge_shell');
  assert.deepEqual(registry.catalog().views.map((view) => view.id), ['deviceforge_shell.root']);
  assert.deepEqual(definitions.map((point) => point.id), ['deviceforge_shell.header', 'deviceforge_shell.sidebar', 'deviceforge_shell.footer']);
  assert.deepEqual(contributions[0]?.data, { pluginId: 'deviceforge_shell', viewId: 'deviceforge_shell.root' });
  assert.equal(selections, 0);
  for (const release of releases.reverse()) await release();
  registry.dispose();
});

test('独立插件源码仅导入自身模块、公开SDK与共享React，不读取宿主私有实现', async () => {
  const root = fileURLToPath(new URL('../plugins/default-shell/src/', import.meta.url));
  for (const file of await readdir(root)) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = await readFile(resolve(root, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith('.')) {
        const resolved = resolve(dirname(resolve(root, file)), specifier);
        assert.ok(resolved.startsWith(root.endsWith(sep) ? root : `${root}${sep}`), `${file}越过独立插件边界`);
      } else assert.ok(['@deviceforge/plugin-sdk', 'react', 'react-dom', 'react-dom/client'].includes(specifier), `${file}存在未声明的宿主依赖${specifier}`);
    }
    assert.equal(/:\s*any\b|\bas\s+(?!const\b)[A-Z][A-Za-z<]/.test(source), false, `${file}不能放宽严格类型`);
  }
});
