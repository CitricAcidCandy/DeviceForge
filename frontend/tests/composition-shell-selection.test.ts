import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { startShellSelection } from '../src/app/composition/shell-selection.ts';
import { SHELL_POINT } from '../src/app/composition/shell-host.ts';
import type { Dispose, WebPlugin } from '../src/plugin-sdk/index.ts';

async function fixture() {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('选择外壳不应发送业务请求'); },
  });
  async function add(id: string) {
    const plugin: WebPlugin = { id, version: '1.0.0', apiVersion: 2, panels: [], async activate(context) {
      context.extensions?.points?.contribute({ id: `${id}.shell`, point: SHELL_POINT, mode: 'replace', data: { pluginId: id, viewId: `${id}.root` } });
    } };
    runtime.bundledPlugins.register({ id, trusted: true, plugin });
    await runtime.webPlugins.load(id);
  }
  const data = new Map<string, string>();
  const persistence = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const releases: Dispose[] = [];
  return { runtime, add, data, persistence, releases, async dispose() {
    for (const release of releases) await release();
    await runtime.dispose();
  } };
}

test('首次配置只选择稳定目录中的官方外壳，不按加载先后或外部插件抢占', async () => {
  const f = await fixture();
  try {
    await f.add('external'); await f.add('official_b'); await f.add('official_a');
    f.releases.push(startShellSelection(f.runtime.host, new Set(['official_a', 'official_b']), { key: 'shell', persistence: f.persistence }));
    assert.equal(f.runtime.host.extensions?.points?.selected(SHELL_POINT)?.id, 'official_a.shell');
    await f.add('another');
    assert.equal(f.runtime.host.extensions?.points?.selected(SHELL_POINT)?.id, 'official_a.shell');
  } finally { await f.dispose(); }
});

test('保存的外壳缺失或显式不选时保留恢复态，不自动退回另一个提供者', async () => {
  for (const preference of [null, 'removed.shell']) {
    const f = await fixture();
    try {
      await f.add('official');
      f.data.set('shell', JSON.stringify(preference));
      f.releases.push(startShellSelection(f.runtime.host, new Set(['official']), { key: 'shell', persistence: f.persistence }));
      assert.equal(f.runtime.host.extensions?.points?.selected(SHELL_POINT), null);
      assert.equal(f.data.get('shell'), JSON.stringify(preference));
    } finally { await f.dispose(); }
  }
});

test('显式切换持久保存选择，解除订阅后不会继续写入旧会话', async () => {
  const f = await fixture();
  try {
    await f.add('official'); await f.add('custom');
    const release = startShellSelection(f.runtime.host, new Set(['official']), { key: 'shell', persistence: f.persistence });
    f.runtime.host.extensions?.points?.select(SHELL_POINT, 'custom.shell');
    assert.equal(f.data.get('shell'), '"custom.shell"');
    await release();
    f.runtime.host.extensions?.points?.select(SHELL_POINT, null);
    assert.equal(f.data.get('shell'), '"custom.shell"');
  } finally { await f.dispose(); }
});

test('外壳提供者撤销不改写已选意图，重新加载保留同一选择而非回退其他外壳', async () => {
  const f = await fixture();
  try {
    await f.add('official'); await f.add('custom');
    f.releases.push(startShellSelection(f.runtime.host, new Set(['official']), { key: 'shell', persistence: f.persistence }));
    const points = f.runtime.host.extensions?.points; assert.ok(points);
    points.select(SHELL_POINT, 'custom.shell');
    await f.runtime.webPlugins.unload('custom');
    assert.equal(points.selected(SHELL_POINT), null);
    assert.equal(f.data.get('shell'), '"custom.shell"', '暂时不可用不能持久化成用户清空选择');
    await f.runtime.webPlugins.load('custom');
    assert.equal(points.selected(SHELL_POINT)?.id, 'custom.shell');
    assert.equal(f.data.get('shell'), '"custom.shell"');
  } finally { await f.dispose(); }
});

test('提供者缺失时显式清空选择仍持久生效，恢复提供者不重新抢占', async () => {
  const f = await fixture();
  try {
    await f.add('official');
    f.releases.push(startShellSelection(f.runtime.host, new Set(['official']), { key: 'shell', persistence: f.persistence }));
    const points = f.runtime.host.extensions?.points; assert.ok(points);
    await f.runtime.webPlugins.unload('official');
    assert.equal(f.data.get('shell'), undefined, '默认选择的暂时撤销不应写入null');
    points.select(SHELL_POINT, null);
    assert.equal(f.data.get('shell'), 'null');
    await f.runtime.webPlugins.load('official');
    assert.equal(points.selected(SHELL_POINT), null);
  } finally { await f.dispose(); }
});
