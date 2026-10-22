// 五条轨迹必须共用同一组 x：画面、时间轴、帧率、性能、栈都按采样点的真实时间戳定位。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StackFrame, StackSample } from '../src/features/android-profile/types/index.ts';
import type { BoardSample } from '../src/pages/performance/components/SampleBoard/index.tsx';

type BoardModule = { SampleBoard: ComponentType<Record<string, unknown>> };
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
  stacks:
    index === 0
      ? [stack('1', ['event', 'render', 'drawBatches']), stack('2', ['event', 'render', 'upload'])]
      : [],
  note: index === 0 ? null : '本点没有关联到栈样本',
}));

async function renderBoard(selected: number): Promise<string> {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  try {
    const loaded: unknown = await server.ssrLoadModule('/src/pages/performance/components/index.ts');
    assert.ok(boardModule(loaded), '组件入口应导出 SampleBoard');
    return renderToStaticMarkup(
      createElement(loaded.SampleBoard, {
        samples,
        span: 10,
        selected,
        onSelect: () => {},
        frameNote: '没有逐帧画面',
        stackNote: '没有栈样本',
      }),
    );
  } finally {
    await server.close();
  }
}

test('画面轨为每个采样点排一张图，并按时间比例居中', async () => {
  const markup = await renderBoard(3);
  const thumbnails = markup.match(/采样画面 \d+，[\d.]+ 秒/g) ?? [];
  assert.equal(thumbnails.length, 5, '第 5 点没有画面，不应渲染缩略图');
  assert.match(markup, /left:60%/, '第 4 个点 t=6 / span=10 应落在 60%');
  assert.match(markup, /blob:frame-0/);
});

test('时间轴刻度按跨度取整秒步长，并覆盖末端', async () => {
  const markup = await renderBoard(3);
  const ticks = [...(markup.match(/>(\d+)s</g) ?? [])].map((tick) => tick.replace(/[>s<]/g, ''));
  assert.deepEqual([...new Set(ticks)], ['0', '2', '4', '6', '8', '10']);
});

test('帧率轨交给图表组件渲染，右列显示选中点读数', async () => {
  const markup = await renderBoard(3);
  assert.match(markup, /aria-label="帧率曲线"/, '帧率轨应渲染图表容器');
  assert.match(markup, /30–60/, '量程写在标签列');
  assert.match(markup, />41\.5 fps</, '右列显示选中点的读数');
});

test('性能数据轨三条、数值进入共享右列', async () => {
  const markup = await renderBoard(3);
  assert.match(markup, /aria-label="CPU % 曲线"/);
  assert.match(markup, /aria-label="内存 PSS 曲线"/);
  assert.match(markup, /aria-label="内存 RSS 曲线"/);
  assert.match(markup, />23 %</, '选中点 CPU 为 20 + 3');
  assert.match(markup, /0\.39 GB/, 'PSS 400 MiB 换算为 0.39 GB');
});

test('调用栈轨只画当前采样点的栈', async () => {
  const empty = await renderBoard(3);
  assert.match(empty, /本点没有关联到栈样本/, '选中点没有栈时回落到缺测说明');
  const first = await renderBoard(0);
  assert.match(first, /drawBatches/);
  assert.match(first, /upload/);
  assert.match(first, /2 个栈样本/);
});
