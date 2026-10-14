import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface FileResult {
  readonly file: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startFailed: boolean;
  readonly startError: string | null;
}
export async function runTests(
  root = fileURLToPath(new URL('../', import.meta.url)),
): Promise<number> {
  const entries = await readdir(join(root, 'tests'), { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error('测试目录没有可执行的 TypeScript 测试文件');
  const children = new Set<ChildProcess>();
  const results: FileResult[] = [];
  let next = 0;
  let interrupted: NodeJS.Signals | null = null;
  function stop(signal: NodeJS.Signals): void {
    if (interrupted !== null) return;
    interrupted = signal;
    for (const child of children) child.kill(signal);
  }
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const concurrency = Math.min(4, files.length);
  console.log(`前端测试入口：${files.length} 个文件，最多 ${concurrency} 个独立 Node 进程`);
  function runFile(file: string): Promise<FileResult> {
    return new Promise((complete) => {
      console.log(`开始测试：${file}`);
      const child = spawn(process.execPath, [join(root, 'tests', file)], {
        cwd: root,
        stdio: 'inherit',
        shell: false,
      });
      children.add(child);
      let finished = false;
      function settle(result: FileResult): void {
        if (finished) return;
        finished = true;
        children.delete(child);
        const state = result.startFailed
          ? '启动失败'
          : result.signal !== null
            ? `信号 ${result.signal}`
            : `退出码 ${result.code}`;
        console.log(`完成测试：${file}（${state}）`);
        complete(result);
      }
      child.once('error', (error) =>
        settle({
          file,
          code: null,
          signal: null,
          startFailed: true,
          startError: 'code' in error && typeof error.code === 'string' ? error.code : 'unknown',
        }),
      );
      child.once('close', (code, signal) =>
        settle({ file, code, signal, startFailed: false, startError: null }),
      );
    });
  }
  async function worker(): Promise<void> {
    while (interrupted === null) {
      const file = files[next++];
      if (file === undefined) return;
      results.push(await runFile(file));
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  const failures = results.filter(
    (result) => result.startFailed || result.signal !== null || result.code !== 0,
  );
  console.log(
    `前端测试文件汇总：发现 ${files.length}，执行 ${results.length}，通过 ${results.length - failures.length}，失败 ${failures.length}`,
  );
  for (const failure of failures)
    console.error(
      `失败文件：${failure.file}；退出码 ${failure.code}；信号 ${failure.signal}；启动失败 ${failure.startFailed}；启动错误 ${failure.startError}`,
    );
  if (interrupted !== null) return interrupted === 'SIGINT' ? 130 : 143;
  return failures.length > 0 || results.length !== files.length ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runTests();
  } catch {
    console.error('前端测试入口无法读取或启动测试文件');
    process.exitCode = 1;
  }
}
