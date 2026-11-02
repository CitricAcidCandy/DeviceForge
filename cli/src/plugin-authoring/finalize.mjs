import { lstat, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const pauses = [100, 200, 400, 800, 1600, 3200, 3200];
const codedError = (code, message) => Object.assign(new Error(message), { code });
const pause = (milliseconds, signal) => delay(milliseconds, undefined, { signal });

/** 只在十秒内退避同卷目录提交；失败不重做打包、不覆盖目标，迟到回执不触发重放。 */
export async function finalizePluginDirectory(source, target, {
  signal, rename: move = rename, lstat: inspect = lstat, realpath: canonical = realpath,
  delay: wait = pause, now = () => performance.now(),
} = {}) {
  signal?.throwIfAborted();
  source = resolve(source); target = resolve(target);
  if (!/^\.deviceforge-pack-[A-Za-z0-9]{6}$/u.test(basename(source)) || source === target)
    throw new Error('发布源必须是本次独占打包暂存目录');
  const deadline = now() + 10000;
  let lastFailure;

  // 文件系统调用不能强制取消；停止等待后仍消费迟到回执，绝不再次派发。
  const bounded = (operation) => new Promise((accept, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else accept(value);
    };
    const aborted = () => finish(signal.reason);
    const remaining = deadline - now();
    const timer = setTimeout(() => finish(codedError('ETIMEDOUT', '发布目录提交等待已到期限，结果需核对')), Math.max(0, remaining));
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    if (remaining <= 0) { finish(lastFailure ?? codedError('ETIMEDOUT', '发布目录提交已到期限')); return; }
    Promise.resolve().then(() => {
      signal?.throwIfAborted();
      return operation();
    }).then((value) => finish(null, value), (error) => finish(error));
  });
  const sourceParent = await bounded(() => canonical(dirname(source)));
  const targetParent = await bounded(() => canonical(dirname(target)));
  if (sourceParent !== targetParent || source !== join(sourceParent, basename(source)))
    throw new Error('发布暂存与目标必须使用同一真实父目录');
  let identity;
  const check = async () => {
    signal?.throwIfAborted();
    const current = await bounded(() => inspect(source));
    if (!current.isDirectory() || current.isSymbolicLink() || await bounded(() => canonical(source)) !== source)
      throw new Error('发布暂存必须保持原普通目录');
    if (identity && (current.dev !== identity.dev || current.ino !== identity.ino))
      throw new Error('发布暂存身份已改变，不再重试');
    identity ??= current;
    try {
      await bounded(() => inspect(target));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    throw codedError('EEXIST', '输出目录已经存在，不再重试或覆盖');
  };

  for (let attempt = 0; attempt <= pauses.length; attempt++) {
    await check();
    signal?.throwIfAborted();
    try {
      await bounded(() => move(source, target));
      return;
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
      lastFailure = error;
      if (attempt === pauses.length || now() >= deadline) throw error;
      await check();
      const milliseconds = pauses[attempt];
      if (milliseconds >= deadline - now()) throw error;
      await bounded(() => wait(milliseconds, signal));
    }
  }
}
