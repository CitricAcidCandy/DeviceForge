import test from 'node:test';
import assert from 'node:assert/strict';
import type { HostContext, WorkspaceLayout } from '../src/plugin-sdk/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { createPointRegistry } from '../src/plugins/points/index.ts';
import { registerFilesTools, FILES_TOOLS_POINT } from '../plugins/files/src/tools.ts';
import { fileToolLayout } from '../plugins/files/src/tool-layout.ts';

test('文件工具布局只增删所属叶节点，保留原单页签、自定义内容和无关浮窗覆盖层', () => {
  const original: WorkspaceLayout = { version: 1,
    root: { kind: 'tabs', active: 'draft', items: [{ id: 'draft', node: { kind: 'custom',
      provider: { pluginId: 'other', viewId: 'other.layout' }, data: { unsaved: true },
      children: [{ kind: 'view', instanceId: 'other.content' }],
    } }] }, floating: [{ instanceId: 'other.float', x: 1, y: 1, width: 200, height: 200, z: 1 }],
    overlays: [{ instanceId: 'other.overlay', x: 2, y: 2, width: 200, height: 200, z: 1 }],
  };
  const before = JSON.stringify(original);
  assert.deepEqual(fileToolLayout(original, new Set(), []), original);
  const added = fileToolLayout(original, new Set(), ['files.tool.one', 'files.tool.two']);
  assert.equal(added.root?.kind, 'split');
  const removed = fileToolLayout(added, new Set(['files.tool.one', 'files.tool.two']), []);
  assert.deepEqual(removed, original);
  assert.equal(JSON.stringify(original), before);
});

test('文件工具一次装配失败不冻结新贡献，提供者更新和撤销只清自身实例并保留原草稿', async () => {
  const registry = createWorkspaceRegistry(), points = createPointRegistry(), lifetime = new AbortController();
  const ui = registry.access({ pluginId: 'deviceforge_files', generation: 1, signal: lifetime.signal });
  const own = points.access({ pluginId: 'deviceforge_files', generation: 1, signal: lifetime.signal, track: (release) => release });
  const externalLife = new AbortController();
  const external = points.access({ pluginId: 'third_party', generation: 1, signal: externalLife.signal, track: (release) => release });
  const original: WorkspaceLayout = { version: 1, root: { kind: 'view', instanceId: 'deviceforge_files.browser.main' }, floating: [], overlays: [] };
  ui.register({ workspaces: [{ id: 'deviceforge_files.workspace', title: '文件', defaultLayout: original }] });
  let failed = false, alerts = 0;
  const forbidden = async (): Promise<never> => { throw new Error('自动组合不派发业务'); };
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal, onDispose: (release) => release,
    listOperations: forbidden, submit: forbidden, cancelJob: forbidden, getJob: forbidden, subscribeOperations: () => () => {},
    ui: { ...ui, writeLayout(id, value) {
      if (!failed && value.root?.kind === 'split') { failed = true; throw new Error('单次布局写入失败'); }
      ui.writeLayout(id, value);
    } },
    extensions: { points: own, catalog: () => ({ components: [], commands: [], modules: [], services: [] }),
      executeCommand: forbidden, callService: forbidden, getState: () => undefined, setState() {},
      emitEvent() { alerts++; }, subscribeEvent: () => () => {}, subscribeState: () => () => {},
    },
  };
  const release = registerFilesTools(context);
  try {
    const contribution = external.contribute({ id: 'third_party.files', point: FILES_TOOLS_POINT, mode: 'append',
      data: { title: '扩展', pluginId: 'third_party', viewId: 'third_party.first' } });
    assert.equal(alerts, 1); assert.deepEqual(ui.readLayout('deviceforge_files.workspace'), original);
    assert.equal(ui.snapshot().instances.length, 0);
    contribution.update({ id: 'third_party.files', point: FILES_TOOLS_POINT, mode: 'append',
      data: { title: '扩展', pluginId: 'third_party', viewId: 'third_party.second' } });
    assert.equal(ui.snapshot().instances.length, 1);
    assert.equal(ui.snapshot().instances[0]?.provider?.viewId, 'third_party.second');
    const current = ui.readLayout('deviceforge_files.workspace'); assert.ok(current);
    ui.writeLayout('deviceforge_files.workspace', { ...current, floating: [
      { instanceId: 'other.unsaved', x: 4, y: 4, width: 200, height: 200, z: 1 },
    ] });
    externalLife.abort();
    assert.equal(ui.snapshot().instances.length, 0);
    assert.deepEqual(ui.readLayout('deviceforge_files.workspace')?.root, original.root);
    assert.equal(ui.readLayout('deviceforge_files.workspace')?.floating[0]?.instanceId, 'other.unsaved');
    assert.equal(alerts, 1, '独立新贡献成功不会擦掉原失败记录');
  } finally { await release(); lifetime.abort(); externalLife.abort(); points.dispose(); registry.dispose(); }
});
