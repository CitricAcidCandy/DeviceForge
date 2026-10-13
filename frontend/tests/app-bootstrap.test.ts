import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendBootstrap } from '../src/app/index.ts';
import { dom } from './dom-fixtures.ts';
import { job, success } from './fixtures.ts';

test('无界面 bootstrap 默认把插件挂载和主题目标接到宿主根节点', async () => {
  const target = dom();
  const bootstrap = createFrontendBootstrap({
    target,
    baseUrl: 'http://localhost:7031',
    transport: async () => success(job()),
  });
  const runtime = bootstrap.runtime;
  runtime.webPlugins.register({
    id: 'bootstrap-theme',
    trusted: true,
    plugin: {
      id: 'bootstrap-theme', version: '1', apiVersion: 2, panels: [],
      contributions: { themes: [{ id: 'bootstrap-theme.dark', title: '暗色', variables: { '--bootstrap-color': 'black' }, colorScheme: 'dark' }] },
    },
  });
  await runtime.webPlugins.load('bootstrap-theme');
  runtime.themes.select('bootstrap-theme.dark');
  assert.equal(target.style.getPropertyValue('--bootstrap-color'), 'black');
  assert.equal(target.style.getPropertyValue('color-scheme'), 'dark');
  assert.equal(runtime.host.themes?.snapshot().selected?.id, 'bootstrap-theme.dark');
  await Promise.all([bootstrap.dispose(), bootstrap.dispose()]);
  assert.equal(target.style.getPropertyValue('--bootstrap-color'), '');
  assert.equal(target.style.getPropertyValue('color-scheme'), '');
});
