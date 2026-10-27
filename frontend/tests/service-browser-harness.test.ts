import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

interface Fixture {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly archive: Buffer;
  readonly files: readonly { readonly path: string; readonly bytes: string }[];
}
interface Identity { readonly name: string; readonly bytes: number; readonly sha256: string }
interface Runner {
  createServiceFixtures(): Promise<readonly Fixture[]>;
  captureDist(directory: string): Promise<{ inputs: readonly Identity[]; files: ReadonlyMap<string, Buffer> }>;
  validateBrowserResult(value: unknown): void;
  readonly requiredChecks: readonly string[];
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function runner(value: unknown): value is Runner {
  return object(value) && typeof value['createServiceFixtures'] === 'function' &&
    typeof value['captureDist'] === 'function' && typeof value['validateBrowserResult'] === 'function' &&
    Array.isArray(value['requiredChecks']) && value['requiredChecks'].every((name: unknown) => typeof name === 'string');
}
async function loadRunner(): Promise<Runner> {
  const value: unknown = await import(pathToFileURL(resolve(import.meta.dirname, '../../scripts/service-composition-browser-smoke.mjs')).href);
  assert.ok(runner(value), '根验收驱动缺少可检查的纯函数入口');
  return value;
}
function unpack(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const result = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const name = tar.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/su, '');
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0.*$/su, ''), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'TGZ条目边界无效');
    assert.ok(name.startsWith('package/') && !name.includes('..') && !result.has(name.slice(8)), 'TGZ路径或重复条目无效');
    result.set(name.slice(8), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.subarray(offset).every((byte) => byte === 0), 'TGZ结尾不是归档结束块');
  return result;
}

test('两个真实TGZ各自携带转译示例，SDK类型依赖消除且React裸模块名保留', async () => {
  const current = await loadRunner();
  const fixtures = await current.createServiceFixtures();
  assert.deepEqual(fixtures.map((entry) => entry.id), ['example.service-provider', 'example.service-consumer']);
  for (const fixture of fixtures) {
    const archive = unpack(fixture.archive);
    assert.equal(archive.size, 5);
    for (const file of fixture.files) assert.equal(archive.get(file.path)?.toString('utf8'), file.bytes);
    const manifest: unknown = JSON.parse(archive.get('plugin.json')?.toString('utf8') ?? 'null');
    assert.ok(object(manifest) && manifest['id'] === fixture.id && manifest['api_version'] === 2);
    const descriptor: unknown = JSON.parse(archive.get('package.json')?.toString('utf8') ?? 'null');
    assert.ok(object(descriptor) && descriptor['type'] === 'module' && object(descriptor['deviceforge']));
    assert.equal(descriptor['deviceforge']['kind'], 'browser');
    const example = archive.get('dist/example.js')?.toString('utf8');
    assert.ok(example && !example.includes('plugin-sdk') && !/^import\s/mu.test(example), '包不应带宿主源码依赖');
    assert.ok(fixture.source.includes('import type'), '夹具没有从原始SDK模板构建');
    const probe = archive.get('dist/react-probe.js')?.toString('utf8');
    assert.ok(probe);
    const parsed = ts.createSourceFile('probe.js', probe, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const imports = parsed.statements.filter(ts.isImportDeclaration);
    assert.deepEqual(imports.map((entry) => ts.isStringLiteral(entry.moduleSpecifier) ? entry.moduleSpecifier.text : ''),
      ['react', 'react-dom/client', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
    for (const entry of imports) assert.ok(entry.importClause?.namedBindings && ts.isNamedImports(entry.importClause.namedBindings), '每个React说明符都必须经过原生命名导入');
    const entry = archive.get('dist/index.js')?.toString('utf8');
    assert.ok(entry, '独立安装包缺少入口');
    assert.ok(entry.includes("import original from './example.js'") && entry.includes("from './react-probe.js'"));
    assert.ok(entry.includes('context.extensions.register'), '额外验收贡献必须通过公开SDK登记');
    assert.ok(!entry.includes('runtime.register') && !entry.includes('src/app'), '安装包不得引用宿主私有注册入口');
  }
});

test('整个dist身份覆盖嵌套资产和非JS文件，能观察修改与新增', async () => {
  const current = await loadRunner();
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-service-dist-test-'));
  try {
    await mkdir(join(directory, 'assets/nested'), { recursive: true });
    await writeFile(join(directory, 'index.html'), '生产导入映射', 'utf8');
    await writeFile(join(directory, 'assets/nested/chunk.js'), 'export const 版本 = 1;', 'utf8');
    await writeFile(join(directory, 'assets/theme.css'), ':root{}', 'utf8');
    await writeFile(join(directory, 'assets/chunk.js.map'), '{}', 'utf8');
    const first = await current.captureDist(directory);
    assert.deepEqual(first.inputs.map((entry) => entry.name).sort(), ['assets/chunk.js.map', 'assets/nested/chunk.js', 'assets/theme.css', 'index.html']);
    for (const identity of first.inputs) {
      const bytes = await readFile(join(directory, identity.name));
      assert.equal(identity.bytes, bytes.length);
      assert.equal(identity.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(first.files.get(identity.name), bytes);
    }
    await writeFile(join(directory, 'assets/theme.css'), ':root{--color:test}', 'utf8');
    assert.notDeepEqual((await current.captureDist(directory)).inputs, first.inputs, '非JS资产改变必须改变冻结身份');
    await writeFile(join(directory, 'plugin-react.js'), 'export const 宿主 = true;', 'utf8');
    assert.equal((await current.captureDist(directory)).inputs.length, first.inputs.length + 1);
  } finally {
    const within = relative(tmpdir(), directory);
    assert.ok(within && !within.startsWith('..') && within.startsWith('deviceforge-service-dist-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('只有全部必需项唯一通过才能接受浏览器报告，失败或缺失不可由总passed掩盖', async () => {
  const current = await loadRunner();
  const checks = current.requiredChecks.map((name) => ({ name, passed: true }));
  current.validateBrowserResult({ passed: true, checks });
  assert.throws(() => current.validateBrowserResult({ passed: true, checks: checks.slice(1) }), /缺少唯一通过证据/u);
  assert.throws(() => current.validateBrowserResult({ passed: true, checks: [...checks, checks[0]] }), /缺少唯一通过证据/u);
  assert.throws(() => current.validateBrowserResult({ passed: true, checks: [...checks, { name: '额外失败', passed: false }] }), /存在失败/u);
  assert.throws(() => current.validateBrowserResult({ passed: false, checks }), /未通过/u);
});
