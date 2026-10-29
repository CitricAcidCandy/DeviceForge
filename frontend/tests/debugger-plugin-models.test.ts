import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ballPosition, fit, initialRect, resizeByKey, snapPanel } from '../../examples/browser-debugger/src/geometry.ts';
import { decodeDirectory, decodeTree, parseJson, targetKey } from '../../examples/browser-debugger/src/protocol.ts';
import { schemaDefault, simpleSchema, validateInput } from '../../examples/browser-debugger/src/schema.ts';
import { filterNodes, nodeDepth } from '../../examples/browser-debugger/src/tree-utils.ts';
import { localReport, markdownReport } from '../../examples/browser-debugger/src/report.ts';
import { createDebuggerController } from '../../examples/browser-debugger/src/controller.ts';
import { decodeCatalog } from '../src/features/marketplace/services/catalog.ts';

test('桌面和940窄窗匹配确认的新稿几何，更小视口保持标题与控制入口在内', () => {
  assert.deepEqual(initialRect({ width: 1424, height: 805 }), { x: 112, y: 48, width: 1200, height: 704 });
  assert.deepEqual(initialRect({ width: 940, height: 760 }), { x: 16, y: 40, width: 908, height: 688 });
  for (const viewport of [{ width: 720, height: 480 }, { width: 390, height: 600 }, { width: 280, height: 320 }]) {
    const rect = fit({ x: 3000, y: -500, width: 2000, height: 1000 }, viewport);
    assert.ok(rect.x >= 0 && rect.y >= 0); assert.ok(rect.x + rect.width <= viewport.width);
    assert.ok(rect.y + rect.height <= viewport.height);
  }
});

test('尺寸方向键支持8与32像素，悬浮球吸最近边且限制在视口', () => {
  const viewport = { width: 1424, height: 805 }, rect = { x: 16, y: 64, width: 900, height: 600 };
  assert.equal(resizeByKey(rect, 'ArrowRight', false, viewport).width, 908);
  assert.equal(resizeByKey(rect, 'ArrowUp', true, viewport).height, 568);
  assert.equal(ballPosition(100, 700, viewport, true).x, 16);
  assert.equal(ballPosition(1200, 700, viewport, true).x, 1360);
  const ball = ballPosition(2000, 4000, { width: 390, height: 600 }, true);
  assert.equal(ball.x, 326); assert.equal(ball.y, 536);
});

test('面板拖动吸附四边含24像素阈值，25像素外保持位置且不改尺寸', () => {
  const viewport = { width: 1424, height: 805 }, rect = { x: 200, y: 100, width: 900, height: 600 };
  assert.deepEqual(snapPanel({ ...rect, x: 24 }, viewport), { ...rect, x: 16 });
  assert.deepEqual(snapPanel({ ...rect, x: 500 }, viewport), { ...rect, x: 508 });
  assert.deepEqual(snapPanel({ ...rect, y: 24 }, viewport), { ...rect, y: 16 });
  assert.deepEqual(snapPanel({ ...rect, y: 181 }, viewport), { ...rect, y: 189 });
  for (const position of [{ x: 25, y: 100 }, { x: 499, y: 100 }, { x: 200, y: 25 }, { x: 200, y: 180 }]) {
    const outside = { ...rect, ...position };
    assert.deepEqual(snapPanel(outside, viewport), outside);
  }
  assert.deepEqual(snapPanel({ ...rect, x: 24, y: 24 }, viewport), { ...rect, x: 16, y: 16 });
  assert.deepEqual(snapPanel({ ...rect, x: 500, y: 181 }, viewport), { ...rect, x: 508, y: 189 });
});

test('面板拖动吸附在窄窗内保留可用留白，尺寸调整本身不触发吸附', () => {
  const viewport = { width: 940, height: 760 }, narrow = initialRect(viewport);
  assert.deepEqual(snapPanel(narrow, viewport), narrow);
  const resized = resizeByKey({ x: 24, y: 24, width: 800, height: 600 }, 'ArrowRight', false, viewport);
  assert.deepEqual(resized, { x: 24, y: 24, width: 808, height: 600 });
  for (const small of [{ width: 720, height: 480 }, { width: 390, height: 600 }, { width: 280, height: 320 }]) {
    const result = snapPanel({ x: 3000, y: -500, width: 2000, height: 1000 }, small);
    const margin = Math.min(16, small.width / 20, small.height / 20);
    assert.ok(result.x >= margin && result.y >= margin);
    assert.ok(result.x + result.width <= small.width - margin);
    assert.ok(result.y + result.height <= small.height - margin);
  }
});

