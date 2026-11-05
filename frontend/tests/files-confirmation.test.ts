import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { Dispose, HostContext, WorkspaceViewContext } from '../src/plugin-sdk/index.ts';
import { createFileBrowser } from '../plugins/files/src/model/index.ts';
import { createWorkspaceRegistry } from '../src/plugins/workspace/index.ts';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { deferred } from './fixtures.ts';

// 先建立DOM再首次导入Radix，确保本单元验证真实弹层和焦点逻辑。
const page = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1:7031/#/files', pretendToBeVisual: true,
});
const document = page.window.document;
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: page.window, document, navigator: page.window.navigator,
  Element: page.window.Element, HTMLElement: page.window.HTMLElement, Document: page.window.Document,
  HTMLInputElement: page.window.HTMLInputElement, HTMLButtonElement: page.window.HTMLButtonElement,
  HTMLSelectElement: page.window.HTMLSelectElement, HTMLTextAreaElement: page.window.HTMLTextAreaElement,
  HTMLFormElement: page.window.HTMLFormElement, DocumentFragment: page.window.DocumentFragment,
  Node: page.window.Node, NodeFilter: page.window.NodeFilter, MutationObserver: page.window.MutationObserver,
  Event: page.window.Event, CustomEvent: page.window.CustomEvent, MouseEvent: page.window.MouseEvent,
  KeyboardEvent: page.window.KeyboardEvent, FocusEvent: page.window.FocusEvent,
  getComputedStyle: page.window.getComputedStyle.bind(page.window),
  requestAnimationFrame: page.window.requestAnimationFrame.bind(page.window),
  cancelAnimationFrame: page.window.cancelAnimationFrame.bind(page.window), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const imports = registerCompositionStartupImports();
