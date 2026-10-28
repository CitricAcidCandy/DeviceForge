import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createDebugActions, createUiCollector } from '../src/plugins/debugger/index.ts';

function fixture(html: string) {
  const dom = new JSDOM(`<main data-deviceforge-plugin="demo" data-deviceforge-generation="7">${html}</main>`, { url: 'https://example.invalid/' });
  const root = dom.window.document.querySelector('main'); assert.ok(root);
  const collector = createUiCollector(root, { owner: { pluginId: 'demo', generation: 7 } });
  const lifetime = new AbortController();
  const actions = createDebugActions(collector, { signal: lifetime.signal });
  const signal = new AbortController().signal;
  function target(selector: string) {
    assert.ok(root);
    const element = root.querySelector(selector); assert.ok(element);
    const ref = collector.reference(element); assert.ok(ref);
    return { element, ref };
  }
  return { dom, root, collector, lifetime, actions, signal, target,
    close() { actions.dispose(); collector.dispose(); dom.window.close(); } };
}

test('点击仅派发合成事件且返回业务未知，无确认不派发', async () => {
  const item = fixture('<button type="button" data-deviceforge-action="local">本地</button>');
  try {
    const target = item.target('button'); let clicks = 0;
    target.element.addEventListener('click', () => { clicks++; });
    assert.equal((await item.actions.execute({ type: 'click', target: target.ref }, item.signal)).status, 'rejected');
    assert.equal(clicks, 0);
    const reply = await item.actions.execute({ type: 'click', target: target.ref, confirmed: true }, item.signal);
    assert.equal(reply.status, 'dispatched'); assert.equal(reply.businessOutcome, 'unknown'); assert.equal(clicks, 1);
  } finally { item.close(); }
});

test('禁用、隐藏、校验失败、真实设备、未知副作用、表单与链接均不自动点击', async () => {
  const item = fixture('<button type="button" disabled data-deviceforge-action="local">禁用</button><button type="button" hidden data-deviceforge-action="local">隐藏</button><button type="button" aria-invalid="true" data-deviceforge-action="local">无效</button><button type="button" data-deviceforge-action="device">设备</button><button type="button">未知</button><button data-deviceforge-action="local">提交</button><a href="/x" data-deviceforge-action="local">跳转</a>');
  try {
    let clicks = 0; item.root.addEventListener('click', () => { clicks++; });
    for (const element of item.root.children) {
      const ref = item.collector.reference(element); assert.ok(ref);
      assert.equal((await item.actions.execute({ type: 'click', target: ref, confirmed: true }, item.signal)).status, 'rejected');
    }
    assert.equal(clicks, 0);
  } finally { item.close(); }
});

test('旧修订、旧节点、旧插件代际在执行前被拒绝', async () => {
  const item = fixture('<button type="button" data-deviceforge-action="local">原节点</button>');
  try {
    const target = item.target('button'); target.element.textContent = '新标签';
    assert.equal((await item.actions.execute({ type: 'click', target: target.ref, confirmed: true }, item.signal)).status, 'rejected');
    const current = item.collector.reference(target.element); assert.ok(current);
    item.root.dataset['deviceforgeGeneration'] = '8';
    assert.equal((await item.actions.execute({ type: 'click', target: current, confirmed: true }, item.signal)).status, 'rejected');
  } finally { item.close(); }
});

test('未知副作用需确认与独立授权，授权不能绕过设备、隐藏或禁用', async () => {
  const item = fixture('<button type="button">旧插件本地节点</button><button type="button" data-deviceforge-action="device">设备</button><button type="button" disabled>禁用</button><button type="button" hidden>隐藏</button><button type="button" data-deviceforge-action="read-only">只读</button>');
  try {
    const target = item.target('button'); let clicks = 0; target.element.addEventListener('click', () => { clicks++; });
    assert.equal((await item.actions.execute({ type: 'click', target: target.ref, confirmed: true }, item.signal)).status, 'rejected');
    assert.equal((await item.actions.execute({ type: 'click', target: target.ref, allowUnknownSideEffects: true }, item.signal)).status, 'rejected');
    assert.equal((await item.actions.execute({ type: 'click', target: target.ref, confirmed: true, allowUnknownSideEffects: true }, item.signal)).status, 'dispatched');
    assert.equal(clicks, 1);
    for (const element of [...item.root.children].slice(1)) {
      const ref = item.collector.reference(element); assert.ok(ref);
      assert.equal((await item.actions.execute({ type: 'click', target: ref, confirmed: true, allowUnknownSideEffects: true }, item.signal)).status, 'rejected');
    }
  } finally { item.close(); }
});

