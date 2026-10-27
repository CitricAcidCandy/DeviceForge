import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface TestPlan {
  readonly serial: readonly string[];
  readonly parallel: readonly string[];
}

// 按值依赖遍历本地模块，避免辅助文件间接起 Vite 时漏入并发队列。
export async function planTestFiles(root: string, files: readonly string[]): Promise<TestPlan> {
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  const options = config.error
    ? { moduleResolution: ts.ModuleResolutionKind.Bundler }
    : ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const graph = new Map<string, Promise<{ vite: boolean; paths: string[] }>>();
  function dependencies(path: string): Promise<{ vite: boolean; paths: string[] }> {
    let cached = graph.get(path);
    if (cached) return cached;
    cached = readFile(path, 'utf8').then((source) => {
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const specifiers: string[] = [];
      function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = node.importClause;
          const bindings = clause?.namedBindings;
          const valueImport = !clause || (!clause.isTypeOnly && (
            !!clause.name || !bindings || ts.isNamespaceImport(bindings) ||
            bindings.elements.some((item) => !item.isTypeOnly)
          ));
          if (valueImport) specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some((item) => !item.isTypeOnly))
            specifiers.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        )) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      const paths: string[] = [];
      let vite = false;
      for (const name of specifiers) {
        if (name === 'vite' || name.startsWith('vite/')) { vite = true; continue; }
        const dependency = ts.resolveModuleName(name, path, options, ts.sys).resolvedModule;
        if (dependency && !dependency.isExternalLibraryImport && !dependency.resolvedFileName.endsWith('.d.ts'))
          paths.push(dependency.resolvedFileName);
        // 原生 Node 的相对 JS 夹具也按其真实位置扫描。
        else if (name.startsWith('.') && /\.[cm]?[jt]sx?$/u.test(name)) paths.push(resolve(dirname(path), name));
      }
      return { vite, paths };
    });
    graph.set(path, cached);
    return cached;
  }
  async function usesVite(path: string, seen: Set<string>): Promise<boolean> {
    if (seen.has(path)) return false;
    seen.add(path);
    const dependency = await dependencies(path);
    if (dependency.vite) return true;
    for (const child of dependency.paths) if (await usesVite(child, seen)) return true;
    return false;
  }
  const serial: string[] = [];
  const parallel: string[] = [];
  for (const file of files) {
    (await usesVite(join(root, 'tests', file), new Set()) ? serial : parallel).push(file);
  }
  return { serial, parallel };
}

export async function runTestPlan(
  plan: TestPlan,
  run: (file: string) => Promise<void>,
  interrupted: () => boolean = () => false,
  concurrency = 4,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('测试并发上限必须是正整数');
  let next = 0;
  async function worker(): Promise<void> {
    while (!interrupted()) {
      const file = plan.parallel[next++];
      if (file === undefined) return;
      await run(file);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.parallel.length) }, worker));
  for (const file of plan.serial) {
    if (interrupted()) break;
    await run(file);
  }
}

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
  const plan = await planTestFiles(root, files);
  const children = new Set<ChildProcess>();
  const results: FileResult[] = [];
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
  console.log(`前端测试入口：${files.length} 个文件；普通 ${plan.parallel.length} 个（最多 4 并发）；Vite ${plan.serial.length} 个（独占串行）`);
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
  try {
    await runTestPlan(plan, async (file) => { results.push(await runFile(file)); }, () => interrupted !== null);
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
