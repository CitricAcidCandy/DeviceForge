import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageAdoption } from '../src/app/product/page-adoption.ts';
import type { WorkspacePageInfo } from '../src/plugin-sdk/index.ts';

const page: WorkspacePageInfo = {
  id: 'business.page', pluginId: 'business', generation: 2,
  title: '业务', route: '/files', workspaceId: null, viewId: 'business.page',
};

test('迁移归属仅认真实页面与已加载代次，不按插件名称或未完成激活接管', () => {
  const current = createPageAdoption({ key: 'test' });
  current.observe([], [{ id: 'deviceforge_files', generation: 2, state: 'loaded' }], 'legacy');
  assert.equal(current.has('/files'), false);
  current.observe([page], [{ id: 'business', generation: 2, state: 'loading' }], 'legacy');
  assert.equal(current.has('/files'), false);
  current.observe([page], [{ id: 'business', generation: 1, state: 'loaded' }], 'legacy');
  assert.equal(current.has('/files'), false);
  current.observe([page], [{ id: 'business', generation: 2, state: 'loaded' }], 'legacy');
  assert.equal(current.has('/files'), true);
});

test('业务停用或浏览器重开不静默恢复旧宿主页面，其他旧页面不受影响', () => {
  let saved: string | null = null;
  const persistence = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  const current = createPageAdoption({ key: 'server-one', persistence });
  current.observe([page], [{ id: 'business', generation: 2, state: 'loaded' }], 'legacy');
  current.observe([], [], 'legacy');
  const next = createPageAdoption({ key: 'server-one', persistence });
  assert.equal(next.has('/files'), true);
  assert.equal(next.has('/marketplace'), false);
});

test('迁移记录损坏时保留原数据且不封锁本次实际迁移', () => {
  const invalid = '{not-json';
  let writes = 0;
  const current = createPageAdoption({ key: 'test', persistence: {
    getItem: () => invalid, setItem: () => { writes++; },
  } });
  current.observe([page], [{ id: 'business', generation: 2, state: 'loaded' }], 'legacy');
  assert.ok(current.error());
  assert.equal(current.has('/files'), true);
  assert.equal(writes, 0);
});
