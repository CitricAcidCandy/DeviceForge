import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

// Windows 的 npm.cmd 使用固定 npm-cli.js 入口，用户参数始终作为 argv，避免 shell 插值。
export function npmCommand(environment = process.env) {
  const candidates = [
    environment.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ];
  for (const directory of (environment.PATH || environment.Path || '').split(delimiter)) {
    candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'));
  }
  const script = candidates.find((path) => path && path.endsWith('npm-cli.js') && existsSync(path));
  if (script) return { command: process.execPath, prefix: [script] };
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  throw new Error('无法定位 npm-cli.js，请安装完整 Node.js/npm');
}

export function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let failure;
  child.on('error', (error) => {
    failure = error;
  });
  // close 始终被观察，启动失败及正常退出都不会遗留未处理的事件。
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal, failure })),
  );
  return {
    child,
    closed,
    get failure() {
      return failure;
    },
  };
}

export async function stopManaged(managed) {
  if (!managed || managed.child.exitCode !== null || managed.child.signalCode || !managed.child.pid)
    return managed?.closed;
  if (process.platform === 'win32') {
    try {
      await promisify(execFile)('taskkill.exe', ['/PID', String(managed.child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000,
      });
    } catch {
      if (managed.child.exitCode === null) managed.child.kill();
    }
  } else {
    try {
      process.kill(-managed.child.pid, 'SIGTERM');
    } catch {}
    const stopped = await Promise.race([
      managed.closed.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!stopped) {
      try {
        process.kill(-managed.child.pid, 'SIGKILL');
      } catch {}
    }
  }
  return managed.closed;
}

export async function runNpm(args, options = {}) {
  options.signal?.throwIfAborted();
  const entry = npmCommand(options.env);
  const process = spawnManaged(entry.command, [...entry.prefix, ...args], {
    stdio: 'ignore',
    ...options,
  });
  const abort = () => {
    void stopManaged(process);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 120000);
  try {
    const result = await process.closed;
    if (result.failure || result.code !== 0)
      throw new Error('npm 获取插件失败，请核对包名、版本、网络与源配置');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