test('目录保持不同实例和服务器身份，不借用缺失代次', () => {
  const directory = decodeDirectory({ browser_instances: [
    { instance_id: 'first', plugins: [{ plugin_id: 'same', generation: '1' }] },
    { instance_id: 'second', plugins: [{ plugin_id: 'same' }] },
  ], browser_targets: [{ target_kind: 'browser', instance_id: 'first', plugin_id: 'same', generation: '1' }],
  server_plugins: [{ id: 'same', generation: 'server-1' }] });
  assert.equal(directory.length, 3);
  assert.equal(new Set(directory.map(targetKey)).size, 3);
  assert.equal(directory.find((item) => item.instanceId === 'second')?.generation, null);
  assert.equal(directory.find((item) => item.kind === 'server')?.instanceId, null);
});

test('语义过滤保留祖先路径，折叠不影响搜索；循环父链有界', () => {
  const tree = decodeTree({ id: 'snapshot', observedAt: 1, nodes: [
    { id: 'parent', generation: 1, revision: 1, parentId: null, role: 'group', name: '容器', hidden: 'no' },
    { id: 'child', generation: 1, revision: 1, parentId: 'parent', role: 'button', name: '确认', hidden: 'no' },
    { id: 'other', generation: 1, revision: 1, parentId: null, role: 'textbox', name: '其他', hidden: 'yes' },
  ] });
  assert.ok(tree);
  const none = { name: '', role: '', hidden: '', disabled: '' };
  assert.deepEqual(filterNodes(tree.nodes, none, new Set(['parent']), null).map((node) => node.id), ['parent', 'other']);
  assert.deepEqual(filterNodes(tree.nodes, { ...none, name: '确认' }, new Set(['parent']), null).map((node) => node.id), ['parent', 'child']);
  assert.deepEqual(filterNodes(tree.nodes, none, new Set(), ['child']).map((node) => node.id), ['parent', 'child']);
  const child = tree.nodes[1]; assert.ok(child); assert.equal(nodeDepth(child, tree.nodes), 1);
  assert.ok(nodeDepth({ ...child, parentId: 'child' }, tree.nodes) <= 1);
});

test('模式表单处理必填、枚举、数值边界与额外字段，复杂模式保留JSON入口', () => {
  const schema = { type: 'object', required: ['count', 'mode'], additionalProperties: false,
    properties: { count: { type: 'integer', minimum: 2, maximum: 4 }, mode: { type: 'string', enum: ['read', 'write'] }, enabled: { type: 'boolean' } } };
  assert.deepEqual(schemaDefault(schema), { count: 2, mode: 'read' });
  assert.deepEqual(validateInput({ count: 3, mode: 'read' }, schema), []);
  const errors = validateInput({ count: 1.5, mode: 'bad', unknown: true }, schema);
  assert.ok(errors.some((error) => error.includes('类型'))); assert.ok(errors.some((error) => error.includes('枚举')));
  assert.ok(errors.some((error) => error.includes('额外字段')));
  assert.equal(simpleSchema(schema), true); assert.equal(simpleSchema({ oneOf: [schema] }), false);
  assert.equal(simpleSchema({ $ref: '#/$defs/input', type: 'object' }), false);
  assert.throws(() => parseJson('{"invalid":}')); assert.throws(() => parseJson('1e999'), /有限 JSON/);
});

test('JSON和Markdown报告带过期与证据限制，导出不触发采集', async () => {
  const controller = createDebuggerController({ signal: new AbortController().signal });
  try {
    const state = { ...controller.snapshot(), stale: true, target: { kind: 'browser' as const, pluginId: 'name|unsafe',
      instanceId: 'instance', generation: '7', version: '1.0' }, logId: 'public-log' };
    const report = localReport(state, 0), markdown = markdownReport(state, 0);
    assert.match(JSON.stringify(report), /"stale":true/); assert.match(JSON.stringify(report), /不是整套安装/);
    assert.match(markdown, /已过期，只读/); assert.match(markdown, /name\\\|unsafe/); assert.match(markdown, /public-log/);
    assert.equal(controller.snapshot().sessionId, null);
  } finally { await controller.dispose(); }
});

test('包声明为普通浏览器API2入口，产物入口不指向宿主源码', async () => {
  const base = new URL('../../examples/browser-debugger/', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('plugin.json', base), 'utf8'));
  assert.equal(pkg.deviceforge.kind, 'browser'); assert.equal(pkg.deviceforge.entrypoints.any.path, 'dist/index.js');
  assert.equal(manifest.id, 'deviceforge_debugger'); assert.equal(manifest.api_version, 2);
  assert.ok(pkg.files.includes('market.json'));
  const source = await readFile(new URL('src/index.tsx', base), 'utf8');
  assert.match(source, /panels: \[\]/); assert.match(source, /slot: 'developer.tools', mode: 'append'/);
  assert.match(source, /data-deviceforge-debugger-internal/);
  assert.doesNotMatch(source, /import\s+(?!type\b).*frontend\/src/);
  const market = JSON.parse(await readFile(new URL('market.json', base), 'utf8'));
  const catalog = decodeCatalog({ entries: [market], total: 1, offset: 0, limit: 1 }, '本地单元测试');
  assert.deepEqual(catalog.entries[0]?.metadataIssues, []);
});