const { installPublicUi } = await import('../src/app/public-ui.ts');
const { hostUi } = await import('../src/plugin-sdk/index.ts');
const { resolveOwnedPortalRoot } = await import('../src/app/portal-ownership.ts');
const { FilesView } = await import('../plugins/files/src/view.tsx');
const { default: createFilesPlugin, FILES_INSTANCE_ID } = await import('../plugins/files/src/index.ts');
const releaseUi = installPublicUi();
after(async () => {
  await act(async () => {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  await releaseUi(); imports.dispose(); page.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

function button(root: ParentNode, label: string) {
  const control = [...root.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
    (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label);
  assert.ok(control, `缺少文件确认操作：${label}`); return control;
}
function dialogs() { return [...document.querySelectorAll<HTMLElement>('[role="dialog"],[role="alertdialog"]')]; }
async function press(element: Element, key: string, shiftKey = false) {
  await act(async () => {
    element.dispatchEvent(new page.window.KeyboardEvent('keydown', { key, code: key, shiftKey,
      bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function fixture(id = '12345678-1234-1234-1234-123456789abc', holdRemoval = false) {
  const removes: string[] = [], metadataReads: string[] = [], completed = deferred<void>();
  const metadata = { id, filename: `文件-${id.slice(-4)}.txt`, mediaType: 'text/plain',
    size: 12, sha256: 'a'.repeat(64), createdAt: 1000 };
  const browser = createFileBrowser({
    metadata: async (artifactId) => { metadataReads.push(artifactId); return { data: metadata, logId: 'metadata-log' }; },
    entries: async () => { throw new Error('文本确认单元不能读取ZIP目录'); },
    remove: async (artifactId) => {
      removes.push(artifactId);
      if (holdRemoval) await completed.promise;
      return { data: metadata, logId: 'remove-log' };
    },
    download: async () => { throw new Error('确认单元不能下载产物'); },
  });
  await browser.select(id, new AbortController().signal);
  const parent = document.createElement('main'); document.body.append(parent);
  let releaseParent: Dispose = () => {}, releaseChild: Dispose = () => {};
  await act(async () => {
    releaseParent = hostUi().mountReact(parent, createElement('div', null,
      createElement('input', { 'aria-label': '父业务草稿', defaultValue: `父草稿-${id}` }),
      createElement('div', { 'data-testid': 'file-child' })));
  });
  const root = parent.querySelector<HTMLElement>('[data-testid="file-child"]'); assert.ok(root);
  root.dataset.deviceforgePlugin = 'deviceforge_files';
  root.dataset.deviceforgeGeneration = '17';
  root.dataset.deviceforgeExtension = `workspace.files.${id}.1`;
  await act(async () => { releaseChild = hostUi().mountReact(root, createElement(FilesView, { browser, documentRef: document })); });
  const label = [...root.querySelectorAll('label')].find((element) => element.textContent === '产物 ID'); assert.ok(label);
  const input = document.getElementById(label.htmlFor); assert.ok(input instanceof page.window.HTMLInputElement);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, 'value')?.set;
    assert.ok(setter); setter.call(input, id); input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  });
  return {
    root, parent, input, id, metadata, removes, metadataReads, completed, browser,
    async open(focus = true) {
      const trigger = button(root, '删除产物');
      if (focus) trigger.focus();
      await act(async () => { trigger.click(); });
      return trigger;
    },
    async release() { await act(async () => { await releaseChild(); }); },
    async dispose() {
      try { await act(async () => { completed.resolve(); await releaseChild(); browser.dispose(); await releaseParent(); }); }
      finally { parent.remove(); }
    },
  };
}

test('文件删除弹窗Escape返回原按钮并约束模态焦点，取消保留UUID草稿且不调用删除', async () => {
  const f = await fixture();
  try {
    const trigger = await f.open();
    const dialog = dialogs()[0]; assert.ok(dialog);
    await press(document.activeElement ?? dialog, 'Escape');
    assert.equal(dialog.isConnected, false, 'Escape必须关闭当前删除确认');
    assert.equal(document.activeElement, trigger, '关闭应把焦点还给原删除按钮');
    assert.equal(document.getElementById(f.input.id), f.input);
    assert.equal(f.input.value, f.id);
    assert.deepEqual(f.removes, []);

    await f.open();
    const reopened = dialogs()[0]; assert.ok(reopened);
    assert.ok(reopened.contains(document.activeElement), '打开后焦点进入当前确认弹窗');
    await act(async () => { f.input.focus(); });
    assert.ok(reopened.contains(document.activeElement), '模态打开时不能把焦点移到背后UUID输入框');
    const keep = button(reopened, '保留文件'), last = [...reopened.querySelectorAll<HTMLButtonElement>('button')].at(-1);
    assert.ok(last); last.focus(); await press(last, 'Tab');
    assert.ok(reopened.contains(document.activeElement));
    await act(async () => { keep.click(); });
    assert.equal(reopened.isConnected, false);
    assert.deepEqual(f.removes, []);
    assert.equal(f.input.value, f.id);
    assert.deepEqual(f.metadataReads, [f.id], '打开与取消不能重新读取产物');
  } finally { await f.dispose(); }
});

test('多文件实例确认各自关联标题说明，退出所属挂载撤Portal且保留其他业务草稿', async (t) => {
  t.diagnostic('阶段1：建立两个独立公开挂载');
  const first = await fixture(), second = await fixture('22345678-1234-1234-1234-123456789abd');
  try {
    t.diagnostic('阶段2：打开首个模态');
    await first.open();
    t.diagnostic('阶段3：打开第二模态，不强制聚焦背景按钮');
    await second.open(false);
    t.diagnostic('阶段4：核对两个模态的ID和正文归属');
    const contents = dialogs(); assert.equal(contents.length, 2);
    const titleIds = contents.map((element) => element.getAttribute('aria-labelledby'));
    const descriptionIds = contents.map((element) => element.getAttribute('aria-describedby'));
    assert.ok(titleIds.every(Boolean) && descriptionIds.every(Boolean));
    assert.equal(new Set(titleIds).size, 2, '每个文件实例应生成自己的确认标题ID');
    assert.equal(new Set(descriptionIds).size, 2, '每个文件实例应生成自己的确认说明ID');
    for (const f of [first, second]) {
      const content = contents.find((element) => element.textContent?.includes(f.metadata.filename)); assert.ok(content);
      const titleId = content.getAttribute('aria-labelledby'), descriptionId = content.getAttribute('aria-describedby');
      assert.ok(titleId && descriptionId);
      assert.equal(content.contains(document.getElementById(titleId)), true);
      assert.equal(content.contains(document.getElementById(descriptionId)), true);
      assert.equal(resolveOwnedPortalRoot(content)?.anchor, f.root);
      assert.equal(f.root.contains(content), false, '确认弹层经公开归属桥呈现在body');
    }
    const firstContent = contents.find((element) => element.textContent?.includes(first.metadata.filename)); assert.ok(firstContent);
    const secondContent = contents.find((element) => element.textContent?.includes(second.metadata.filename)); assert.ok(secondContent);
    const otherDraft = second.parent.querySelector<HTMLInputElement>('input[aria-label="父业务草稿"]'); assert.ok(otherDraft);
    const otherValue = otherDraft.value;
    t.diagnostic('阶段5：卸载首个挂载，第二模态仍保持打开');
    await first.release();
    assert.equal(firstContent.isConnected, false);
    assert.equal(resolveOwnedPortalRoot(firstContent), null);
    assert.equal(firstContent.hasAttribute('data-deviceforge-portal'), false);
    assert.equal(secondContent.isConnected, true);
    assert.equal(resolveOwnedPortalRoot(secondContent)?.anchor, second.root);
    assert.equal(document.getElementById(second.input.id), second.input);
    assert.equal(second.input.value, second.id);
    assert.equal(second.parent.querySelector('input[aria-label="父业务草稿"]'), otherDraft);
    assert.equal(otherDraft.value, otherValue);
    assert.deepEqual(first.removes, []); assert.deepEqual(second.removes, []);
  } finally {
    t.diagnostic('阶段6：回收两个夹具');
    await first.dispose(); await second.dispose();
    t.diagnostic('阶段7：夹具回收完成');
  }
});

async function registeredFixture(options: { initialVisible?: boolean; hideDuringSubscribe?: boolean } = {}) {
  const controller = new AbortController();
  const releases: Dispose[] = [];
  const requests: string[] = [];
  const metadata = {
    id: '12345678-1234-1234-1234-123456789abc', filename: '实例文件.txt', media_type: 'text/plain',
    size: 12, sha256: 'a'.repeat(64), created_at: 1_000,
  };
  const registry = createWorkspaceRegistry();
  const ui = registry.access({ pluginId: 'deviceforge_files', generation: 17, signal: controller.signal });
  const context: HostContext = {
    apiVersion: 2, signal: controller.signal, ui,
    listOperations: async () => ({ data: [], logId: null }),
    submit: async () => { throw new Error('本测试不派发任务'); },
    getJob: async () => { throw new Error('本测试不查询任务'); },
    cancelJob: async () => { throw new Error('本测试不取消任务'); },
    subscribeOperations: () => () => {},
    onDispose: (release) => { releases.push(release); return release; },
    transport: {
      request: async (request) => {
        requests.push(`${request.method} ${request.path}`);
        if (request.method !== 'GET' || request.path !== `/api/v2/artifacts/${metadata.id}`) {
          throw new Error('本测试只允许内存元数据读取');
        }
        return { data: metadata, logId: 'visibility-metadata', status: 200 };
      },
      bytes: async () => { throw new Error('本测试不读取字节'); },
      stream: async () => { throw new Error('本测试不读取流'); },
    },
  };
  const plugin = createFilesPlugin({ id: 'deviceforge_files', version: '0.1.0', apiVersion: 2 });
  assert.ok(plugin.activate);
  await plugin.activate(context);
  ui.setVisible(FILES_INSTANCE_ID, options.initialVisible ?? true);
  const resolved = registry.resolveView(FILES_INSTANCE_ID);
  assert.ok(resolved);
  let subscriptions = 0;
  let hideBeforeFirstSubscription = options.hideDuringSubscribe ?? false;
  const instance: WorkspaceViewContext = {
    signal: resolved.instance.signal,
    snapshot: () => resolved.instance.snapshot(),
    subscribeVisibility(listener) {
      // 故意在登记前变更，用于确认组件会在订阅后重读公开快照。
      if (hideBeforeFirstSubscription) {
        hideBeforeFirstSubscription = false;
        ui.setVisible(FILES_INSTANCE_ID, false);
      }
      subscriptions += 1;
      const release = resolved.instance.subscribeVisibility(listener);
      return async () => { subscriptions -= 1; await release(); };
    },
  };
  const root = document.createElement('div');
  root.dataset['deviceforgePlugin'] = 'deviceforge_files';
  root.dataset['deviceforgeGeneration'] = '17';
  root.dataset['deviceforgeExtension'] = FILES_INSTANCE_ID;
  document.body.append(root);
  let release: Dispose | undefined;
  await act(async () => { release = await resolved.definition.mount(root, context, instance); });
  const label = [...root.querySelectorAll('label')].find((element) => element.textContent === '产物 ID');
  assert.ok(label);
  const input = document.getElementById(label.htmlFor);
  assert.ok(input instanceof page.window.HTMLInputElement);
  return {
    root, input, metadata, requests,
    async select() {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        assert.ok(setter); setter.call(input, metadata.id);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await act(async () => { button(root, '打开文件').click(); });
      assert.ok(root.textContent?.includes(metadata.filename));
    },
    async open() { await act(async () => { button(root, '删除产物').click(); }); },
    async visible(visible: boolean) { await act(async () => { ui.setVisible(FILES_INSTANCE_ID, visible); }); },
    async dispose() {
      await act(async () => {
        await release?.();
        controller.abort();
        for (const dispose of releases.reverse()) await dispose();
        registry.dispose();
      });
      root.remove();
      assert.equal(subscriptions, 0);
    },
  };
}

test('文件实例可见性：隐藏只关闭所属删除确认，恢复保留输入元数据及另一实例焦点', async () => {
  const first = await registeredFixture();
  const second = await registeredFixture();
  try {
    await first.select(); await second.select();
    const firstSection = first.root.querySelector('section'); assert.ok(firstSection);
    const secondSection = second.root.querySelector('section'); assert.ok(secondSection);
    const firstInput = first.input, secondInput = second.input;
    await first.open();
    const ownDialog = dialogs()[0]; assert.ok(ownDialog);
    await second.open();
    const otherDialog = dialogs().find((element) => element !== ownDialog); assert.ok(otherDialog);
    const otherFocus = document.activeElement;
    assert.ok(otherDialog.contains(otherFocus));
    await first.visible(false);
    assert.ok(!ownDialog.isConnected, '所属实例隐藏后必须撤销删除确认Portal');
    assert.ok(otherDialog.isConnected && dialogs().length === 1, '隐藏首个实例不能关闭另一实例确认');
    assert.ok(document.activeElement === otherFocus, '隐藏不能返焦到隐藏入口或夺取另一模态焦点');
    await first.open();
    assert.ok(dialogs().length === 1 && otherDialog.isConnected, '隐藏时旧删除入口不能重新打开确认');
    assert.ok(document.activeElement === otherFocus, '隐藏入口不能抢走另一实例焦点');
    assert.ok(firstSection.isConnected && first.root.querySelector('input[placeholder="任务结果中的 UUID"]') === firstInput);
    assert.ok(firstInput.value === first.metadata.id && first.root.textContent?.includes(first.metadata.filename));
    await first.visible(true);
    assert.ok(!ownDialog.isConnected && dialogs().length === 1, '恢复显示不能重新打开旧确认');
    assert.ok(first.root.querySelector('section') === firstSection && first.root.querySelector('input[placeholder="任务结果中的 UUID"]') === firstInput);
    assert.ok(second.root.querySelector('section') === secondSection && second.root.querySelector('input[placeholder="任务结果中的 UUID"]') === secondInput);
    assert.ok(secondInput.value === second.metadata.id && otherDialog.isConnected);
    assert.deepEqual(first.requests, [`GET /api/v2/artifacts/${first.metadata.id}`]);
    assert.deepEqual(second.requests, [`GET /api/v2/artifacts/${second.metadata.id}`]);
  } finally { await first.dispose(); await second.dispose(); }
});

test('文件实例可见性：初始隐藏和登记前变化按最新快照呈现，显示不自动读取或重开确认', async () => {
  for (const options of [{ initialVisible: false }, { hideDuringSubscribe: true }]) {
    const current = await registeredFixture(options);
    try {
      const section = current.root.querySelector('section'); assert.ok(section);
      const input = current.input;
      assert.ok(section.hidden, '初始隐藏及订阅前漏通知都必须采用最新实例可见性');
      assert.ok(section.hasAttribute('inert'), '隐藏内容不能继续参与键盘焦点导航');
      assert.ok(dialogs().length === 0);
      assert.deepEqual(current.requests, []);
      await current.visible(true);
      assert.ok(!section.hidden && current.root.querySelector('input[placeholder="任务结果中的 UUID"]') === input);
      assert.ok(dialogs().length === 0 && input.value === '');
      assert.deepEqual(current.requests, [], '显示不是自动重新读取或业务操作');
    } finally { await current.dispose(); }
  }
});

test('删除仅在明确确认时提交当前产物一次，等待中的重复点击不重放操作', async () => {
  const f = await fixture('32345678-1234-1234-1234-123456789abc', true);
  try {
    await f.open();
    const dialog = dialogs()[0]; assert.ok(dialog);
    assert.deepEqual(f.removes, []);
    const confirm = button(dialog, '确认删除');
    await act(async () => { confirm.click(); });
    assert.deepEqual(f.removes, [f.id]);
    await act(async () => { confirm.click(); });
    assert.deepEqual(f.removes, [f.id], '确认回执尚未返回时不得重放删除');
    assert.equal(dialogs().length, 0);
    await act(async () => { f.completed.resolve(); });
    assert.equal(f.browser.snapshot().metadata, null);
    assert.deepEqual(f.removes, [f.id]);
    assert.equal(f.input.value, f.id, '结果确认后仍保留来源输入草稿');
    assert.deepEqual(f.metadataReads, [f.id]);
  } finally { await f.dispose(); }
});
