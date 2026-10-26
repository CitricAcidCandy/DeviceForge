// 六条轨迹共用真实时间轴：画面、时间轴、帧率、CPU、内存、栈；百分比与内存分轨。
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import type { StackFrame, StackSample } from '../src/features/android-profile/types/index.ts';
import type { BoardSample, SampleBoardProps } from '../src/pages/performance/components/SampleBoard/index.tsx';

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
          return "import { createElement } from 'react'; export function MultiTrackChart(props) { return createElement('div', { role: 'group', 'aria-label': props.ariaLabel, 'data-tracks': JSON.stringify(props.tracks), 'data-x-domain': JSON.stringify(props.xDomain), 'data-cursor': props.cursorX }); }";
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

test('画面轨为每个采样点排一张图，并按时间比例居中', async () => {
  const markup = await renderBoard(3);
  const thumbnails = markup.match(/采样画面 \d+，[\d.]+ 秒/g) ?? [];
  assert.equal(thumbnails.length, 5, '第 5 点没有画面，不应渲染缩略图');
  assert.match(markup, /left:60%/, '第 4 个点 t=6 / span=10 应落在 60%');
  assert.match(markup, /blob:frame-0/);
  assert.match(markup, /title="#4 · 6\.00 s · 真实画面关联说明"/);
  assert.equal((markup.match(/loading="lazy"/g) ?? []).length, 5);
});

test('时间轴刻度按跨度取整秒步长，并覆盖末端', async () => {
  const markup = await renderBoard(3);
  const ticks = [...(markup.match(/>(\d+)s</g) ?? [])].map((tick) => tick.replace(/[>s<]/g, ''));
  assert.deepEqual([...new Set(ticks)], ['0', '2', '4', '6', '8', '10']);
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
  assert.match(partial, />3s</);
  assert.match(partial, />3\.5s</);
});

test('六条固定高度轨道位于同一可滚动图表区，轨道计数留在区外', () => {
  const panel = JSDOM.fragment(renderBoard(3)).querySelector('[aria-label="采样数据面板"]');
  assert.ok(panel);
  const scroll = panel.firstElementChild;
  assert.ok(scroll);
  assert.ok(scroll.classList.contains('overflow-y-auto'));
  const rows = Array.from(scroll.children);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.firstElementChild?.firstElementChild?.textContent),
    ['画面', '时间轴', '帧率', 'CPU', '内存', '调用栈']);
  assert.ok(rows.every((row) => row.classList.contains('shrink-0') && /height:\s*[1-9]\d*px/.test(row.getAttribute('style') ?? '')),
    '滚动区域中的轨道必须保留正高度，不能被 flex 压扁');
  assert.match(panel.lastElementChild?.textContent ?? '', /图表区可滚动.*6 条轨道/);
  assert.notEqual(panel.lastElementChild, scroll);
});

test('帧率轨交给图表组件渲染，右列显示选中点读数', async () => {
  const markup = await renderBoard(3);
  assert.match(markup, /aria-label="帧率曲线"/, '帧率轨应渲染图表容器');
  assert.match(markup, /0–60/, '从零起的真实量程写在标签列');
  assert.match(markup, />41\.5 fps</, '右列显示选中点的读数');
});

