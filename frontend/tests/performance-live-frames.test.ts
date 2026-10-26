import assert from 'node:assert/strict';
import test from 'node:test';
import {
  associateLiveFrames, createLiveFrames, LIVE_FRAME_LIMITS,
} from '../src/pages/performance/models/live-frames.ts';
import type { CapturedLiveFrame, LiveFrame } from '../src/pages/performance/models/live-frames.ts';
import type { PerformanceReading } from '../src/features/performance/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred } from './fixtures.ts';

const frame = (index = 0, content = new Blob(['png'])): CapturedLiveFrame => ({
  artifactId: `frame-${index}`, publishedAt: 10_000 + index * 3000, durationMs: 400, content,
});
async function settled() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function fixture(capture: (signal: AbortSignal) => Promise<CapturedLiveFrame>) {
  let next = 0;
  const revoked: string[] = [];
  const timers: { run: () => void; delay: number; cancelled: boolean }[] = [];
  const model = createLiveFrames(capture, {
    createUrl: () => `blob:test-${++next}`,
    revokeUrl: (url) => revoked.push(url),
    schedule: (run, delay) => {
      const timer = { run, delay, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return {
    model, timers, revoked,
    tick() {
      const timer = timers.shift();
      assert.ok(timer, '没有可执行的采样定时器');
      assert.equal(timer.delay, 3000);
      if (!timer.cancelled) timer.run();
    },
  };
}

test('画面等待完成后才安排下一笔，重复启动不并发', async () => {
  let calls = 0;
  const pending = deferred<CapturedLiveFrame>();
  const f = fixture(async () => { calls++; return pending.promise; });
  f.model.start();
  f.model.start();
  assert.equal(calls, 1);
  assert.equal(f.model.snapshot().pending, true);
  assert.equal(f.timers.length, 0);
  pending.resolve(frame());
  await settled();
  assert.equal(f.model.snapshot().frames.length, 1);
  assert.equal(f.timers.length, 1);
  f.model.pause();
  f.tick();
  assert.equal(calls, 1, '暂停后不应再触发定时器');
  f.model.dispose();
  assert.deepEqual(f.revoked, ['blob:test-1']);
});

test('暂停取消在途，晚到画面不进入页面，恢复等待旧读取排空', async () => {
  const pending = deferred<CapturedLiveFrame>();
  const signals: AbortSignal[] = [];
  const f = fixture(async (signal) => {
    signals.push(signal);
    return signals.length === 1 ? pending.promise : frame(1);
  });
  f.model.start();
  f.model.pause();
  assert.equal(signals[0]?.aborted, true);
  f.model.start();
  assert.equal(signals.length, 1);
  pending.resolve(frame());
  await settled();
  assert.equal(f.model.snapshot().frames.length, 0);
  f.tick();
  await settled();
  assert.equal(signals.length, 2);
  assert.equal(f.model.snapshot().frames[0]?.artifactId, 'frame-1');
  f.model.dispose();
  assert.deepEqual(f.revoked, ['blob:test-1']);
});

test('已完成一张后反复暂停恢复也保留截图节流', async () => {
  let calls = 0;
  const f = fixture(async () => frame(calls++));
  f.model.start();
  await settled();
  f.model.pause();
  f.model.start();
  assert.equal(calls, 1);
  f.tick();
  assert.equal(calls, 1, '旧定时器已经撤销');
  f.tick();
  await settled();
  assert.equal(calls, 2);
  f.model.dispose();
});

test('达到20张后停止截图，不允许重试绕过同一会话限额', async () => {
  let count = 0;
  const f = fixture(async () => frame(count++));
  f.model.start();
  for (let index = 0; index < 20; index++) {
    await settled();
    if (index < 19) f.tick();
  }
  assert.equal(count, 20);
  assert.equal(f.model.snapshot().frames.length, 20);
  assert.match(f.model.snapshot().limit ?? '', /20 张/);
  assert.equal(f.model.snapshot().active, false);
  f.model.start();
  assert.equal(count, 20);
  f.model.dispose();
  assert.equal(f.revoked.length, 20);
  assert.equal(new Set(f.revoked).size, 20);
});

test('累计32MiB及单张8MiB限制阻断新对象URL', async () => {
  const content = new Blob([new Uint8Array(LIVE_FRAME_LIMITS.singleBytes)]);
  let calls = 0;
  const f = fixture(async () => frame(calls++, content));
  f.model.start();
  for (let index = 0; index < 5; index++) {
    await settled();
    if (index < 4) f.tick();
  }
  assert.equal(f.model.snapshot().frames.length, 4);
  assert.equal(f.model.snapshot().bytes, LIVE_FRAME_LIMITS.bytes);
  assert.match(f.model.snapshot().limit ?? '', /32 MiB/);
  f.model.start();
  await settled();
  assert.equal(calls, 5, '显式重试也不能绕过容量上限');
  f.model.dispose();
  assert.equal(f.revoked.length, 4);
  const large = fixture(async () => frame(0, new Blob([content, 'x'])));
  large.model.start();
  await settled();
  assert.equal(large.model.snapshot().frames.length, 0);
  assert.ok(large.model.snapshot().error instanceof ApiError);
  assert.equal(large.timers.length, 0);
  large.model.dispose();
});

test('截图失败保留真实日志，只在显式重试后再次采集', async () => {
  let count = 0;
  const error = new ApiError('network', 'frame_failed', '截图读取失败', null, 'frame-error-log');
  const f = fixture(async () => {
    if (count++ === 0) throw error;
    return frame();
  });
  f.model.start();
  await settled();
  assert.equal(f.model.snapshot().error, error);
  assert.equal(f.model.snapshot().active, false);
  assert.equal(f.timers.length, 0);
  f.model.start();
  await settled();
  assert.equal(f.model.snapshot().error, null);
  assert.equal(f.model.snapshot().frames.length, 1);
  f.model.dispose();
});

test('销毁撤销在途与全部URL，晚到结果不能创建新URL或通知订阅', async () => {
  const pending = deferred<CapturedLiveFrame>();
  let signal: AbortSignal | undefined;
  const f = fixture(async (current) => { signal = current; return pending.promise; });
  let notices = 0;
  f.model.subscribe(() => { notices++; });
  f.model.start();
  const before = notices;
  f.model.dispose();
  f.model.dispose();
  assert.equal(signal?.aborted, true);
  pending.resolve(frame());
  await settled();
  assert.equal(notices, before);
  assert.equal(f.model.snapshot().frames.length, 0);
  assert.equal(f.timers.length, 0);
  assert.deepEqual(f.revoked, []);
});

test('提交或取消未确认只停止自动循环，保留原错并允许同会话显式重试', async () => {
  for (const code of ['frame_cancel_unconfirmed', 'frame_submission_unconfirmed']) {
    const error = new ApiError('network', code, '任务 shot-1 状态未确认', null, 'cleanup-log');
    let calls = 0;
    const f = fixture(async () => {
      if (calls++ === 0) throw error;
      return frame();
    });
    try {
      f.model.start();
      await settled();
      assert.equal(f.model.snapshot().error, error);
      assert.equal(f.model.snapshot().limit, null);
      assert.equal(f.model.snapshot().pending, false);
      assert.equal(f.model.snapshot().active, false);
      assert.equal(f.timers.length, 0);
      await settled();
      assert.equal(calls, 1, '未确认后不能自动重交');
      f.model.start();
      f.model.start();
      await settled();
      assert.equal(calls, 2, '只有显式重试提交一笔，重复开始不能并发');
      assert.equal(f.model.snapshot().error, null);
      assert.equal(f.model.snapshot().frames.length, 1);
    } finally { f.model.dispose(); }
  }
});

test('取消确认仍在途时显式开始不能并发，未确认返回后仍需再次显式重试', async () => {
  const pending = deferred<CapturedLiveFrame>();
  const error = new ApiError('network', 'frame_cancel_unconfirmed', '任务 shot-1 取消未确认', null, 'cleanup-log');
  let calls = 0;
  const f = fixture(async () => {
    if (calls++ === 0) return pending.promise;
    return frame();
  });
  try {
    f.model.start();
    f.model.pause();
    f.model.start();
    assert.equal(calls, 1);
    assert.equal(f.model.snapshot().pending, true);
    pending.reject(error);
    await settled();
    assert.equal(f.model.snapshot().error, error);
    assert.equal(f.model.snapshot().active, false);
    assert.equal(f.model.snapshot().pending, false);
    assert.equal(f.model.snapshot().limit, null);
    assert.equal(f.timers.length, 0);
    f.model.start();
    await settled();
    assert.equal(calls, 2);
    assert.equal(f.model.snapshot().frames.length, 1);
  } finally { f.model.dispose(); }
});

test('未确认错误保留已有画面及容量，显式重试仍使用节流和原数量上限', async () => {
  const error = new ApiError('network', 'frame_submission_unconfirmed', '提交未确认', null, 'submit-log');
  let calls = 0;
  const f = fixture(async () => {
    if (calls++ === 1) throw error;
    return frame(calls);
  });
  try {
    f.model.start();
    await settled();
    f.tick();
    await settled();
    assert.equal(f.model.snapshot().error, error);
    assert.equal(f.model.snapshot().frames.length, 1);
    assert.equal(f.model.snapshot().bytes, 3);
    assert.equal(f.timers.length, 0);
    f.model.start();
    assert.equal(calls, 2, '已有画面时显式重试也须等待节流');
    for (let index = 1; index < LIVE_FRAME_LIMITS.frames; index++) {
      f.tick();
      await settled();
    }
    assert.equal(calls, 21);
    assert.equal(f.model.snapshot().frames.length, 20);
    assert.match(f.model.snapshot().limit ?? '', /20 张/);
    f.model.start();
    assert.equal(calls, 21);
  } finally { f.model.dispose(); }
  assert.equal(f.revoked.length, 20);
});

test('销毁后仍独立报告未确认清理错误且不通知旧订阅或重新提交', async () => {
  const error = new ApiError('network', 'frame_cancel_unconfirmed', '取消未确认', null, 'cleanup-log');
  const pending = deferred<CapturedLiveFrame>();
  const reported: ApiError[] = [];
  let calls = 0;
  let notices = 0;
  const disposed = createLiveFrames(() => { calls++; return pending.promise; }, { onCleanupError: (value) => reported.push(value) });
  disposed.subscribe(() => { notices++; });
  disposed.start();
  const before = notices;
  disposed.dispose();
  pending.reject(error);
  await settled();
  assert.deepEqual(reported, [error]);
  assert.equal(notices, before);
  assert.equal(disposed.snapshot().frames.length, 0);
  disposed.start();
  assert.equal(calls, 1);
});

test('仅用服务器时间近邻关联，超出5秒不关联，同一点选择偏差更小的图', () => {
  const reading = (sequence: number, captured_at: number): PerformanceReading => ({
    sequence, captured_at, pid: 1, logical_cpus: 8, pss_kib: 10,
    cpu_share_percent: null, cpu_core_percent: null,
  });
  const image = (publishedAt: number): LiveFrame => ({
    artifactId: String(publishedAt), publishedAt, durationMs: 700, bytes: 3, url: `blob:${publishedAt}`,
  });
  const result = associateLiveFrames([reading(1, 1000), reading(2, 4000)], [
    image(4100), image(4050), image(10000),
  ]);
  assert.equal(result.size, 1);
  assert.equal(result.get(2)?.url, 'blob:4050');
  assert.match(result.get(2)?.note ?? '', /偏差 50 ms/);
  assert.match(result.get(2)?.note ?? '', /非精确单帧/);
  assert.equal(associateLiveFrames([], [image(1)]).size, 0);
});
