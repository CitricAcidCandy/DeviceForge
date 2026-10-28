// 画面与三个独立指标面板共用真实时间坐标；选择保留原采样索引，缺测不借邻点。
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import type { StackFrame, StackSample } from '../src/features/android-profile/types/index.ts';
import type { BoardSample, SampleBoardProps } from '../src/pages/performance/components/SampleBoard/index.tsx';
import {
  areaSegments, nearestSampleIndex, selectedTimelineScrollLeft, timelineRatio, timelineTicks, visibleFrameIndices,
} from '../src/pages/performance/components/SampleBoard/timeline.ts';

type BoardModule = { SampleBoard: ComponentType<SampleBoardProps> };
function boardModule(value: unknown): value is BoardModule {
  return (
    value !== null &&
    typeof value === 'object' &&
    'SampleBoard' in value &&
    typeof value.SampleBoard === 'function'
  );
}

function frame(symbol: string): StackFrame {
  return { file: 'libforge.so', symbol, address: '0x1', execution_type: 'native' };
}

function stack(timeNs: string, chain: readonly string[]): StackSample {
  return {
    time_ns: timeNs,
    thread_id: 42,
    process_id: 100,
    thread_name: 'main',
    event_count: '1',
    event_type: 'cpu-clock',
    callchain: chain.map(frame),
    unwinding: null,
  };
}

// 采样间隔 2 秒、共 6 点；第 4 点掉帧，第 5 点没有画面。
const samples: readonly BoardSample[] = [0, 2, 4, 6, 8, 10].map((t, index) => ({
  id: `s${index}`,
  t,
  fps: index === 3 ? 41.5 : 59,
  cpu: 20 + index,
  pssKib: 400 * 1024,
  rssKib: 460 * 1024,
  frameUrl: index === 4 ? null : `blob:frame-${index}`,
  ...(index === 3 ? { frameNote: '真实画面关联说明' } : {}),
  stacks:
    index === 0
      ? [stack('1', ['event', 'render', 'drawBatches']), stack('2', ['event', 'render', 'upload'])]
      : [],
  note: index === 0 ? null : '本点没有关联到栈样本',
}));

let server: ViteDevServer | undefined;
let board: BoardModule | undefined;

// 静态标记测试只复用一个转换实例，不监听端口、文件或 WebSocket。
before(async () => {
  server = await createServer({
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    // 只隔离画布；保留看板传给图表的真实轨道、缺测点与共享时间坐标供断言。
    plugins: [{
      name: 'performance-board-chart-boundary', enforce: 'pre',
      resolveId(id) {
        if (id.endsWith('/MultiTrackChart/index.tsx')) return '\0performance-board-chart';
      },
      load(id) {
        if (id === '\0performance-board-chart')
          return `import { createElement } from 'react';
            export function MultiTrackChart(props) {
              return createElement('div', {
                role: 'group', 'aria-label': props.ariaLabel,
                'data-tracks': JSON.stringify(props.tracks),
                'data-x-domain': JSON.stringify(props.xDomain),
                'data-cursor': props.cursorX,
              }, (props.tracks[0]?.series[0]?.points ?? []).map((point, index) =>
                createElement('button', {
                  key: index, type: 'button',
                  'aria-label': '图表选点 ' + props.ariaLabel + ' ' + point.x,
                  onClick: () => props.onPickX?.(point.x),
                })
              ));
            }`;
      },
    }],
  });
  const loaded: unknown = await server.ssrLoadModule('/src/pages/performance/components/SampleBoard/index.tsx');
  assert.ok(boardModule(loaded), '组件入口应导出 SampleBoard');
  board = loaded;
});

// 断言或模块加载失败也必须关闭转换实例。
after(async () => {
  await server?.close();
});

function renderBoard(selected: number, readings: readonly BoardSample[] = samples, span = 10): string {
  assert.ok(board, '组件模块应已加载');
  return renderToStaticMarkup(
    createElement(board.SampleBoard, {
      samples: readings,
      span,
      selected,
      onSelect: () => {},
      frameNote: '没有逐帧画面',
      stackNote: '没有栈样本',
    }),
  );
}

