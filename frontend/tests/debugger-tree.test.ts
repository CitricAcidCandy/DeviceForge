import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { assertTree, createUiCollector, diffTrees, queryTree } from '../src/plugins/debugger/index.ts';
import { jsonBytes } from '../src/plugins/debugger/json.ts';

function fixture(html: string) {
  const dom = new JSDOM(`<main data-deviceforge-plugin="demo" data-deviceforge-generation="7">${html}</main>`);
  const root = dom.window.document.querySelector('main'); assert.ok(root);
  const collector = createUiCollector(root, { owner: { pluginId: 'demo', generation: 7 } });
  return { dom, root, collector, close() { collector.dispose(); dom.window.close(); } };
}

test('节点ID及修订跨无关刷新稳定，目标语义变化才改变修订或代次', () => {
  const item = fixture('<button type="button">执行</button><aside>旁边</aside>');
  try {
    const target = item.root.querySelector('button'); assert.ok(target);
    const first = item.collector.reference(target); assert.ok(first);
    const before = item.collector.snapshot();
    const aside = item.root.querySelector('aside'); assert.ok(aside); aside.textContent = '旁边刷新';
    assert.deepEqual(item.collector.reference(target), first);
    const after = item.collector.snapshot();
    assert.equal(diffTrees(before, after).changed.some((node) => node.id === first.id), false);
    target.textContent = '新标签';
    assert.equal(item.collector.resolve(first), null);
    const second = item.collector.reference(target); assert.ok(second);
    assert.equal(second.id, first.id); assert.equal(second.generation, first.generation); assert.ok(second.revision > first.revision);
    target.setAttribute('role', 'switch');
    const third = item.collector.reference(target); assert.ok(third); assert.ok(third.generation > second.generation);
  } finally { item.close(); }
});

test('输入框、密码、文本域、可编辑区及props均不被读取或序列化', () => {
  const item = fixture('<input aria-label="用户名"><input type="password"><textarea>文本域敏感内容</textarea><div contenteditable>可编辑敏感内容</div><button type="button">确定</button>');
  try {
    let reads = 0;
    for (const input of item.root.querySelectorAll('input,textarea')) {
      Object.defineProperty(input, 'value', { get() { reads++; throw new Error('禁止读值'); } });
    }
    Object.defineProperty(item.root, '__reactProps$private', { get() { reads++; throw new Error('禁止读props'); } });
    const serialized = JSON.stringify(item.collector.snapshot());
    assert.equal(reads, 0);
    assert.ok(!serialized.includes('文本域敏感内容')); assert.ok(!serialized.includes('可编辑敏感内容'));
    assert.ok(!serialized.includes('__reactProps')); assert.ok(!serialized.includes('password'));
    assert.ok(serialized.includes('用户名'));
  } finally { item.close(); }
});

test('按精确插件代际排除其他根及旧代根，不从标签引用跨所有权读取', () => {
  const item = fixture('<button type="button" aria-labelledby="private">公共</button><section data-deviceforge-plugin="other" data-deviceforge-generation="1"><span id="private">其他插件私密标签</span></section><section data-deviceforge-plugin="demo" data-deviceforge-generation="6">旧代私密标签</section>');
  try {
    const snapshot = item.collector.snapshot();
    assert.equal(snapshot.coverage.excludedPluginRoots, 2);
    assert.ok(!JSON.stringify(snapshot).includes('私密标签'));
    item.root.dataset['deviceforgeGeneration'] = '8';
    assert.equal(item.collector.snapshot().nodes.length, 0);
  } finally { item.close(); }
});