test('帧率、CPU、内存分别渲染三张图，当前读数按行对应', () => {
  const panel = JSDOM.fragment(renderBoard(3)).querySelector('[aria-label="采样数据面板"]');
  assert.ok(panel);
  const charts = Array.from(panel.querySelectorAll('[role="group"][aria-label$="曲线"]'));
  assert.deepEqual(charts.map((chart) => chart.getAttribute('aria-label')), ['帧率曲线', 'CPU 占用曲线', '内存曲线']);
  assert.ok(charts.every((chart) => chart.getAttribute('data-x-domain') === '[0,10]' && chart.getAttribute('data-cursor') === '6'),
    '三张图须按同一真实时间范围和当前采样点绘制');
  const cpuTracks: unknown = JSON.parse(charts[1]?.getAttribute('data-tracks') ?? 'null');
  assert.partialDeepStrictEqual(cpuTracks, [{ id: 'cpu', domain: [0, 25], series: [{ id: 'CPU', points: samples.map((sample) => ({ x: sample.t, y: sample.cpu })) }] }]);
  const memoryTracks: unknown = JSON.parse(charts[2]?.getAttribute('data-tracks') ?? 'null');
  assert.partialDeepStrictEqual(memoryTracks, [{ id: 'memory', domain: [0, 460 * 1024], series: [
    { id: 'PSS', points: samples.map((sample) => ({ x: sample.t, y: sample.pssKib })) },
    { id: 'RSS', dashed: true, points: samples.map((sample) => ({ x: sample.t, y: sample.rssKib })) },
  ] }]);
  const rows = Array.from(panel.firstElementChild?.children ?? []);
  assert.equal(rows[0]?.lastElementChild?.textContent, '#4');
  assert.equal(rows[1]?.lastElementChild?.textContent, '6.00 s');
  assert.equal(rows[2]?.lastElementChild?.textContent, '41.5 fps');
  assert.equal(rows[3]?.lastElementChild?.textContent, '23 %');
  assert.deepEqual(Array.from(rows[4]?.firstElementChild?.querySelectorAll('span') ?? [])
    .map((label) => label.textContent), ['内存', 'PSS', 'RSS']);
  assert.deepEqual(Array.from(rows[4]?.lastElementChild?.querySelectorAll('span') ?? [])
    .map((value) => value.textContent), ['0.39 GB', '0.45 GB']);
});

test('低帧、零帧和高刷新率使用真实读数，量程标签同步', () => {
  for (const fps of [0, 12, 77, 120, 144, 240]) {
    const readings = samples.map((sample) => ({ ...sample, fps }));
    const markup = renderBoard(0, readings);
    const ceiling = fps <= 30 ? 30 : fps === 77 ? 90 : fps;
    assert.ok(markup.includes(`0–${ceiling}`), `真实 ${fps} fps 应落在对应量程`);
    assert.ok(markup.includes(`>${fps.toFixed(1)} fps<`), '右列不截断或伪造读数');
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
  const mixed = renderBoard(0, samples.map((sample, index) => index === 0 ? readings[0] ?? sample : sample));
  assert.match(mixed, /aria-label="帧率曲线"/);
  assert.match(mixed, /aria-label="CPU 占用曲线"/);
  assert.match(mixed, /aria-label="内存曲线"/);
  assert.equal((mixed.match(/>—</g) ?? []).length, 4, '选中点的四项缺测均保留，不沿用其他点');
});

test('CPU、PSS、RSS 各自缺测不会隐藏其他指标或沿用其读数', () => {
  for (const missing of ['cpu', 'pssKib', 'rssKib'] as const) {
    const markup = renderBoard(3, samples.map((sample) => ({ ...sample, [missing]: null })));
    const panel = JSDOM.fragment(markup).querySelector('[aria-label="采样数据面板"]');
    assert.ok(panel);
    const rows = Array.from(panel.firstElementChild?.children ?? []);
    assert.ok(panel.querySelector('[aria-label="帧率曲线"]'));
    assert.ok(panel.querySelector('[aria-label="内存曲线"]'), '单条内存指标缺测时仍应显示另一条内存曲线');
    assert.equal(!!panel.querySelector('[aria-label="CPU 占用曲线"]'), missing !== 'cpu');
    assert.equal(rows[3]?.lastElementChild?.textContent, missing === 'cpu' ? '—' : '23 %');
    assert.deepEqual(Array.from(rows[4]?.lastElementChild?.querySelectorAll('span') ?? [])
      .map((value) => value.textContent), [missing === 'pssKib' ? '—' : '0.39 GB', missing === 'rssKib' ? '—' : '0.45 GB']);
    assert.equal((markup.match(/>—</g) ?? []).length, 1, `${missing} 缺测只占用自己的读数槽`);
    assert.equal(markup.includes('无 CPU 观测'), missing === 'cpu');
    const memoryTracks: unknown = JSON.parse(panel.querySelector('[aria-label="内存曲线"]')?.getAttribute('data-tracks') ?? 'null');
    assert.partialDeepStrictEqual(memoryTracks, [{ id: 'memory', series: [
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