function readout(panel: ParentNode, metric: string): Element {
  const value = panel.querySelector(`[aria-label="${metric}当前读数"]`);
  assert.ok(value, `缺少 ${metric} 当前读数`);
  return value;
}

function chartTracks(panel: ParentNode, name: string): unknown {
  const chart = panel.querySelector(`[aria-label="${name}"]`);
  assert.ok(chart, `缺少 ${name}`);
  return JSON.parse(chart.getAttribute('data-tracks') ?? 'null');
}

async function interactBoard(run: (
  target: HTMLElement, browser: JSDOM, picks: readonly number[], select: (index: number) => Promise<void>,
) => Promise<void>, viewportWidth = 0) {
  assert.ok(board, '组件模块应已加载');
  const Component = board.SampleBoard;
  const browser = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const w = browser.window;
  if (viewportWidth > 0) Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute('data-shared-time-canvas')) return 1132;
      return this.hasAttribute('data-performance-board') ? viewportWidth : 0;
    },
  });
  const globals: Readonly<Record<string, unknown>> = {
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const target = w.document.querySelector('main');
  assert.ok(target);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(target);
  const picks: number[] = [];
  const select = async (selected: number) => {
    await act(async () => {
      root.render(createElement(Component, {
        samples, span: 10, selected, onSelect: (index) => { picks.push(index); },
        frameNote: '没有逐帧画面', stackNote: '没有栈样本',
      }));
    });
  };
  try {
    await select(3);
    await run(target, browser, picks, select);
  } finally {
    await act(async () => { root.unmount(); });
    browser.window.close();
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
}

test('画面保留真实采样索引，并按三张图共用的时间比例居中', () => {
  const markup = renderBoard(3);
  const panel = JSDOM.fragment(markup);
  const thumbnails = markup.match(/采样画面 \d+，[\d.]+ 秒/g) ?? [];
  assert.equal(thumbnails.length, 5, '第 5 点没有画面，不应渲染缩略图');
  const selected = panel.querySelector('[aria-label="采样画面 4，6.00 秒"]');
  assert.ok(selected);
  assert.match(selected.getAttribute('style') ?? '', /left:60%/, '第 4 个点 t=6 / span=10 应落在 60%');
  assert.equal(selected.getAttribute('data-sample-index'), '3');
  assert.equal(panel.querySelector('[aria-label="采样画面 5，8.00 秒"]'), null);
  assert.match(markup, /blob:frame-0/);
  assert.match(markup, /title="#4 · 6\.00 s · 真实画面关联说明"/);
  assert.equal((markup.match(/loading="lazy"/g) ?? []).length, 5);
});

test('时间轴刻度按跨度取整秒步长，并覆盖末端', () => {
  const panel = JSDOM.fragment(renderBoard(3));
  for (const metric of ['帧率', 'CPU', '内存']) {
    const axis = panel.querySelector(`[role="slider"][aria-label="${metric}采样选择"]`);
    assert.ok(axis);
    assert.deepEqual(Array.from(axis.children).map((tick) => tick.textContent?.replace(/\s*s$/, '')),
      ['0', '2', '4', '6', '8', '10']);
  }
});

test('空样本只显示等待状态，不铺开六条空轨或伪造读数', () => {
  const empty = renderBoard(0, []);
  const status = JSDOM.fragment(empty).querySelector('[aria-label="等待采样数据"]');
  assert.ok(status);
  assert.equal(status.querySelector('[role="status"]')?.textContent, '尚无采样数据');
  assert.equal(status.querySelector('button, canvas, [role="group"]'), null);
  assert.doesNotMatch(empty, /采样数据面板|条轨道|无帧率|无 CPU 观测|无内存观测|animate-pulse|aria-busy="true"/);
});

test('非整数末端时间不重复取整刻度', () => {
  const partial = renderBoard(1, samples.slice(0, 2), 3.48);
  assert.match(partial, />3\s*s</);
  assert.match(partial, />3\.5\s*s</);
});

test('三类指标分别独立成面板，画面位于其上方且不再共用读数列', () => {
  const panel = JSDOM.fragment(renderBoard(3)).querySelector('[aria-label="采样数据面板"]');
  assert.ok(panel);
  const framePanel = panel.querySelector('section[aria-label="采样画面面板"]');
  assert.ok(framePanel);
  const metrics = ['帧率', 'CPU', '内存'].map((name) => {
    const metric = panel.querySelector(`section[aria-label="${name}指标"]`);
    assert.ok(metric, `${name} 应有完整独立面板`);
    assert.equal(metric.querySelectorAll('[role="group"][aria-label$="曲线"]').length, 1);
    return metric;
  });
  assert.ok(metrics.every((metric) => metric.parentElement === framePanel.parentElement),
    '画面及三指标是同一滚动画布的独立同级面板，不能嵌在另一指标里');
  assert.equal(metrics[0]?.contains(readout(panel, '帧率')), true);
  assert.equal(metrics[1]?.contains(readout(panel, 'CPU')), true);
  assert.equal(metrics[2]?.contains(readout(panel, 'PSS')), true);
  assert.equal(metrics[2]?.contains(readout(panel, 'RSS')), true);
  assert.doesNotMatch(panel.textContent ?? '', /6 条轨道/);
});

test('帧率面板显示所选点读数，图表保留真实量程与低帧阈值', () => {
  const panel = JSDOM.fragment(renderBoard(3));
  assert.equal(readout(panel, '帧率').textContent?.replace(/\s/g, ''), '41.5fps');
  assert.partialDeepStrictEqual(chartTracks(panel, '帧率曲线'), [{
    id: 'fps', domain: [0, 60], series: [{
      id: 'fps', warnBelow: 50, points: samples.map((sample) => ({ x: sample.t, y: sample.fps })),
    }],
  }]);
});

test('帧率、CPU、内存分别渲染三张图，当前读数与游标按同一采样点对应', () => {
  const panel = JSDOM.fragment(renderBoard(3)).querySelector('[aria-label="采样数据面板"]');
  assert.ok(panel);
  const charts = Array.from(panel.querySelectorAll('[role="group"][aria-label$="曲线"]'));
  assert.deepEqual(charts.map((chart) => chart.getAttribute('aria-label')), ['帧率曲线', 'CPU 占用曲线', '内存曲线']);
  assert.ok(charts.every((chart) => chart.getAttribute('data-x-domain') === '[0,10]' && chart.getAttribute('data-cursor') === '6'),
    '三张图须按同一真实时间范围和当前采样点绘制');
  assert.partialDeepStrictEqual(chartTracks(panel, 'CPU 占用曲线'), [{ id: 'cpu', domain: [0, 25], series: [{ id: 'CPU', points: samples.map((sample) => ({ x: sample.t, y: sample.cpu })) }] }]);
  assert.partialDeepStrictEqual(chartTracks(panel, '内存曲线'), [{ id: 'memory', domain: [0, 460 * 1024], series: [
    { id: 'PSS', points: samples.map((sample) => ({ x: sample.t, y: sample.pssKib })) },
    { id: 'RSS', dashed: true, points: samples.map((sample) => ({ x: sample.t, y: sample.rssKib })) },
  ] }]);
  assert.equal(readout(panel, '帧率').textContent?.replace(/\s/g, ''), '41.5fps');
  assert.equal(readout(panel, 'CPU').textContent?.replace(/\s/g, ''), '23%');
  assert.equal(readout(panel, 'PSS').textContent?.replace(/\s/g, ''), '0.39GB');
  assert.match(readout(panel, 'RSS').textContent ?? '', /0\.45\s*GB/);
  for (const metric of ['帧率', 'CPU', '内存']) {
    const axis = panel.querySelector(`[role="slider"][aria-label="${metric}采样选择"]`);
    assert.ok(axis);
    assert.equal(axis.getAttribute('aria-valuenow'), '3');
    assert.match(axis.getAttribute('aria-valuetext') ?? '', /6\.00/);
  }
});

test('低帧、零帧和高刷新率使用真实读数与量程', () => {
  for (const fps of [0, 12, 77, 120, 144, 240]) {
    const readings = samples.map((sample) => ({ ...sample, fps }));
    const panel = JSDOM.fragment(renderBoard(0, readings));
    const ceiling = fps <= 30 ? 30 : fps === 77 ? 90 : fps;
    assert.partialDeepStrictEqual(chartTracks(panel, '帧率曲线'), [{ domain: [0, ceiling] }]);
    assert.equal(readout(panel, '帧率').textContent?.replace(/\s/g, ''), `${fps.toFixed(1)}fps`,
      `真实 ${fps} fps 不截断或伪造读数`);
  }
});

test('全缺测不补帧率、CPU 或内存曲线，部分缺测保留当前点占位', () => {
  const readings = samples.map((sample) => ({
    ...sample, fps: null, cpu: null, pssKib: null, rssKib: null,
  }));
  const empty = renderBoard(0, readings);
  assert.match(empty, /无帧率/);
  assert.match(empty, /无 CPU 观测/);
  assert.match(empty, /无内存观测/);
  assert.doesNotMatch(empty, /aria-label="(?:帧率曲线|CPU 占用曲线|内存曲线)"/);
  assert.doesNotMatch(empty, />0\.0 fps</);
  const mixed = JSDOM.fragment(renderBoard(0, samples.map((sample, index) => index === 0 ? readings[0] ?? sample : sample)));
  for (const chart of ['帧率曲线', 'CPU 占用曲线', '内存曲线']) assert.ok(mixed.querySelector(`[aria-label="${chart}"]`));
  for (const metric of ['帧率', 'CPU', 'PSS']) assert.match(readout(mixed, metric).textContent ?? '', /—/);
  assert.match(readout(mixed, 'RSS').textContent ?? '', /未采集|—/,
    '选中点的四项缺测均保留，不沿用其他点');
});

test('CPU、PSS、RSS 各自缺测不会隐藏其他指标或沿用其读数', () => {
  for (const missing of ['cpu', 'pssKib', 'rssKib'] as const) {
    const markup = renderBoard(3, samples.map((sample) => ({ ...sample, [missing]: null })));
    const panel = JSDOM.fragment(markup).querySelector('[aria-label="采样数据面板"]');
    assert.ok(panel);
    assert.ok(panel.querySelector('[aria-label="帧率曲线"]'));
    assert.ok(panel.querySelector('[aria-label="内存曲线"]'), '单条内存指标缺测时仍应显示另一条内存曲线');
    assert.equal(!!panel.querySelector('[aria-label="CPU 占用曲线"]'), missing !== 'cpu');
    assert.match(readout(panel, 'CPU').textContent ?? '', missing === 'cpu' ? /—/ : /23\s*%/);
    assert.match(readout(panel, 'PSS').textContent ?? '', missing === 'pssKib' ? /—/ : /0\.39\s*GB/);
    assert.match(readout(panel, 'RSS').textContent ?? '', missing === 'rssKib' ? /未采集|—/ : /0\.45\s*GB/);
    assert.equal(markup.includes('无 CPU 观测'), missing === 'cpu');
    assert.partialDeepStrictEqual(chartTracks(panel, '内存曲线'), [{ id: 'memory', series: [
      { id: 'PSS', points: samples.map((sample) => ({ x: sample.t, y: missing === 'pssKib' ? null : sample.pssKib })) },
      { id: 'RSS', points: samples.map((sample) => ({ x: sample.t, y: missing === 'rssKib' ? null : sample.rssKib })) },
    ] }]);
  }
});

test('调用栈轨只画当前采样点的栈', async () => {
  const empty = await renderBoard(3);
  assert.match(empty, /本点没有关联到栈样本/, '选中点没有栈时回落到缺测说明');
  const first = await renderBoard(0);
  assert.match(first, /drawBatches/);
  assert.match(first, /upload/);
  assert.match(first, /2 个栈样本/);
});

test('时间位置按真实间隔计算，边界与无效跨度不产生越界坐标', () => {
  assert.equal(timelineRatio(6, 10), 0.6);
  assert.equal(timelineRatio(1, 10), 0.1, '不均匀时间不能按样本序号均分');
  assert.equal(timelineRatio(-2, 10), 0);
  assert.equal(timelineRatio(12, 10), 1);
  for (const span of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(timelineRatio(6, span), 0);
  assert.equal(timelineRatio(Number.NaN, 10), 0);
  assert.deepEqual(timelineTicks(3.48), [0, 1, 2, 3, 3.48]);
  assert.deepEqual(timelineTicks(0), [0]);
});

test('曲线选点按真实时间返回原索引，缺帧样本仍可选择', () => {
  assert.equal(nearestSampleIndex(samples, 8.1), 4, '第5点没有画面，仍是合法指标采样点');
  assert.equal(nearestSampleIndex([{ t: 0 }, { t: 1 }, { t: 9 }], 8), 2);
  assert.equal(nearestSampleIndex(samples, -10), 0);
  assert.equal(nearestSampleIndex(samples, 30), 5);
  assert.equal(nearestSampleIndex([], 3), 0);
});

test('密集画面只稀疏显示，保留所选真帧与原始索引且不复制缺帧', () => {
  const base = samples[0];
  assert.ok(base);
  const dense = Array.from({ length: 101 }, (_, index) => ({
    ...base, id: `dense-${index}`, t: index / 10,
    frameUrl: index % 7 === 0 ? null : `blob:dense-${index}`,
  }));
  const visible = visibleFrameIndices(dense, 10, 848, 50);
  assert.ok(visible.includes(50), '当前点有真实画面时，即使其他画面稀疏也必须保留');
  assert.ok(visible.length < 12 && visible.length > 1, '密集缩略图须稀疏，不能叠满时间带');
  assert.equal(new Set(visible).size, visible.length);
  assert.deepEqual([...visible].sort((a, b) => a - b), visible);
  assert.ok(visible.every((index) => dense[index]?.frameUrl === `blob:dense-${index}`),
    '返回的是原数组索引，不能按筛选后的序号指向其他采样点');
  assert.ok(!visibleFrameIndices(dense, 10, 848, 49).includes(49), '所选点缺帧时不得借图或补图');
  assert.deepEqual(visibleFrameIndices(dense.map((sample) => ({ ...sample, frameUrl: null })), 10, 848, 50), []);
});

test('趋势面积在缺测点断开，不用填色跨过没有观测的时段', () => {
  const paths = areaSegments([
    { x: 0, y: 10 }, { x: 2, y: 20 }, { x: 4, y: null },
    { x: 6, y: 40 }, { x: 8, y: 30 }, { x: 10, y: Number.NaN },
  ], 10, [0, 50]);
  const polygons = paths.map((path) => [...path.matchAll(/(?:M|L)\s+([\d.]+)\s+([\d.]+)/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) })));
  assert.deepEqual(polygons.map((points) => [Math.min(...points.map((point) => point.x)), Math.max(...points.map((point) => point.x))]),
    [[0, 200], [600, 800]], '两段面积各自停在最后真实观测位置，4秒缺测处不得连过去');
  assert.ok(paths.every((path) => path.endsWith(' Z')), '每段面积应单独闭合');
  assert.ok(polygons[1]?.some((point) => point.x === 600 && Math.abs(point.y - 20) < 0.000001),
    '40/50 的真实读数对应绘图区20%的纵向位置');
  assert.deepEqual(areaSegments([{ x: 0, y: null }, { x: 1, y: Number.NaN }], 10, [0, 50]), []);
});