test('仅宿主注入的surface/slot/panel是扩展点，overview不采其他插件深层', () => {
  const item = fixture('<div data-deviceforge-slot="fake">普通标注</div><section id="slot"></section><aside data-deviceforge-plugin="other" data-deviceforge-generation="1"><button>不可读取</button></aside>');
  try {
    const slot = item.root.querySelector('#slot'), other = item.root.querySelector('aside'); assert.ok(slot); assert.ok(other);
    const collector = createUiCollector(item.root, { owner: { pluginId: 'demo', generation: 7 }, hostOverview: true, surfaces: [
      { id: 'main.slot', kind: 'slot', element: slot, owner: { pluginId: 'demo', generation: 7 } },
      { id: 'other.panel', kind: 'panel', element: other, owner: { pluginId: 'other', generation: 1 } },
    ] });
    try {
      const snapshot = collector.snapshot();
      assert.equal(snapshot.nodes.filter((node) => node.kind === 'slot').length, 1);
      assert.equal(snapshot.nodes.find((node) => node.surfaceId === 'other.panel')?.opaque, true);
      assert.equal(snapshot.nodes.find((node) => node.surfaceId === 'other.panel')?.actionPolicy, 'read-only');
      assert.ok(!JSON.stringify(snapshot).includes('不可读取'));
      assert.equal(snapshot.nodes.filter((node) => node.role === 'button').length, 0);
    } finally { collector.dispose(); }
  } finally { item.close(); }
});

test('公开DOM状态记录祖先hidden/disabled，原生有效性未声明时保留未知', () => {
  const item = fixture('<section hidden><button>隐藏</button></section><fieldset disabled><input required></fieldset><input aria-invalid="false">');
  try {
    const snapshot = item.collector.snapshot();
    assert.equal(snapshot.nodes.find((node) => node.name === '隐藏')?.hidden, 'yes');
    const input = item.root.querySelector('input'); assert.ok(input);
    const ref = item.collector.reference(input); assert.ok(ref);
    const state = snapshot.nodes.find((node) => node.id === ref.id); assert.ok(state);
    assert.equal(state.disabled, 'yes'); assert.equal(state.required, 'yes'); assert.equal(state.invalid, 'unknown');
    assert.equal(assertTree(snapshot, { query: { id: ref.id }, condition: 'valid' }).status, 'indeterminate');
  } finally { item.close(); }
});

test('tree query/assert报告通过、失败和不透明覆盖下的无法判定', () => {
  const item = fixture('<button type="button">确定</button>');
  try {
    const snapshot = item.collector.snapshot();
    assert.equal(queryTree(snapshot, { role: 'button', name: '确定' }).nodes.length, 1);
    assert.equal(assertTree(snapshot, { query: { role: 'button' }, condition: 'exists' }).status, 'passed');
    assert.equal(assertTree(snapshot, { query: { role: 'button' }, condition: 'absent' }).status, 'failed');
    assert.equal(assertTree(snapshot, { query: { role: 'checkbox' }, condition: 'absent' }).status, 'passed');
    const canvas = item.dom.window.document.createElement('canvas'); item.root.append(canvas);
    const opaque = item.collector.snapshot();
    assert.equal(opaque.coverage.virtual, 'unknown');
    assert.equal(assertTree(opaque, { query: { role: 'checkbox' }, condition: 'absent' }).status, 'indeterminate');
    assert.equal(diffTrees(snapshot, opaque).status, 'indeterminate');
    assert.equal(assertTree(opaque, { query: { role: 'button' }, condition: 'exists' }).status, 'passed');
  } finally { item.close(); }
});

test('CSS未隐藏不等于实际可见，无布局与遮挡证据的visible断言无法判定', () => {
  const item = fixture('<button type="button" style="width:0;height:0">零尺寸</button><button type="button" hidden>隐藏</button>');
  try {
    const snapshot = item.collector.snapshot();
    const shown = snapshot.nodes.find((node) => node.name === '零尺寸'); assert.ok(shown);
    assert.equal(shown.hidden, 'no'); assert.equal(shown.visible, 'unknown');
    assert.equal(assertTree(snapshot, { query: { id: shown.id }, condition: 'visible' }).status, 'indeterminate');
    const hidden = snapshot.nodes.find((node) => node.tag === 'button' && node.hidden === 'yes'); assert.ok(hidden);
    assert.equal(assertTree(snapshot, { query: { id: hidden.id }, condition: 'visible' }).status, 'failed');
  } finally { item.close(); }
});

