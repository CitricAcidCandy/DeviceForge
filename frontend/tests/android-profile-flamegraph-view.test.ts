import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { buildProfileFlamegraph } from '../src/features/android-profile/utils/flamegraph.ts';
import {
  flamePercent,
  layoutFlamegraph,
} from '../src/pages/performance/components/ProfileFlamegraph/layout.ts';
import type {
  FlameInterval,
  ProfileFlamegraphViewProps,
} from '../src/pages/performance/components/ProfileFlamegraph/index.tsx';
import type { StackFrame, StackSample } from '../src/features/android-profile/types/index.ts';
import type { MessageController } from '../src/components/Message/index.ts';
import type { MessageProvider } from '../src/components/Message/index.tsx';

type MessageModule = {
  MessageProvider: typeof MessageProvider;
  createMessageController(): MessageController;
};
function messageModule(value: unknown): value is MessageModule {
  return value !== null && typeof value === 'object' &&
    'MessageProvider' in value && typeof value.MessageProvider === 'function' &&
    'createMessageController' in value && typeof value.createMessageController === 'function';
}

const begin = '90071992547409930';
const middle = '90071992547409932';
const end = '90071992547409934';
const maximumCount = '18446744073709551615';
function frame(symbol: string | null, address: string, file: string): StackFrame {
  return { symbol, address, file, execution_type: 'native' };
}
function sample(patch: Partial<StackSample> = {}): StackSample {
  return {
    time_ns: begin,
    thread_id: 43,
    process_id: 42,
    thread_name: '游戏主线程',
    event_type: 'cpu-clock',
    event_count: maximumCount,
    callchain: [
      frame('AlphaUpdate', '0x1234', 'libknown.so'),
      frame('GameLoop', '0x100', 'libgame.so'),
    ],
    unwinding: { raw_error_code: 0, error_code: 0, error_address: null },
    ...patch,
  };
}
const stacks: readonly StackSample[] = [
  sample(),
  sample({
    time_ns: '90071992547409931',
    callchain: [frame(null, '0xbeef', 'libunknown.so'), frame('GameLoop', '0x100', 'libgame.so')],
    unwinding: null,
  }),
  sample({
    time_ns: middle,
    thread_id: 44,
    thread_name: '后台线程',
    event_count: '7',
    callchain: [frame('WorkerStep', '0x4567', 'libworker.so')],
  }),
  sample({
    time_ns: '90071992547409933',
    process_id: 99,
    thread_id: 53,
    thread_name: '其他进程',
    event_count: '11',
    callchain: [frame('RemoteStep', '0x7890', 'libremote.so')],
  }),
];
const intervals: readonly FlameInterval[] = [
  { label: '指标点 1', beginNs: begin, endNs: middle },
  { label: '指标点 2', beginNs: middle, endNs: end },
];
function componentModule(
  value: unknown,
): value is { ProfileFlamegraphView: ComponentType<ProfileFlamegraphViewProps> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'ProfileFlamegraphView' in value &&
    typeof value.ProfileFlamegraphView === 'function'
  );
}

