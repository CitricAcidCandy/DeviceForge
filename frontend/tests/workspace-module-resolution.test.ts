import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { build, type InlineConfig } from 'vite';
import { workspaceModuleResolution } from '../scripts/workspace-module-resolution.ts';

test('工作区公开子路径在主环境与独立Worker编译中共享精确别名解析', async () => {
  const prefix = 'deviceforge-workspace-worker-';
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicImport = '@deviceforge/workspace-worker-fixture/api';
  const publicValue = 'workspace-public-api-ready';
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'publish'));
    await writeFile(join(root, 'src', 'main.ts'), [
      'export function startWorker() {',
      "  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });",
      '}',
      '',
    ].join('\n'));
    await writeFile(join(root, 'src', 'worker.ts'), [
      `import { readPublicValue } from '${publicImport}';`,
      'self.postMessage(readPublicValue());',
      '',
    ].join('\n'));
    await writeFile(join(root, 'publish', 'api.ts'), [
      'export function readPublicValue() {',
      `  return '${publicValue}';`,
      '}',
      '',
    ].join('\n'));

    const aliases = new Map([[publicImport, join(root, 'publish', 'api.ts')]]);
    const fixture: InlineConfig = {
      root,
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      cacheDir: join(root, '.cache'),
      build: {
        write: false,
        watch: null,
        minify: false,
        emptyOutDir: false,
        outDir: join(root, 'dist'),
        lib: { entry: join(root, 'src', 'main.ts'), formats: ['es'], fileName: 'main' },
      },
    };

    await assert.rejects(build({
      ...fixture,
      plugins: workspaceModuleResolution(aliases).plugins,
      worker: { format: 'es' },
    }), (reason: unknown) => reason instanceof Error && reason.message.includes(publicImport) &&
      /(?:could not resolve|failed to resolve|cannot resolve)/iu.test(reason.message),
    '仅主环境登记别名必须复现Worker的公开子路径解析失败');

    const result = await build({ ...fixture, ...workspaceModuleResolution(aliases) });
    const bundles = Array.isArray(result) ? result : [result];
    const workerSources: string[] = [];
    let hasMainWorkerEntry = false;
    for (const bundle of bundles) {
      assert.ok('output' in bundle, '一次性编译不能返回常驻监听器');
      for (const output of bundle.output) {
        if (output.type === 'chunk' && output.isEntry)
          hasMainWorkerEntry ||= output.code.includes('new Worker');
        if (!/(?:^|\/)worker-[^/]+\.js$/u.test(output.fileName)) continue;
        workerSources.push(output.type === 'chunk' ? output.code :
          typeof output.source === 'string' ? output.source : Buffer.from(output.source).toString('utf8'));
      }
    }

    assert.equal(hasMainWorkerEntry, true, '主入口必须实际保留独立Worker启动代码');
    assert.equal(workerSources.length, 1, '夹具必须实际生成一个独立Worker产物');
    const workerCode = workerSources[0];
    assert.ok(workerCode);
    assert.ok(workerCode.includes(publicValue), 'Worker产物必须包含公开模块的真实实现');
    assert.match(workerCode, /postMessage/u);
    assert.equal(workerCode.includes(publicImport), false, '公开包不能残留为未解析导入');
    assert.doesNotMatch(workerCode,
      /\b(?:from\s*|import\s*(?:\(\s*)?)["'](?![./]|[a-z][a-z\d+.-]*:)[^"']+["']/iu,
      'Worker产物不能保留裸模块导入');
  } finally {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith(prefix))
      throw new Error('Worker单元临时目录范围不明，保留现场');
    await rm(absolute, { recursive: true, force: true });
    await assert.rejects(access(absolute), { code: 'ENOENT' }, '临时Worker夹具必须完整回收');
  }
});