test('注入的其他插件根也不通过父名称或aria-labelledby泄露，错误祖先所有权拒绝采集', () => {
  const item = fixture('<button type="button" aria-labelledby="other-label">公共</button><aside><span id="other-label">未标注插件私密名称</span></aside>');
  try {
    const other = item.root.querySelector('aside'); assert.ok(other);
    const collector = createUiCollector(item.root, { owner: { pluginId: 'demo', generation: 7 }, surfaces: [
      { id: 'other', kind: 'panel', element: other, owner: { pluginId: 'other', generation: 3 } },
    ] });
    try { assert.ok(!JSON.stringify(collector.snapshot()).includes('私密名称')); } finally { collector.dispose(); }
    const inner = item.root.querySelector('button'); assert.ok(inner);
    const wrong = createUiCollector(inner, { owner: { pluginId: 'other', generation: 3 } });
    try { assert.equal(wrong.snapshot().nodes.length, 0); } finally { wrong.dispose(); }
  } finally { item.close(); }
});

test('语义扩展是显式JSON输入，语义代次撤销旧引用且虚拟缺席保留未知', () => {
  const item = fixture('<div data-deviceforge-virtual></div>');
  let generation = 'first';
  const collector = createUiCollector(item.root, { owner: { pluginId: 'demo', generation: 7 },
    semantic: (element) => element.localName === 'div' ? { role: 'list', name: '主动语义', generation, metadata: { rendered: 0 } } : undefined });
  try {
    const element = item.root.querySelector('div'); assert.ok(element);
    const before = collector.reference(element); assert.ok(before);
    generation = 'second';
    assert.equal(collector.resolve(before), null);
    const after = collector.reference(element); assert.ok(after); assert.ok(after.generation > before.generation);
    const snapshot = collector.snapshot();
    assert.equal(assertTree(snapshot, { query: { role: 'listitem' }, condition: 'absent' }).status, 'indeterminate');
    assert.equal(assertTree(snapshot, { query: { name: '主动语义' }, condition: 'exists' }).status, 'passed');
  } finally { collector.dispose(); item.close(); }
});

test('500节点、1MiB响应、10快照与截断证据均有界', () => {
  const item = fixture('<div></div>'.repeat(520));
  try {
    const snapshot = item.collector.snapshot();
    assert.equal(snapshot.nodes.length, 500); assert.ok(snapshot.coverage.truncation.includes('nodes'));
    assert.equal(snapshot.bytes, jsonBytes(snapshot)); assert.ok(snapshot.bytes <= 1024 * 1024);
    for (let i = 0; i < 12; i++) item.collector.snapshot();
    assert.equal(item.collector.snapshots().length, 10);
    const collector = createUiCollector(item.root, { owner: { pluginId: 'demo', generation: 7 },
      semantic: () => ({ metadata: { description: '中'.repeat(4000) } }) });
    try {
      const large = collector.snapshot();
      assert.ok(large.nodes.length < 500); assert.ok(large.coverage.truncation.includes('bytes'));
      assert.equal(large.bytes, jsonBytes(large)); assert.ok(large.bytes <= 1024 * 1024);
      assert.equal(assertTree(large, { query: { role: 'missing' }, condition: 'exists' }).status, 'indeterminate');
    } finally { collector.dispose(); }
  } finally { item.close(); }
});

test('同一观测器内差异精确记录增删，不同实例不伪造可比较差异', () => {
  const item = fixture('<button type="button">旧节点</button>');
  try {
    const before = item.collector.snapshot();
    const target = item.root.querySelector('button'); assert.ok(target); target.remove();
    const button = item.dom.window.document.createElement('button'); button.textContent = '新节点'; item.root.append(button);
    const after = item.collector.snapshot();
    const diff = diffTrees(before, after);
    assert.equal(diff.status, 'comparable'); assert.equal(diff.added.length, 1); assert.equal(diff.removed.length, 1);
    const other = createUiCollector(item.root, { owner: { pluginId: 'demo', generation: 8 } });
    try { assert.equal(diffTrees(before, other.snapshot()).status, 'indeterminate'); } finally { other.dispose(); }
    item.collector.dispose(); assert.throws(() => item.collector.snapshot(), /销毁/);
  } finally { item.close(); }
});