test('React 火焰图在真实 DOM 中筛选、搜索、缩放并保留大整数权重', async (context) => {
  const browser = new JSDOM(
    '<!doctype html><html><body><div id="flame-test"></div></body></html>',
    { url: 'http://localhost:7031', pretendToBeVisual: true },
  );
  const windowRef = browser.window;
  const globals: Readonly<Record<string, unknown>> = {
    window: windowRef,
    document: windowRef.document,
    navigator: windowRef.navigator,
    Element: windowRef.Element,
    HTMLElement: windowRef.HTMLElement,
    HTMLInputElement: windowRef.HTMLInputElement,
    HTMLSelectElement: windowRef.HTMLSelectElement,
    Node: windowRef.Node,
    DocumentFragment: windowRef.DocumentFragment,
    CustomEvent: windowRef.CustomEvent,
    HTMLButtonElement: windowRef.HTMLButtonElement,
    getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
    requestAnimationFrame: windowRef.requestAnimationFrame.bind(windowRef),
    cancelAnimationFrame: windowRef.cancelAnimationFrame.bind(windowRef),
    Event: windowRef.Event,
    MutationObserver: windowRef.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  const target = windowRef.document.getElementById('flame-test');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const viewRoot = createRoot(target);
  const messageLoaded: unknown = await server.ssrLoadModule('/src/components/Message/index.tsx');
  assert.ok(messageModule(messageLoaded));
  const messages = messageLoaded.createMessageController();
  try {
    const loaded: unknown = await server.ssrLoadModule(
      '/src/pages/performance/components/ProfileFlamegraph/index.tsx',
    );
    assert.ok(componentModule(loaded));
    let generation = 0;
    const reset = async () => {
      await act(async () => {
        messages.clear();
        viewRoot.render(
          createElement(messageLoaded.MessageProvider, { controller: messages,
            children: createElement(loaded.ProfileFlamegraphView, { stacks, intervals, key: ++generation }) }),
        );
      });
    };
    const button = (text: string) => {
      const node = Array.from(target.querySelectorAll('button')).find(
        (entry) => entry.textContent === text,
      );
      assert.ok(node, '缺少按钮：' + text);
      return node;
    };
    const control = (text: string) => {
      const label = Array.from(target.querySelectorAll('label')).find((entry) =>
        entry.textContent?.startsWith(text),
      );
      const node = label?.querySelector('input, select');
      assert.ok(
        node instanceof windowRef.HTMLInputElement || node instanceof windowRef.HTMLSelectElement,
        '缺少筛选项：' + text,
      );
      return node;
    };
    const setValue = async (text: string, value: string) => {
      const node = control(text);
      await act(async () => {
        if (node instanceof windowRef.HTMLSelectElement) {
          node.value = value;
          node.dispatchEvent(new windowRef.Event('change', { bubbles: true }));
        } else {
          const setter = Object.getOwnPropertyDescriptor(
            windowRef.HTMLInputElement.prototype,
            'value',
          )?.set;
          assert.ok(setter);
          setter.call(node, value);
          node.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
        }
      });
    };
    const summary = () => target.querySelector('[data-flame-summary]')?.textContent ?? '';
    const flameNode = (label: string) => {
      const node = Array.from(target.querySelectorAll('g[data-flame-node]')).find((entry) =>
        entry.getAttribute('aria-label')?.startsWith(label + '，'),
      );
      assert.ok(node, '缺少调用帧：' + label);
      return node;
    };
    await context.test('进程和线程过滤组合生效，切进程撤销旧线程并保留半开时间精度', async () => {
      await reset();
      assert.match(summary(), /筛选 4 条样本/);
      await setValue('进程', '42');
      assert.match(summary(), /筛选 3 条样本/);
      await setValue('线程', '43');
      assert.match(summary(), /筛选 2 条样本/);
      await setValue('开始时间', '90071992547409931');
      await setValue('结束时间', middle);
      assert.match(summary(), /筛选 1 条样本/);
      assert.equal(
        target.textContent?.includes('AlphaUpdate'),
        false,
        '开始时间之前的调用帧不能混入',
      );
      assert.ok(target.textContent?.includes('libunknown.so @ 0xbeef'));
      await setValue('进程', '99');
      assert.equal(control('线程').value, '');
      await act(async () => button('全部样本').click());
      assert.match(summary(), /筛选 4 条样本/);
      assert.equal(control('进程').value, '');
      assert.equal(control('开始时间').value, '');
    });
    await context.test('两个指标点分别对应两条夹具，按钮区间包含开始并排除结束', async () => {
      await reset();
      await act(async () => button('指标点 1').click());
      assert.match(summary(), /筛选 2 条样本/);
      assert.equal(button('指标点 1').getAttribute('aria-pressed'), 'true');
      assert.ok(target.textContent?.includes('AlphaUpdate'));
      assert.ok(target.textContent?.includes('libunknown.so @ 0xbeef'));
      assert.equal(target.textContent?.includes('WorkerStep'), false);
      await act(async () => button('指标点 2').click());
      assert.match(summary(), /筛选 2 条样本/);
      assert.equal(button('指标点 1').getAttribute('aria-pressed'), 'false');
      assert.ok(target.textContent?.includes('WorkerStep'));
      assert.ok(target.textContent?.includes('RemoteStep'));
      assert.equal(target.textContent?.includes('AlphaUpdate'), false);
    });
    await context.test('搜索函数、已知函数的模块与原地址都命中并高亮对应色块', async () => {
      await reset();
      for (const query of ['alphaupdate', 'libknown.so', '0x1234']) {
        await setValue('搜索函数', query);
        assert.match(target.textContent ?? '', /匹配 1 个函数节点/);
        assert.equal(
          flameNode('AlphaUpdate').querySelector('rect')?.getAttribute('opacity'),
          '1',
          '有匹配节点时模块和地址搜索也应高亮',
        );
        assert.equal(
          flameNode('RemoteStep').querySelector('rect')?.getAttribute('opacity'),
          '0.28',
        );
      }
      await setValue('搜索函数', 'libunknown.so');
      assert.equal(
        flameNode('libunknown.so @ 0xbeef').querySelector('rect')?.getAttribute('opacity'),
        '1',
      );
      await setValue('搜索函数', '不存在的函数');
      assert.match(target.textContent ?? '', /匹配 0 个函数节点/);
    });
    await context.test('鼠标和 Enter 放大分支，重置及上一级恢复可见范围', async () => {
      await reset();
      assert.equal(button('重置缩放').disabled, true);
      await act(async () =>
        flameNode('GameLoop').dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true })),
      );
      assert.match(target.textContent ?? '', /当前分支：GameLoop/);
      assert.equal(target.querySelectorAll('g[data-flame-node]').length, 3);
      assert.equal(target.textContent?.includes('WorkerStep'), false);
      await act(async () => button('重置缩放').click());
      assert.equal(button('重置缩放').disabled, true);
      assert.ok(target.textContent?.includes('WorkerStep'));
      const leaf = flameNode('AlphaUpdate');
      assert.equal(leaf.getAttribute('tabindex'), '0');
      await act(async () =>
        leaf.dispatchEvent(
          new windowRef.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        ),
      );
      assert.match(target.textContent ?? '', /当前分支：AlphaUpdate/);
      assert.equal(target.querySelectorAll('g[data-flame-node]').length, 1);
      await act(async () => button('上一级').click());
      assert.match(target.textContent ?? '', /当前分支：GameLoop/);
      await act(async () => button('重置缩放').click());
      assert.equal(button('上一级').disabled, true);
    });
    await context.test('事件计数切换保持超安全整数的完整十进制权重', async () => {
      await reset();
      await setValue('宽度权重', 'event_count');
      assert.match(summary(), /总事件计数 36893488147419103248/);
      assert.ok(flameNode('AlphaUpdate').getAttribute('aria-label')?.includes(maximumCount));
      await act(async () => button('指标点 1').click());
      assert.match(summary(), /总事件计数 36893488147419103230/);
      assert.match(target.textContent ?? '', /这是采样分布，不是精确 CPU 耗时/);
      await setValue('宽度权重', 'samples');
      assert.match(summary(), /总样本数 2/);
    });
    await context.test('非法区间走全局消息，恢复条件撤销提示且空范围不借相邻样本补齐', async () => {
      await reset();
      await setValue('开始时间', end);
      await setValue('结束时间', begin);
      assert.match(
        target.querySelector('[data-message-kind="error"]')?.textContent ?? '',
        /Android 火焰图输入、筛选或资源范围无效/,
      );
      assert.ok(target.querySelector('[data-profile-flamegraph] svg') === null, '非法区间不应绘制火焰图');
      assert.equal(messages.snapshot().length, 1);
      assert.ok(target.querySelector('[data-global-message-root]'));
      assert.equal(target.querySelector('.profile-flamegraph [role="alert"]'), null);
      assert.equal(target.querySelector('[data-flame-summary]'), null);
      await setValue('结束时间', end);
      assert.equal(target.querySelector('[data-message-kind="error"]'), null);
      assert.equal(messages.snapshot().length, 0);
      assert.match(summary(), /筛选 0 条样本/);
      assert.match(target.textContent ?? '', /此筛选范围没有有效权重；没有用相邻样本补齐/);
      assert.ok(target.querySelector('[data-profile-flamegraph] svg') === null, '空区间不应绘制火焰图');
      await setValue('开始时间', '020');
      assert.ok(target.querySelector('[data-message-kind="error"]'));
    });
  } finally {
    await act(async () => viewRoot.unmount());
    messages.dispose();
    await server.close();
    browser.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('布局焦点只保留真实后代，不混入同权重兄弟或祖先', () => {
  const graph = buildProfileFlamegraph([
    sample({ callchain: [frame('LeafA', '0x1', 'a.so'), frame('BranchA', '0x10', 'a.so')] }),
    sample({ callchain: [frame('LeafB', '0x2', 'b.so'), frame('BranchB', '0x20', 'b.so')] }),
  ]);
  const branch = graph.nodes.find((node) => node.label === 'BranchA');
  const sibling = graph.nodes.find((node) => node.label === 'BranchB');
  assert.ok(branch);
  assert.ok(sibling);
  assert.equal(branch.weight, sibling.weight);
  const layout = layoutFlamegraph(graph, branch.id);
  assert.equal(layout.focus, branch);
  assert.deepEqual(
    layout.bars.map((bar) => bar.node.label),
    ['BranchA', 'LeafA'],
  );
  assert.equal(layout.bars[0]?.x, 0);
  assert.equal(layout.bars[0]?.width, 1000);
  assert.equal(layout.bars[0]?.level, 0);
  assert.equal(layout.bars[1]?.level, 1);
  const leaf = graph.nodes.find((node) => node.label === 'LeafA');
  assert.ok(leaf);
  assert.deepEqual(
    layoutFlamegraph(graph, leaf.id).bars.map((bar) => bar.node.id),
    [leaf.id],
  );
});

test('布局限制绘制数量并标记省略，精确聚合权重与输入模型不变', () => {
  const graph = buildProfileFlamegraph(stacks);
  const original = structuredClone(graph);
  const full = layoutFlamegraph(graph, null);
  const limited = layoutFlamegraph(graph, null, 3);
  assert.equal(limited.bars.length, 3);
  assert.equal(limited.omitted, full.bars.length - 3);
  assert.ok(
    limited.bars.every(
      (bar) => Number.isFinite(bar.x) && Number.isFinite(bar.width) && bar.width > 0,
    ),
  );
  assert.deepEqual(graph, original);
  assert.equal(graph.totalWeight, '4');
  const eventGraph = buildProfileFlamegraph(stacks, { weight: 'event_count' });
  const eventLayout = layoutFlamegraph(eventGraph, null);
  assert.ok(eventLayout.omitted > 0, '极小节点可以省略绘制，但事件计数仍须完整');
  assert.equal(eventGraph.totalWeight, '36893488147419103248');
  assert.equal(flamePercent('36893488147419103230', '36893488147419103230'), '100.00');
  const empty = layoutFlamegraph(buildProfileFlamegraph([]), null);
  assert.deepEqual(empty.bars, []);
  assert.equal(empty.omitted, 0);
});
