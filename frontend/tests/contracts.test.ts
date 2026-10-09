import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContributions } from '../src/plugins/contracts.ts';
import type { WebPlugin } from '../src/plugin-sdk/index.ts';
const plugin: WebPlugin = {
  id: 'example', version: '1.0.0', apiVersion: 2,
  panels: [{ id: 'example.panel', title: '示例面板', mount: async () => () => {} }],
};
test('插件贡献接受独立命名空间并拒绝冲突', () => {
  assert.doesNotThrow(() => validateContributions([plugin]));
  assert.throws(() => validateContributions([plugin, plugin]), /重复/);
  assert.throws(() => validateContributions([{ ...plugin, panels: [...plugin.panels, ...plugin.panels] }]), /重复/);
  const panel = plugin.panels[0];
  assert.ok(panel);
  assert.throws(() => validateContributions([{ ...plugin, panels: [{ ...panel, id: 'other.panel' }] }]), /无效/);
});