test('填值不读取旧值或回显请求值，原生校验不通过时保持原控件', async () => {
  const item = fixture('<input type="email" required data-deviceforge-action="local" aria-label="邮箱">');
  try {
    const target = item.target('input');
    let reads = 0, inputs = 0;
    Object.defineProperty(target.element, 'value', { get() { reads++; throw new Error('禁止读旧值'); } });
    target.element.addEventListener('input', () => { inputs++; });
    const invalid = await item.actions.execute({ type: 'fill', target: target.ref, value: 'bad', confirmed: true }, item.signal);
    assert.equal(invalid.status, 'rejected'); assert.equal(inputs, 0);
    const reply = await item.actions.execute({ type: 'fill', target: target.ref, value: 'unit@example.invalid', confirmed: true }, item.signal);
    assert.equal(reply.status, 'dispatched'); assert.equal(inputs, 1); assert.equal(reads, 0);
    assert.ok(!JSON.stringify(reply).includes('unit@example.invalid'));
    assert.ok(!JSON.stringify(item.collector.snapshot()).includes('unit@example.invalid'));
  } finally { item.close(); }
});

test('密码、只读、文件与不透明节点拒绝填值', async () => {
  const item = fixture('<input type="password" data-deviceforge-action="local"><input readonly data-deviceforge-action="local"><input type="file" data-deviceforge-action="local"><div contenteditable data-deviceforge-action="local"></div>');
  try {
    for (const element of item.root.children) {
      const ref = item.collector.reference(element); assert.ok(ref);
      assert.equal((await item.actions.execute({ type: 'fill', target: ref, value: 'example', confirmed: true }, item.signal)).status, 'rejected');
    }
  } finally { item.close(); }
});

test('原生选择拒绝禁用、隐藏、不唯一项，不回显当前选择值', async () => {
  const item = fixture('<select required data-deviceforge-action="local"><option value="">请选择</option><option value="a">A</option><option value="b" disabled>B</option><option value="c" hidden>C</option></select>');
  try {
    const target = item.target('select'); let changes = 0;
    Object.defineProperty(target.element, 'value', { get() { throw new Error('禁止读选择值'); } });
    target.element.addEventListener('change', () => { changes++; });
    for (const value of ['', 'b', 'c', 'missing'])
      assert.equal((await item.actions.execute({ type: 'select', target: target.ref, values: [value], confirmed: true }, item.signal)).status, 'rejected');
    assert.equal((await item.actions.execute({ type: 'select', target: target.ref, values: ['a'], confirmed: true }, item.signal)).status, 'dispatched');
    assert.equal(changes, 1);
  } finally { item.close(); }
});