test('点击画面或三张曲线均选择原始采样点，不压缩缺帧后的索引', async () => {
  await interactBoard(async (target, browser, picks) => {
    const last = target.querySelector('[aria-label="采样画面 6，10.00 秒"]');
    assert.ok(last instanceof browser.window.HTMLButtonElement);
    await act(async () => { last.click(); });
    assert.deepEqual(picks, [5], '第五点缺帧不应使最后一张画面的回调索引变成4');
    for (const name of ['帧率曲线', 'CPU 占用曲线', '内存曲线']) {
      const pick = target.querySelector(`[aria-label="图表选点 ${name} 8"]`);
      assert.ok(pick instanceof browser.window.HTMLButtonElement);
      await act(async () => { pick.click(); });
    }
    assert.deepEqual(picks, [5, 4, 4, 4], '三类指标应能一致选中没有画面的第五点');
  });
});

test('各指标时间轴键盘按原样本顺序选择，缺帧不跳过并支持首尾定位', async () => {
  await interactBoard(async (target, browser, picks) => {
    for (const metric of ['帧率', 'CPU', '内存']) {
      const axis = target.querySelector(`[role="slider"][aria-label="${metric}采样选择"]`);
      assert.ok(axis);
      assert.equal(axis.getAttribute('tabindex'), '0');
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) await act(async () => {
        axis.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key, bubbles: true }));
      });
    }
    assert.deepEqual(picks, [2, 4, 0, 5, 2, 4, 0, 5, 2, 4, 0, 5]);
  });
});