test('diff组合接近上限的新节点与删除引用时也限制1MiB并明确截断', () => {
  const item = fixture('');
  try {
    const seed = item.collector.snapshot(), node = seed.nodes[0]; assert.ok(node);
    const heavy = { ...node, metadata: { description: 'x'.repeat(16000) } };
    const count = Math.floor((1024 * 1024 - 4096) / (jsonBytes(heavy) + 32));
    const before = { ...seed, nodes: Array.from({ length: 500 }, (_, index) => ({ ...node, id: `old-${index}` })) };
    const after = { ...seed, nodes: Array.from({ length: count }, (_, index) => ({ ...heavy, id: `new-${index}` })) };
    assert.ok(jsonBytes(after) <= 1024 * 1024);
    const diff = diffTrees(before, after);
    assert.ok(jsonBytes(diff) <= 1024 * 1024); assert.equal(diff.truncated, true); assert.equal(diff.status, 'indeterminate');
  } finally { item.close(); }
});

test('冻结快照分页可读取500以外节点，翻页不重采或消耗10份逻辑快照容量', () => {
  const item = fixture('<button type="button">原标签</button>'.repeat(620));
  try {
    const first = item.collector.snapshot();
    assert.equal(first.nodes.length, 500); assert.equal(first.page.total, 621); assert.equal(first.page.nextOffset, 500);
    const last = item.root.lastElementChild; assert.ok(last); last.textContent = '晚到更新';
    const next = item.collector.page(first.id, 500); assert.ok(next);
    assert.equal(next.page.nextOffset, null); assert.equal(next.nodes.length, 121);
    assert.equal(next.nodes.at(-1)?.name, '原标签');
    assert.equal(item.collector.snapshots().length, 1);
    assert.ok(next.bytes <= 1024 * 1024); assert.equal(next.bytes, jsonBytes(next));
    const reference = item.collector.reference(last); assert.ok(reference);
    assert.equal(item.collector.resolve(reference), last);
    assert.equal(item.collector.query({ name: '晚到更新' }).nodes[0]?.id, reference.id);
    assert.equal(item.collector.assert({ query: { id: reference.id }, condition: 'enabled' }).status, 'passed');
    assert.equal(item.collector.pages(first.id).flatMap((page) => page.nodes).length, 621);
    assert.throws(() => item.collector.page(first.id, 622), /偏移/);
    for (let index = 0; index < 10; index++) item.collector.snapshot();
    assert.equal(item.collector.page(first.id), null);
  } finally { item.close(); }
});

test('布局证据变化参与差异，视口或区域变化不撤销无关节点的局部引用', () => {
  const item = fixture('<button type="button">目标</button>');
  try {
    const button = item.root.querySelector('button'); assert.ok(button);
    const rect = new item.dom.window.DOMRect(10, 10, 50, 20);
    Object.defineProperty(button, 'getClientRects', { value: () => [rect] }); button.getBoundingClientRect = () => rect;
    let width = 100;
    Object.defineProperty(item.root, 'getClientRects', { value: () => [rect] });
    item.root.getBoundingClientRect = () => new item.dom.window.DOMRect(0, 0, width, 100);
    const reference = item.collector.reference(button); assert.ok(reference);
    const before = item.collector.snapshot(); width = 40;
    const after = item.collector.snapshot();
    assert.deepEqual(item.collector.reference(button), reference);
    assert.ok(diffTrees(before, after).changed.some((node) => node.id === reference.id));
  } finally { item.close(); }
});