test('一次拾取拦截前置手势和点击，归还目标但不触发业务监听', async () => {
  const item = fixture('<button type="button" data-deviceforge-action="device">设备动作</button>');
  try {
    const target = item.target('button'); let clicks = 0, downs = 0;
    target.element.addEventListener('click', () => { clicks++; });
    target.element.addEventListener('mousedown', () => { downs++; });
    const pending = item.actions.pickOnce(item.signal);
    assert.equal((await item.actions.pickOnce(item.signal)).status, 'indeterminate');
    target.element.dispatchEvent(new item.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.element.dispatchEvent(new item.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const result = await pending;
    assert.equal(result.status, 'picked'); assert.deepEqual(result.target, target.ref); assert.equal(clicks, 0); assert.equal(downs, 0);
    target.element.dispatchEvent(new item.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(clicks, 1);
  } finally { item.close(); }
});

test('一次拾取同时拦截指针与鼠标兼容事件，点击完成后恢复原业务监听', async () => {
  const item = fixture('<button type="button" data-deviceforge-action="device">业务按钮</button>');
  try {
    const target = item.target('button');
    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const received: string[] = [];
    for (const type of events) target.element.addEventListener(type, () => { received.push(type); });
    const pending = item.actions.pickOnce(item.signal);
    for (const type of events) {
      const event = new item.dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
      assert.equal(target.element.dispatchEvent(event), false);
      assert.equal(event.defaultPrevented, true);
    }
    assert.equal((await pending).status, 'picked'); assert.deepEqual(received, []);
    for (const type of events) target.element.dispatchEvent(new item.dom.window.MouseEvent(type, { bubbles: true }));
    assert.deepEqual(received, events);
  } finally { item.close(); }
});

test('一次拾取不把其他插件深层节点误归属为宿主祖先', async () => {
  const item = fixture('<section data-deviceforge-plugin="other" data-deviceforge-generation="1"><button>其他插件</button></section>');
  try {
    const button = item.root.querySelector('button'); assert.ok(button);
    const pending = item.actions.pickOnce(item.signal);
    button.dispatchEvent(new item.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const result = await pending;
    assert.equal(result.status, 'indeterminate'); assert.equal(result.target, null);
  } finally { item.close(); }
});

test('滚动只证明接口已调用，不声称像素位置或实际可见', async () => {
  const item = fixture('<div data-deviceforge-action="local"></div>');
  try {
    const target = item.target('div'); let called = 0;
    Object.defineProperty(target.element, 'scrollIntoView', { value: () => { called++; } });
    const reply = await item.actions.execute({ type: 'scroll', target: target.ref, confirmed: true }, item.signal);
    assert.equal(reply.status, 'dispatched'); assert.equal(reply.businessOutcome, 'unknown'); assert.equal(called, 1);
    const node = item.collector.snapshot().nodes.find((value) => value.id === target.ref.id); assert.ok(node);
    assert.equal(node.visible, 'unknown');
  } finally { item.close(); }
});

test('拾取取消会回收监听，等待可取消并不产生点击', async () => {
  const item = fixture('<button type="button">按钮</button>');
  try {
    const cancel = new AbortController();
    const picking = item.actions.pickOnce(cancel.signal); cancel.abort();
    assert.equal((await picking).status, 'cancelled');
    const target = item.target('button'); let clicks = 0; target.element.addEventListener('click', () => { clicks++; });
    target.element.dispatchEvent(new item.dom.window.MouseEvent('click', { bubbles: true })); assert.equal(clicks, 1);
    const waiting = item.actions.execute({ type: 'wait', assertion: { query: { name: '不存在' }, condition: 'exists' }, timeoutMs: 10000 }, cancel.signal);
    assert.equal((await waiting).status, 'cancelled');
    assert.equal((await item.actions.execute({ type: 'wait', assertion: { query: { role: 'button' }, condition: 'exists' } }, item.signal)).status, 'passed');
    assert.equal((await item.actions.execute({ type: 'wait', assertion: { query: { role: 'missing' }, condition: 'exists' }, timeoutMs: 0 }, item.signal)).status, 'indeterminate');
  } finally { item.close(); }
});

test('高亮精确回收新增类，不删除原有类；无滚动能力保留无法判定', async () => {
  const item = fixture('<button type="button" class="outline-2" data-deviceforge-action="local">按钮</button>');
  try {
    const target = item.target('button');
    assert.equal((await item.actions.execute({ type: 'highlight', target: target.ref }, item.signal)).status, 'applied');
    assert.ok(target.element.classList.contains('outline-dashed'));
    assert.equal((await item.actions.execute({ type: 'scroll', target: target.ref, confirmed: true }, item.signal)).status, 'indeterminate');
    item.actions.dispose();
    assert.equal(target.element.className, 'outline-2');
    assert.equal((await item.actions.execute({ type: 'click', target: target.ref, confirmed: true }, item.signal)).status, 'cancelled');
  } finally { item.close(); }
});

test('导航只能调用显式本地白名单，确认与取消独立于业务成功', async () => {
  const item = fixture(''); let navigations = 0;
  const actions = createDebugActions(item.collector, { signal: item.lifetime.signal, allowedRoutes: ['/settings'], navigate: () => { navigations++; } });
  try {
    for (const path of ['https://example.invalid/', '//outside', '/unknown', '/settings?token=example'])
      assert.equal((await actions.execute({ type: 'navigate', path, confirmed: true }, item.signal)).status, 'rejected');
    assert.equal((await actions.execute({ type: 'navigate', path: '/settings' }, item.signal)).status, 'rejected');
    const reply = await actions.execute({ type: 'navigate', path: '/settings', confirmed: true }, item.signal);
    assert.equal(reply.status, 'dispatched'); assert.equal(reply.businessOutcome, 'unknown'); assert.equal(navigations, 1);
  } finally { actions.dispose(); item.close(); }
});

test('导航回调不返回时仍响应调用者取消，不宣称已停止副作用', async () => {
  const item = fixture(''); const cancel = new AbortController();
  const actions = createDebugActions(item.collector, { signal: item.lifetime.signal, allowedRoutes: ['/settings'], navigate: () => {
    cancel.abort(); return new Promise<void>(() => {});
  } });
  try {
    const result = await actions.execute({ type: 'navigate', path: '/settings', confirmed: true }, cancel.signal);
    assert.equal(result.status, 'cancelled'); assert.equal(result.businessOutcome, 'unknown');
  } finally { actions.dispose(); item.close(); }
});

test('第500节点以外的精确引用可高亮和等待，不受树展示分页限制', async () => {
  const item = fixture('<button type="button" data-deviceforge-action="local">节点</button>'.repeat(540));
  try {
    const element = item.root.lastElementChild; assert.ok(element);
    const target = item.collector.reference(element); assert.ok(target);
    const result = await item.actions.execute({ type: 'highlight', target }, item.signal);
    assert.equal(result.status, 'applied'); assert.equal(element.classList.contains('outline-2'), true);
    assert.equal((await item.actions.execute({ type: 'wait', assertion: { query: { id: target.id }, condition: 'enabled' }, timeoutMs: 0 }, item.signal)).status, 'passed');
  } finally { item.close(); }
});
