import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { assertTree, createDebugActions, createUiCollector } from '../src/plugins/debugger/index.ts';
import type { TreeAssertion } from '../src/plugins/debugger/index.ts';

function fixture(html: string) {
  const dom = new JSDOM(`<main data-deviceforge-plugin="demo" data-deviceforge-generation="7">${html}</main>`);
  const root = dom.window.document.querySelector('main');
  assert.ok(root);
  const collector = createUiCollector(root, { owner: { pluginId: 'demo', generation: 7 } });
  const lifetime = new AbortController();
  const actions = createDebugActions(collector, { signal: lifetime.signal });
  function target(selector: string) {
    assert.ok(root);
    const element = root.querySelector(selector);
    assert.ok(element);
    const ref = collector.reference(element);
    assert.ok(ref);
    return { element, ref };
  }
  return { dom, root, collector, actions, lifetime, target,
    close() { lifetime.abort(); actions.dispose(); collector.dispose(); dom.window.close(); } };
}

test('填写只返回本次期望的匹配结论，动作状态和业务未知保持不变', async () => {
  const item = fixture('<input data-deviceforge-action="local" aria-label="业务输入">');
  try {
    const { element, ref } = item.target('input');
    let ownReads = 0;
    Object.defineProperty(element, 'value', { get() { ownReads++; throw new Error('不执行自定义取值器'); } });
    const result = await item.actions.execute({ type: 'fill', target: ref, value: '本次调用值', confirmed: true }, item.lifetime.signal);
    assert.equal(result.status, 'dispatched');
    assert.equal(result.businessOutcome, 'unknown');
    assert.equal(result.verification?.status, 'passed');
    assert.equal(result.verification?.scope, 'control');
    assert.equal(ownReads, 0);
    assert.equal(JSON.stringify(result).includes('本次调用值'), false);
    assert.equal(JSON.stringify(item.collector.snapshot()).includes('本次调用值'), false);
  } finally { item.close(); }
});

test('框架在微任务内回弹输入时回读失败，仍只派发一次', async () => {
  const item = fixture('<textarea data-deviceforge-action="local" aria-label="草稿"></textarea>');
  try {
    const { element, ref } = item.target('textarea');
    assert.ok(element instanceof item.dom.window.HTMLTextAreaElement);
    let changes = 0;
    element.addEventListener('change', () => {
      changes++;
      queueMicrotask(() => { element.value = '旧草稿'; });
    });
    const result = await item.actions.execute({ type: 'fill', target: ref, value: '新草稿', confirmed: true }, item.lifetime.signal);
    assert.equal(result.status, 'dispatched');
    assert.equal(result.businessOutcome, 'unknown');
    assert.equal(result.verification?.status, 'failed');
    assert.equal(changes, 1);
    assert.equal(JSON.stringify(result).includes('旧草稿'), false);
  } finally { item.close(); }
});

test('选择回读按集合比较，异步回弹选择不被报告为生效', async () => {
  const item = fixture('<select multiple data-deviceforge-action="local"><option value="a">甲</option><option value="b">乙</option></select>');
  try {
    const { element, ref } = item.target('select');
    assert.ok(element instanceof item.dom.window.HTMLSelectElement);
    const first = await item.actions.execute({ type: 'select', target: ref, values: ['b', 'a'], confirmed: true }, item.lifetime.signal);
    assert.equal(first.verification?.status, 'passed');
    element.addEventListener('change', () => { element.selectedIndex = 0; });
    const next = await item.actions.execute({ type: 'select', target: ref, values: ['b'], confirmed: true }, item.lifetime.signal);
    assert.equal(next.verification?.status, 'failed');
    assert.equal(next.status, 'dispatched');
    assert.equal(next.businessOutcome, 'unknown');
  } finally { item.close(); }
});