test('同一DOM元素卸载再挂载拒绝旧引用，兄弟区域变更不撤销当前引用', () => {
  const item = fixture('<button type="button">目标</button><aside>兄弟</aside>');
  try {
    const button = item.root.querySelector('button'); assert.ok(button);
    const before = item.collector.reference(button); assert.ok(before);
    const aside = item.root.querySelector('aside'); assert.ok(aside); aside.append(item.dom.window.document.createElement('span'));
    assert.deepEqual(item.collector.reference(button), before);
    button.remove(); item.root.append(button);
    assert.equal(item.collector.resolve(before), null);
    const after = item.collector.reference(button); assert.ok(after); assert.notEqual(after.id, before.id);
  } finally { item.close(); }
});

test('客户端矩形区分视口、宿主区域和轴向裁切；复杂裁切与遮挡保留未知', () => {
  const item = fixture('<section style="overflow-x:hidden;overflow-y:hidden"><button type="button">裁切目标</button></section>');
  try {
    const button = item.root.querySelector('button'), section = item.root.querySelector('section'); assert.ok(button); assert.ok(section);
    function box(element: Element, x: number, y: number, width: number, height: number) {
      const rect = new item.dom.window.DOMRect(x, y, width, height);
      element.getBoundingClientRect = () => rect;
      Object.defineProperty(element, 'getClientRects', { value: () => [rect], configurable: true });
      Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
      Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
    }
    box(item.root, 0, 0, 300, 200); box(section, 10, 10, 100, 100); box(button, 90, 20, 40, 20);
    const snapshot = item.collector.snapshot();
    const node = snapshot.nodes.find((node) => node.tag === 'button'); assert.ok(node);
    assert.deepEqual(node.layout.rect, { x: 90, y: 20, width: 40, height: 20, top: 20, right: 130, bottom: 40, left: 90 });
    assert.equal(node.layout.intersection?.width, 20); assert.equal(node.layout.inViewport, 'yes');
    assert.equal(node.layout.withinRoot, 'yes'); assert.equal(node.layout.clipped, 'yes'); assert.equal(node.layout.occluded, 'unknown');
    for (const condition of ['in_viewport', 'within_root', 'nonzero_size']) {
      if (condition === 'in_viewport' || condition === 'within_root' || condition === 'nonzero_size')
        assert.equal(assertTree(snapshot, { query: { id: node.id }, condition }).status, 'passed');
    }
    assert.equal(assertTree(snapshot, { query: { id: node.id }, condition: 'unclipped' }).status, 'failed');
    section.style.clipPath = 'circle(20%)';
    const complex = item.collector.snapshot();
    assert.equal(complex.nodes.find((node) => node.tag === 'button')?.layout.clipped, 'unknown');
    assert.equal(assertTree(complex, { query: { role: 'button' }, condition: 'unclipped' }).status, 'indeterminate');
    assert.equal(assertTree(complex, { query: { role: 'button' }, condition: 'visible' }).status, 'indeterminate');
    section.style.clipPath = 'none'; section.style.borderTopLeftRadius = '20px';
    assert.equal(item.collector.snapshot().nodes.find((node) => node.tag === 'button')?.layout.clipped, 'unknown');
  } finally { item.close(); }
});

test('已知敏感输入和元数据字符串脱敏；自身调试器文字不进入父节点名称', () => {
  const item = fixture('<input name="api_key" aria-label="secret=哨兵"><button type="button">公开 <span data-deviceforge-debugger-internal>调试器内部哨兵</span></button>');
  const collector = createUiCollector(item.root, { owner: { pluginId: 'demo', generation: 7 },
    semantic: () => ({ metadata: { detail: 'Bearer 任意哨兵 token=另一个哨兵' } }) });
  try {
    const snapshot = collector.snapshot(), input = snapshot.nodes.find((node) => node.tag === 'input'); assert.ok(input);
    assert.equal(input.name, ''); assert.equal(input.opaque, true);
    const result = JSON.stringify(snapshot);
    for (const sentinel of ['任意哨兵', '另一个哨兵', '调试器内部哨兵', 'secret=哨兵']) assert.ok(!result.includes(sentinel));
  } finally { collector.dispose(); item.close(); }
});
