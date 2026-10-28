import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import ts from 'typescript';
import { debuggerFixtureIds, debuggerObject, debuggerRecords, debuggerText } from './debugger-fixture-contract.ts';

export const debuggerProject = fileURLToPath(new URL('../../', import.meta.url));
export const debuggerPublicEntries = {
  'deviceforge-host': 'plugin-host.js', react: 'plugin-react.js', 'react-dom': 'plugin-react-dom.js',
  'react-dom/client': 'plugin-react-dom-client.js', 'react/jsx-runtime': 'plugin-jsx-runtime.js',
  'react/jsx-dev-runtime': 'plugin-jsx-dev-runtime.js',
};
export const debuggerDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface DebuggerPackage { readonly id: string; readonly kind: 'browser' | 'server'; readonly bytes: Uint8Array; }
interface FixtureModule { serverFixture(protocol: number): { id: string; archive: Uint8Array }; }
const fixtureModule = (value: unknown): value is FixtureModule =>
  typeof debuggerObject(value)['serverFixture'] === 'function';

/** 只转译独立插件自身，类型导入擦除后不允许残留宿主路径和运行时导入。 */
export function debuggerCompile(source: string, filename: string, version = '1.0.0'): string {
  const result = ts.transpileModule(source.replace("version: '1.0.0'", `version: '${version}'`), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
  });
  assert.ok(!(result.diagnostics ?? []).some((entry) => entry.category === ts.DiagnosticCategory.Error), '独立插件转译失败');
  assert.doesNotMatch(result.outputText, /(?:\bimport\s*(?:\(|[{'"*\w])|\bfrom\s*['"]|frontend\/src|__DEVICEFORGE)/, '独立插件存在运行时源码依赖');
  return result.outputText;
}
export function debuggerZip(files: Readonly<Record<string, string | Uint8Array>>) {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'));
    return [path, [typeof value === 'string' ? strToU8(value) : value, { mtime: new Date('2026-10-28T00:00:00Z') }]];
  })), { level: 6 });
}
export async function createDebuggerPackages(): Promise<DebuggerPackage[]> {
  const packages: DebuggerPackage[] = [];
  for (const kind of ['provider', 'consumer'] as const) {
    const id = debuggerFixtureIds[kind];
    const filename = `debugger-fixture-${kind}.ts`;
    const source = await readFile(new URL(filename, import.meta.url), 'utf8');
    for (const version of kind === 'provider' ? ['1.0.0', '1.0.1'] : ['1.0.0']) {
      const descriptor = { name: id, version, type: 'module', deviceforge: {
        kind: 'browser', manifest: 'plugin.json', entrypoints: { any: { runtime: 'browser', path: 'dist/index.js' } },
      } };
      packages.push({ id, kind: 'browser', bytes: debuggerZip({
        'package.json': JSON.stringify(descriptor), 'plugin.json': JSON.stringify({ id, version, api_version: 2 }),
        'dist/index.js': debuggerCompile(source, filename, version),
      }) });
    }
  }
  const module: unknown = await import(pathToFileURL(join(debuggerProject, 'backend/scripts/online-plugins/fixtures.mjs')).href);
  assert.ok(fixtureModule(module));
  const server = module.serverFixture(2);
  assert.ok(server.archive instanceof Uint8Array);
  packages.push({ id: server.id, kind: 'server', bytes: server.archive });
  return packages;
}
export async function prepareDebuggerFixtures(output: string) {
  await mkdir(output, { recursive: true });
  const records = [];
  let provider = 0;
  for (const entry of await createDebuggerPackages()) {
    const update = entry.id === debuggerFixtureIds.provider && provider++ > 0;
    const filename = `${entry.id}${update ? '-update' : ''}.${entry.kind === 'server' ? 'tgz' : 'zip'}`;
    await writeFile(join(output, filename), entry.bytes, { flag: 'wx' });
    records.push({ id: entry.id, kind: entry.kind, filename, bytes: entry.bytes.length, sha256: debuggerDigest(entry.bytes) });
  }
  await writeFile(join(output, 'fixtures.json'), JSON.stringify(records, null, 2) + '\n', { flag: 'wx' });
  return records;
}
export interface DebuggerFrozenInputs {
  readonly host: { readonly path: string; readonly sha256: string };
  readonly frontend: { readonly directory: string; readonly files: readonly { readonly path: string; readonly sha256: string }[] };
  readonly official: { readonly directory: string; readonly files: readonly { readonly path: string; readonly sha256: string }[] };
}
function absolute(value: unknown) {
  const path = debuggerText(value); assert.ok(isAbsolute(path), '冻结输入必须使用绝对路径'); return resolve(path);
}
function digest(value: unknown) {
  const hash = debuggerText(value); assert.match(hash, /^[a-f0-9]{64}$/); return hash;
}
function frozenDirectory(value: unknown, required: readonly string[]) {
  const item = debuggerObject(value), directory = absolute(item['directory']);
  const files = debuggerRecords(item['files']).map((entry) => {
    const path = debuggerText(entry['path']);
    assert.ok(!isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..'), '冻结条目必须在目录内');
    return { path, sha256: digest(entry['sha256']) };
  });
  assert.equal(new Set(files.map((item) => item.path)).size, files.length, '冻结条目不可重复');
  for (const path of required) assert.ok(files.some((entry) => entry.path === path), `冻结清单缺少 ${path}`);
  return { directory, files };
}
export function parseDebuggerFreeze(value: unknown): DebuggerFrozenInputs {
  const item = debuggerObject(value);
  assert.equal(item['confirmed'], true, '主代理明确冻结同一底座后，才允许启动真实宿主和浏览器');
  const host = debuggerObject(item['host']);
  return { host: { path: absolute(host['path']), sha256: digest(host['sha256']) },
    frontend: frozenDirectory(item['frontend'], ['assets/debugger-browser-harness.js', ...Object.values(debuggerPublicEntries)]),
    official: frozenDirectory(item['official'], ['package.json', 'plugin.json', 'dist/index.js']) };
}
export async function verifyDebuggerFreeze(frozen: DebuggerFrozenInputs) {
  assert.equal(debuggerDigest(await readFile(frozen.host.path)), frozen.host.sha256, '宿主已偏离冻结字节');
  for (const group of [frozen.frontend, frozen.official]) {
    for (const entry of group.files) {
      const path = resolve(group.directory, entry.path);
      assert.ok(relative(group.directory, path) && !relative(group.directory, path).startsWith('..' + sep));
      assert.equal(debuggerDigest(await readFile(path)), entry.sha256, `冻结输入变化：${entry.path}`);
    }
  }
}
export async function officialDebuggerPackage(frozen: DebuggerFrozenInputs) {
  const files: Record<string, Uint8Array> = {};
  for (const entry of frozen.official.files) files[entry.path] = await readFile(join(frozen.official.directory, entry.path));
  const manifest = debuggerObject(JSON.parse(new TextDecoder().decode(files['plugin.json'])));
  assert.equal(manifest['id'], debuggerFixtureIds.official);
  return debuggerZip(files);
}
export function debuggerInside(parent: string, path: string) {
  const child = relative(resolve(parent), resolve(path));
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child), '回收目标必须位于本轮独占目录');
  return resolve(path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  assert.ok(output, '用法：node scripts/debugger-fixture.ts <新的夹具目录>');
  await mkdir(dirname(resolve(output)), { recursive: true });
  console.log(JSON.stringify(await prepareDebuggerFixtures(resolve(output)), null, 2));
}
