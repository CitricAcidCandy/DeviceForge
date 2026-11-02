import test from 'node:test';
import assert from 'node:assert/strict';
import { appendViewLayout } from '../browser/domain/layout.ts';
import type { WorkspaceLayout } from '@deviceforge/plugin-sdk';

test('跨页追加保留原布局、浮窗与覆盖层，不原地修改或猜测已有实例', () => {
  const original: WorkspaceLayout = {
    version: 1,
    root: { kind: 'split', direction: 'horizontal', weights: [0.7, 0.3],
      children: [{ kind: 'view', instanceId: 'original.screen' }, { kind: 'view', instanceId: 'original.apps' }] },
    floating: [{ instanceId: 'original.float', x: 10, y: 20, width: 200, height: 200, z: 2 }],
    overlays: [{ instanceId: 'original.overlay', relativeTo: 'original.screen',
      x: 2, y: 2, width: 20, height: 20, z: 1 }],
  };
  const before = structuredClone(original), next = appendViewLayout(original, 'suite.explicit');
  assert.deepEqual(original, before);
  assert.equal(next.root?.kind, 'tabs');
  if (next.root?.kind !== 'tabs') throw new Error('预期页签布局');
  assert.deepEqual(next.root.items[0]?.node, before.root);
  assert.deepEqual(next.root.items[1]?.node, { kind: 'view', instanceId: 'suite.explicit' });
  assert.deepEqual(next.floating, before.floating);
  assert.deepEqual(next.overlays, before.overlays);
  assert.throws(() => appendViewLayout(next, 'suite.explicit'), /已在布局中/);
});
