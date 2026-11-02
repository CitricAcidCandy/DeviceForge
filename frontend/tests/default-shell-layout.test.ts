import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspaceLayout } from '../src/plugin-sdk/index.ts';
import {
  emptyLayout, placeView, removeView, replaceView, reorderView, resizeSplit,
  changeFloating, selectTab, visibleInstances, customChildren,
} from '../plugins/default-shell/src/layout.ts';
import { floatingPosition } from '../plugins/default-shell/src/floating.ts';

test('布局增删覆盖分栏页签浮窗覆盖层，不修改原快照或重复引用实例', () => {
  const original = emptyLayout();
  const split = placeView(placeView(original, 'a', 'split'), 'b', 'split');
  assert.equal(original.root, null);
  assert.equal(split.root?.kind, 'split');
  const tabs = placeView(split, 'c', 'tabs');
  assert.equal(tabs.root?.kind, 'tabs');
  const floating = placeView(tabs, 'b', 'floating');
  assert.equal(floating.floating[0]?.instanceId, 'b');
  assert.deepEqual([...visibleInstances(floating)], ['c', 'b']);
  const overlay = placeView(floating, 'b', 'overlay');
  assert.equal(overlay.floating.length, 0);
  assert.equal(overlay.overlays[0]?.width, 300);
  assert.equal(removeView(overlay, 'b').overlays.length, 0);
});

test('替换与重排保留分栏比例及实例独立身份', () => {
  const original: WorkspaceLayout = {
    ...emptyLayout(), root: { kind: 'split', direction: 'horizontal', weights: [0.7, 0.3], children: [
      { kind: 'view', instanceId: 'a' }, { kind: 'view', instanceId: 'b' },
    ] },
  };
  const replaced = replaceView(original, 'a', 'new');
  assert.equal(replaced.root?.kind, 'split');
  if (replaced.root?.kind !== 'split') throw new Error('缺少分栏');
  assert.deepEqual(replaced.root.weights, [0.7, 0.3]);
  assert.deepEqual(replaced.root.children[0], { kind: 'view', instanceId: 'new' });
  const reordered = reorderView(replaced, 'new', 1);
  assert.deepEqual(reordered.root?.kind === 'split' ? reordered.root.children[0] : null, { kind: 'view', instanceId: 'b' });
  assert.equal(original.root?.kind, 'split');
  assert.deepEqual(original.root?.kind === 'split' ? original.root.children[0] : null, { kind: 'view', instanceId: 'a' });
});

test('页签路径只更新指定节点，隐藏项不进入可见实例目录', () => {
  const layout: WorkspaceLayout = {
    ...emptyLayout(), root: { kind: 'split', direction: 'vertical', weights: [1, 1], children: [
      { kind: 'tabs', active: 'one', items: [
        { id: 'one', node: { kind: 'view', instanceId: 'a' } }, { id: 'two', node: { kind: 'view', instanceId: 'b' } },
      ] },
      { kind: 'tabs', active: 'one', items: [
        { id: 'one', node: { kind: 'view', instanceId: 'c' } }, { id: 'two', node: { kind: 'view', instanceId: 'd' } },
      ] },
    ] },
  };
  assert.deepEqual([...visibleInstances(selectTab(layout, [0], 'two'))], ['b', 'c']);
  assert.deepEqual([...visibleInstances(layout)], ['a', 'c']);
});

test('分栏和浮动几何受限，缩放移动保持另一浮窗不变', () => {
  const layout = placeView(placeView(emptyLayout(), 'a', 'floating'), 'b', 'overlay');
  const next = changeFloating(layout, 'a', { x: -20, y: 100000, width: 0, height: 100000, z: 2000 });
  assert.deepEqual(next.floating[0], { instanceId: 'a', x: 0, y: 8000, width: 200, height: 3000, z: 1000 });
  assert.deepEqual(next.overlays, layout.overlays);
  const split = resizeSplit(placeView(placeView(emptyLayout(), 'a', 'split'), 'b', 'split'), [], 100);
  assert.deepEqual(split.root?.kind === 'split' ? split.root.weights : null, [0.85, 0.15000000000000002]);
});

test('自定义布局描述只携带JSON数据，不把函数或运行对象带入目标', () => {
  const value = customChildren({
    kind: 'custom', provider: { pluginId: 'other', viewId: 'other.layout' }, data: { gap: 16 },
    children: [{ kind: 'view', instanceId: 'a' }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(value)), {
    kind: 'custom', provider: { pluginId: 'other', viewId: 'other.layout' }, data: { gap: 16 },
    children: [{ kind: 'view', instanceId: 'a' }],
  });
});

test('浮动显示夹紧当前画布，缩窗保留原持久布局且至少可见拖动区', () => {
  const view = { instanceId: 'a', x: 8000, y: 8000, width: 640, height: 480, z: 1 };
  const result = floatingPosition(view, { x: 0, y: 0, width: 320, height: 240 });
  assert.deepEqual(result, { x: 200, y: 160, width: 320, height: 240, left: 200, top: 160 });
  assert.equal(view.x, 8000);
  assert.equal(view.width, 640);
});

test('覆盖层坐标相对真实视图锚点，而不是重复套用画布原点', () => {
  assert.deepEqual(floatingPosition(
    { instanceId: 'a', x: 20, y: 15, width: 300, height: 140, z: 1 },
    { x: 180, y: 70, width: 400, height: 300 },
  ), { x: 20, y: 15, width: 300, height: 140, left: 200, top: 85 });
});
