import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedEntry = resolve(fileURLToPath(new URL('./cli-smoke.mjs', import.meta.url)));

// 只干预本工程验收入口，子进程即使继承预加载参数也不修改其 fetch。
if (process.argv[1] && resolve(process.argv[1]) === expectedEntry) {
  const originalFetch = globalThis.fetch;
  let claimed = false;

  globalThis.fetch = async function (...args) {
    const response = await Reflect.apply(originalFetch, this, args);
    if (claimed || !response.ok || !isHostGet(args[0], args[1])) return response;

    // 先认领避免并发重复注入；之后所有请求，包括退出请求，均直接透传。
    claimed = true;
    await consumeBody(response);
    const error = new Error('CLI 验收已完整读取生产宿主，注入一次受控失败');
    error.name = 'CliControlledFailure';
    throw error;
  };
}

function isHostGet(resource, options) {
  let url;
  let method = 'GET';
  if (typeof resource === 'string' || resource instanceof URL) {
    url = resource;
  } else if (resource instanceof Request) {
    url = resource.url;
    method = resource.method;
  } else {
    return false;
  }
  method = options?.method ?? method;
  if (String(method).toUpperCase() !== 'GET') return false;
  try {
    return new URL(url).pathname === '/assets/plugin-host.js';
  } catch {
    return false;
  }
}

async function consumeBody(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const limit = 16 * 1024 * 1024;
  let bytes = 0;
  let completed = false;
  let timer;
  // 逐块计数而不保存正文；整体读取期限不会随每个分块重新开始。
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('受控验收响应读取超过 3 秒')), 3000);
    timer.unref?.();
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk.done) {
        completed = true;
        return;
      }
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error('受控验收响应超过 16 MiB 读取上限');
    }
  } finally {
    clearTimeout(timer);
    // 读取失败保留原错误，不等待可能阻塞的流取消；已读完时只释放读锁。
    if (!completed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
