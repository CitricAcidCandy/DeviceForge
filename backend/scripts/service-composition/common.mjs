import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const terminal = (job) => ['succeeded', 'failed', 'cancelled'].includes(job.status);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const save = (path, value) => writeFile(path, json(value), 'utf8');

export async function poll(read, predicate, label, timeout = 12000) {
  const until = performance.now() + timeout;
  let last;
  while (performance.now() < until) {
    last = await read();
    if (predicate(last)) return last;
    await delay(30);
  }
  throw new Error(`等待超时：${label}；最后状态：${last?.status ?? '未就绪'}`);
}

export function exited(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, '进程身份必须是正整数');
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    // 无权限观察不是退出证据；不能据此代杀可能已经复用的 PID。
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

export async function markers(directory, phase = 'started', strict = false) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(`.${phase}.json`));
  assert.ok(names.length <= 200, '验收标记数必须有界');
  const records = [];
  for (const name of names) {
    try { records.push(JSON.parse(await readFile(join(directory, name), 'utf8'))); }
    catch (error) {
      // 标记以单次有界写入发布，轮询可遇到尚未写完的文件。
      if (strict || !(error instanceof SyntaxError)) throw error;
    }
  }
  return records.sort((left, right) => left.request_id.localeCompare(right.request_id));
}

export async function waitNewMarker(directory, previous, label) {
  return poll(async () => (await markers(directory)).filter((item) => !previous.has(item.request_id)),
    (items) => items.length === 1, label).then((items) => items[0]);
}

export async function processProof(directory, started, cancelled = false) {
  const finished = await poll(() => markers(directory, 'finished'),
    (items) => items.some((item) => item.request_id === started.request_id), '处理器完成标记');
  const ending = finished.find((item) => item.request_id === started.request_id);
  assert.equal(ending.pid, started.pid);
  if (cancelled) assert.equal(ending.cancelled, true, '目标处理器必须收到真实取消令牌');
  await poll(async () => exited(started.pid), Boolean, '直接插件进程退出', 5000);
  return { ...started, handler_finished: true, cancelled: ending.cancelled, process_exited: true };
}