test('值与选择断言必须唯一且complete，纯快照不能读取当前控件', () => {
  const item = fixture('<input aria-label="普通输入"><input aria-label="同名输入"><input aria-label="同名输入"><select multiple><option value="a" selected>甲</option><option value="b" selected>乙</option></select>');
  try {
    const input = item.target('input').element;
    assert.ok(input instanceof item.dom.window.HTMLInputElement);
    input.value = '期望';
    const condition: TreeAssertion = { condition: 'value_equals', query: { name: '普通输入' }, expected: '期望' };
    assert.equal(item.collector.assert(condition).status, 'passed');
    assert.equal(item.collector.assert({ ...condition, expected: '不匹配' }).status, 'failed');
    assert.equal(item.collector.assert({ ...condition, query: { name: '同名输入', limit: 1 } }).status, 'indeterminate');
    assert.equal(item.collector.assert({ ...condition, query: { role: 'textbox' } }).status, 'indeterminate');
    assert.equal(item.collector.assert({ condition: 'selected_equals', query: { role: 'listbox' }, expected: ['b', 'a'] }).status, 'passed');
    assert.equal(item.collector.assert({ condition: 'selected_equals', query: { role: 'listbox' }, expected: ['a'] }).status, 'failed');
    assert.equal(assertTree(item.collector.snapshot(), condition).status, 'indeterminate');
    const secret = item.dom.window.document.createElement('input');
    secret.type = 'password'; item.root.append(secret);
    assert.equal(item.collector.assert(condition).status, 'indeterminate');
    assert.equal(JSON.stringify(item.collector.snapshot()).includes('期望'), false);
  } finally { item.close(); }
});

test('敏感、非原生和不支持的控件只返回无法判定，不读取或回显值', async () => {
  for (const html of ['<input name="api_key">', '<input type="password">', '<input type="file">', '<input type="hidden">',
    '<input type="checkbox">', '<div role="textbox" contenteditable></div>', '<select name="credential"><option>秘密项</option></select>']) {
    const item = fixture(html);
    try {
      const { element, ref } = item.target(':scope > *');
      let reads = 0;
      Object.defineProperty(element, 'value', { get() { reads++; throw new Error('敏感值禁止读取'); } });
      assert.equal(item.collector.assert({ condition: 'value_equals', query: { id: ref.id }, expected: '任何值' }).status, 'indeterminate');
      assert.equal(item.collector.assert({ condition: 'selected_equals', query: { id: ref.id }, expected: ['任何值'] }).status, 'indeterminate');
      let events = 0;
      element.addEventListener('input', () => { events++; });
      element.addEventListener('change', () => { events++; });
      const result = await item.actions.execute(element.localName === 'select'
        ? { type: 'select', target: ref, values: ['任何值'], confirmed: true }
        : { type: 'fill', target: ref, value: '任何值', confirmed: true }, item.lifetime.signal);
      assert.equal(result.status, 'rejected');
      assert.equal(result.businessOutcome, 'unknown');
      assert.equal(events, 0);
      assert.equal(JSON.stringify(result).includes('任何值'), false);
      assert.equal(JSON.stringify(result).includes('秘密项'), false);
      assert.equal(reads, 0);
    } finally { item.close(); }
  }
});

test('派发中目标被替换或所属生命周期撤销时不验证新控件', async () => {
  for (const abort of [false, true]) {
    const item = fixture('<input data-deviceforge-action="local" aria-label="输入">');
    try {
      const { element, ref } = item.target('input');
      let writes = 0;
      element.addEventListener('change', () => {
        writes++;
        if (abort) item.lifetime.abort();
        else element.replaceWith(item.dom.window.document.createElement('input'));
      });
      const result = await item.actions.execute({ type: 'fill', target: ref, value: '一次值', confirmed: true }, new AbortController().signal);
      assert.equal(result.status, 'dispatched');
      assert.equal(result.verification?.status, 'unavailable');
      assert.equal(writes, 1);
    } finally { item.close(); }
  }
});
