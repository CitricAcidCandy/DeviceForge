import { fork } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { commitOutput, digest } from './commit.js';
import { outputFiles } from './imports.js';
import { record, validateInput } from './paths.js';
import { HOST_IMPORTS } from './types.js';
import type {
  BrowserPluginBuildOptions, BrowserPluginBuildResult, PluginBuildFile, PluginModuleImports,
  WorkerBuildInput, WorkerBuildResult,
} from './types.js';

const activeOutputs = new Set<string>();
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function imports(value: unknown): value is PluginModuleImports {
  return record(value) && typeof value.file === 'string' &&
    stringArray(value.static) && stringArray(value.dynamic) && stringArray(value.assets);
}
function isResult(value: unknown): value is WorkerBuildResult {
  return record(value) && stringArray(value.css) && Array.isArray(value.imports) && value.imports.every(imports);
}
async function waitForWorker(input: WorkerBuildInput, signal: AbortSignal): Promise<WorkerBuildResult> {
  signal.throwIfAborted();
  const child = fork(new URL('./worker.js', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [], serialization: 'advanced',
  });
  let stderr = '';
  child.stderr?.on('data', (bytes: Buffer) => { stderr = (stderr + bytes.toString('utf8')).slice(-4096); });
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => resolve(code)); });
  async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    const result = await new Promise<WorkerBuildResult>((resolve, reject) => {
      let settled = false;
      const release = () => { signal.removeEventListener('abort', abort); };
      const fail = (error: unknown) => { if (!settled) { settled = true; release(); reject(error); } };
      const abort = () => fail(signal.reason ?? new Error('插件构建已取消'));
      child.once('error', fail);
      child.once('exit', (code) => {
        if (!settled) fail(new Error(`构建进程在提交回执前退出：${code}${stderr ? `；${stderr}` : ''}`));
      });
      child.once('message', (value: unknown) => {
        if (settled) return;
        if (!record(value)) { fail(new Error('构建进程返回格式无效')); return; }
        if (value.ok === false) { fail(new Error(typeof value.message === 'string' ? value.message : '插件构建失败')); return; }
        if (value.ok !== true || !isResult(value.result)) { fail(new Error('构建进程回执不兼容')); return; }
        settled = true; release(); resolve(value.result);
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else child.send(input, (error) => { if (error) fail(error); });
    });
    const code = await bounded(exited, 5000, '构建完成后进程未在 5 秒内退出');
    if (code !== 0) throw new Error(`构建进程异常退出：${code}${stderr ? `；${stderr}` : ''}`);
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try { await bounded(exited, 5000, '构建进程终止超过 5 秒'); }
      catch {
        child.kill('SIGKILL');
        await bounded(exited, 5000, `构建进程无法回收，PID ${child.pid ?? '未知'}`);
      }
    }
  }
}

/** 固定工具链、独立依赖边界和无破坏输出；不执行插件代码或工程配置。 */
export async function buildBrowserPlugin(options: BrowserPluginBuildOptions): Promise<BrowserPluginBuildResult> {
  const input = await validateInput(options);
  const outputKey = process.platform === 'win32' ? input.outputDir.toLowerCase() : input.outputDir;
  if (activeOutputs.has(outputKey)) throw new Error('同一输出目录已有构建，请等待该构建结束');
  const temporaryRoot = await realpath(tmpdir());
  activeOutputs.add(outputKey);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('插件构建超过 180 秒')), 180_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let stage: string | null = null;
  try {
    signal.throwIfAborted();
    stage = await mkdtemp(join(temporaryRoot, 'deviceforge-plugin-build-stage-'));
    const built = await waitForWorker({ ...input, stage }, signal);
    signal.throwIfAborted();
    const files: PluginBuildFile[] = [];
    for (const path of await outputFiles(stage)) {
      const bytes = await readFile(join(stage, path));
      files.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) });
    }
    if (!files.some((file) => file.path === 'index.js')) throw new Error('构建没有生成插件入口 index.js');
    const hostImports = [...new Set(built.imports.flatMap((module) => [...module.static, ...module.dynamic])
      .filter((id) => HOST_IMPORTS.some((value) => value === id)))].sort();
    const buildId = digest(JSON.stringify({ files, imports: built.imports }));
    const result: BrowserPluginBuildResult = {
      formatVersion: 1, tool: { name: '@deviceforge/plugin-tools', version: '0.1.0' },
      buildId, root: input.root, entry: input.entry, outputDir: input.outputDir,
      entryFile: 'index.js', stylesFile: 'styles.js', reportFile: 'plugin-build.json',
      css: built.css, hostImports, files, imports: built.imports,
    };
    await writeFile(join(stage, result.reportFile), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await commitOutput(stage, result, signal);
    return result;
  } finally {
    clearTimeout(timer); activeOutputs.delete(outputKey);
    if (stage) {
      const checked = await realpath(stage);
      if (dirname(checked) !== temporaryRoot || !basename(checked).startsWith('deviceforge-plugin-build-stage-'))
        throw new Error('拒绝清理不属于本工具的临时目录');
      await rm(checked, { recursive: true, force: true });
    }
  }
}