test('窄窗口只在所选画面超出可视边缘时横移，并限制首尾滚动范围', () => {
  assert.equal(selectedTimelineScrollLeft(1072, 800, 0, 1132), 323, '末帧超出右侧，应刚好露出完整缩略图');
  assert.equal(selectedTimelineScrollLeft(224, 800, 332, 1132), 173, '回到首帧只需把左边缘滚入');
  assert.equal(selectedTimelineScrollLeft(600, 800, 100, 1132), 100, '已完整可见时保持用户原滚动位置');
  assert.equal(selectedTimelineScrollLeft(0, 800, 0, 1132), 0);
  assert.equal(selectedTimelineScrollLeft(1132, 800, 300, 1132), 332);
  assert.equal(selectedTimelineScrollLeft(224, 1400, 0, 1132), 0, '窗口足够宽时不得产生横移');
  assert.equal(selectedTimelineScrollLeft(900, 0, 120, 1132), 120, '还没有测出视口时保留现有滚动位置');
});

test('选点变化仅横移同一个共享画布，保留纵向位置且已可见时不动', async () => {
  await interactBoard(async (target, browser, _picks, select) => {
    const viewport = target.querySelector('[data-performance-board]');
    const frameGroup = target.querySelector('[role="group"][aria-label="采样画面"]');
    assert.ok(viewport instanceof browser.window.HTMLElement);
    assert.ok(frameGroup instanceof browser.window.HTMLElement);
    const verticalWrites: number[] = [];
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true, get: () => 117, set: (value: number) => { verticalWrites.push(value); },
    });
    frameGroup.scrollLeft = 37;
    viewport.scrollLeft = 132;
    await select(2);
    assert.equal(viewport.scrollLeft, 132, '当前点已可见，保留现有共享横向位置');
    await select(5);
    assert.equal(viewport.scrollLeft, 323, '末采样点应完整进入同一共享视口');
    await select(0);
    assert.equal(viewport.scrollLeft, 173, '切回首采样点仅做必要的横向移动');
    assert.equal(frameGroup.scrollLeft, 37, '不能单独滚动画面带造成它与三图坐标错位');
    assert.equal(viewport.scrollTop, 117);
    assert.deepEqual(verticalWrites, [], '选点不能改变用户正在查看的纵向指标位置');
    assert.equal(target.querySelectorAll('[data-performance-board]').length, 1);
    assert.equal(target.querySelectorAll('[data-shared-time-canvas]').length, 1);
    const charts = [...target.querySelectorAll('[role="group"][aria-label$="曲线"]')];
    assert.ok(charts.every((chart) => chart.getAttribute('data-cursor') === '0'));
    assert.equal(target.querySelector('[aria-label="采样画面 1，0.00 秒"]')?.getAttribute('aria-pressed'), 'true');
  }, 800);
});
