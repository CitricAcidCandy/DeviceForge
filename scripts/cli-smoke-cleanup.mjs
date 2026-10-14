import { stopManaged } from '../cli/src/processes.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// 等待直接包装进程时取消计时器；超时只表示尚未确认退出。
async function bounded(pending, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(pending).then((value) => ({ completed: true, value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForNpxExit(managed, milliseconds = 10000) {
  const result = await bounded(managed.closed, milliseconds);
  return result.completed ? result.value : null;
}

async function requestShutdown(target) {
  const deadline = Date.now() + 10000;
  const attempts = [];
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: target.headers,
        signal: AbortSignal.timeout(Math.min(1500, Math.max(1, deadline - Date.now()))),
      });
    } catch (error) {
      return {
        status: attempts.at(-1)?.status ?? null,
        attempts,
        error_name: error.name,
        error_code: error.code,
        exit: null,
      };
    }
    const rawRetry = response.headers.get('retry-after');
    const seconds = rawRetry !== null && /^\d+$/.test(rawRetry) ? Number(rawRetry) : null;
    attempts.push({
      status: response.status,
      ...(seconds !== null ? { retry_after_seconds: seconds } : {}),
    });
    void response.body?.cancel().catch(() => {});
    if (response.status !== 429) return { status: response.status, attempts, exit: null };
    const milliseconds = seconds === null ? 250 : Math.max(50, seconds * 1000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds >= deadline - Date.now()) {
      return { status: response.status, attempts, exit: null, retry_budget_exhausted: true };
    }
    await delay(milliseconds);
  }
  return {
    status: attempts.at(-1)?.status ?? null,
    attempts,
    exit: null,
    retry_budget_exhausted: true,
  };
}

// 控制目标包含私有请求头，只用于本次关闭，不进入返回证据。
export async function cleanupNpxRuntime({ running, target, assertPortReleased }) {
  const result = { passed: true, shutdown: null, wrapper: null, ports_released: null };
  if (target) {
    try {
      result.shutdown = await requestShutdown(target);
    } catch (error) {
      result.shutdown = { error_name: error.name, error_code: error.code, exit: null };
    }
  }
  if (running) {
    let stopped;
    let forced = false;
    try {
      stopped = await waitForNpxExit(running);
      if (!stopped) {
        forced = true;
        const outcome = await bounded(stopManaged(running), 10000);
        stopped = outcome.completed ? outcome.value : null;
      }
      result.wrapper = {
        forced,
        exit_confirmed: Boolean(stopped),
        exit: stopped ? { code: stopped.code, signal: stopped.signal } : null,
      };
      if (result.shutdown) result.shutdown.exit = result.wrapper.exit;
      if (!stopped || stopped.code !== 0 || forced) result.passed = false;
    } catch (error) {
      result.passed = false;
      result.wrapper = {
        forced,
        exit_confirmed: false,
        error_name: error.name,
        error_code: error.code,
      };
    }
    if (!result.wrapper.exit_confirmed) {
      // 只释放本次持有句柄的事件循环引用，退出未确认仍为失败且保留目录。
      running.child.unref();
      running.child.stdout?.unref?.();
      running.child.stderr?.unref?.();
    }
  }
  if (target) {
    result.ports = [];
    for (const [role, port] of [
      ['web', target.webPort],
      ['mcp', target.mcpPort],
    ]) {
      try {
        await assertPortReleased(port);
        result.ports.push({ role, port, released: true });
      } catch (error) {
        result.passed = false;
        const failure = { name: error.name, code: error.code };
        result.ports.push({ role, port, released: false, error: failure });
        result.port_error ??= failure;
      }
    }
    result.ports_released = result.ports.every((port) => port.released);
  }
  return result;
}
