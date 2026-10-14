import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// 真实单调时钟等待只用于本轮验收，不变更宿主的操作或清理期限。
export async function waitFor(read, accept, label, timeoutMs, intervalMs = 50) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(Math.min(intervalMs, Math.max(0, deadline - performance.now())));
  }
  assert.fail(`${label}：有界观察超时`);
}

export function monotonicNs() {
  return process.hrtime.bigint().toString();
}

export function elapsedMs(start, end) {
  assert.match(start, /^\d+$/);
  assert.match(end, /^\d+$/);
  const elapsed = BigInt(end) - BigInt(start);
  assert.ok(elapsed >= 0n, '同一进程单调时钟不得回退');
  return Number(elapsed) / 1_000_000;
}

export async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}：有界等待超时`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
