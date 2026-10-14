import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function digest(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function bounded(pending, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// 在 spawn 后立即登记 exit/close/error；失败也保留 OS 退出与有界诊断。
export function observeChild(child, evidence) {
  evidence.pid = child.pid ?? null;
  evidence.forced = false;
  evidence.diagnostic = '';
  const collect = (bytes) => {
    evidence.diagnostic = (evidence.diagnostic + bytes.toString()).slice(-32768);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  child.once('error', (error) => {
    evidence.spawn_error = error.code ?? 'spawn_failed';
  });
  child.once('exit', (code, signal) => {
    evidence.exit = { code, signal, at: new Date().toISOString() };
  });
  child.once('close', (code, signal) => {
    evidence.close = { code, signal, at: new Date().toISOString() };
    resolveClosed(evidence.close);
  });
  return {
    closed,
    async wait(milliseconds) {
      return bounded(closed, milliseconds, '本次子进程退出超时');
    },
    async force() {
      if (evidence.close) return evidence.close;
      if (child.exitCode === null && child.signalCode === null && !evidence.spawn_error) {
        evidence.forced = true;
        child.kill();
      }
      return bounded(closed, 5000, '本次子进程强制收敛超时');
    },
  };
}

export function normalExit(evidence) {
  return (
    !evidence.forced &&
    !evidence.spawn_error &&
    evidence.exit?.code === 0 &&
    evidence.exit.signal === null &&
    evidence.close?.code === 0 &&
    evidence.close.signal === null
  );
}
