import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';
import ts from 'typescript';
import { packageWorkspaceLibrary } from '../scripts/package-workspace-library.ts';
import type { LibraryPackageResult } from '../scripts/package-workspace-library.ts';
import { libraryMetadata, readWorkspaceLibrary } from '../scripts/workspace-library-package.ts';
import { sdkBrowserPackage } from '../scripts/sdk-repository.ts';

const frontend = resolve(import.meta.dirname, '..');
const library = join(frontend, 'plugins/business-kit');
let temporary = '', originalMetadata = '', built: LibraryPackageResult;
const dependencies = {
  '@deviceforge/plugin-sdk': { version: '0.1.0', declarations: {
    '@deviceforge/plugin-sdk': join(sdkBrowserPackage(frontend, 'sdk'), 'lib/index.d.ts'),
  } },
};
async function unpack(archive: string, root: string): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>();
  for await (const entry of extract()([gunzipSync(await readFile(archive))])) {
    assert.ok(entry.header.name.startsWith('package/'));
    const name = entry.header.name.slice('package/'.length);
    const target = resolve(root, name);
    assert.ok(target.startsWith(resolve(root) + sep));
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    const body = Buffer.concat(chunks);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    contents.set(name, body);
  }
  return contents;
}
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-library-package-'));
  originalMetadata = await readFile(join(library, 'package.json'), 'utf8');
  built = await packageWorkspaceLibrary({ root: library, outputRoot: join(temporary, 'build'), dependencies });
});
after(async () => {
  if (!temporary) return;
  const checked = resolve(temporary);
  assert.ok(checked.startsWith(resolve(tmpdir()) + sep));
  await rm(checked, { recursive: true, force: true });
});

test('业务辅助库实际 TGZ 只包含独立发行出口，源工程和共享 React 保持原样', async () => {
  const contents = await unpack(built.archive, join(temporary, 'inspection'));
  const metadata: unknown = JSON.parse(contents.get('package.json')?.toString('utf8') ?? 'null');
  assert.ok(metadata && typeof metadata === 'object' && 'exports' in metadata && 'peerDependencies' in metadata);
  assert.deepEqual(metadata.peerDependencies, { react: '^19.3.0', 'react-dom': '^19.3.0', '@deviceforge/plugin-sdk': '0.1.0' });
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /development|file:|workspace:|devDependencies/);
  assert.ok(contents.has('dist/api/index.js'));
  assert.ok(contents.has('dist/react/dialog.d.ts'));
  assert.equal([...contents.keys()].some((name) => /(?:^|\/)src\/|node_modules|\.tsx?$/.test(name) && !name.endsWith('.d.ts')), false);
  assert.doesNotMatch(contents.get('dist/workspace.d.ts')?.toString() ?? '', /\.tsx?['"]|[A-Z]:\\|\/app\//);
  assert.equal(await readFile(join(library, 'package.json'), 'utf8'), originalMetadata);
  assert.ok(built.bytes > 0 && /^[a-f0-9]{64}$/.test(built.sha256));
});

test('业务辅助库在独立 NodeNext 工程中严格消费真实归档并保持 SDK 错误身份', async () => {
  const consumer = join(temporary, 'consumer');
  const modules = join(consumer, 'node_modules');
  await unpack(built.archive, join(modules, '@deviceforge/business-kit'));
  await unpack(join(sdkBrowserPackage(frontend, 'sdk'), 'dist/deviceforge-plugin-sdk-0.1.0.tgz'), join(modules, '@deviceforge/plugin-sdk'));
  const sourceModules = join(frontend, 'node_modules');
  const metadataFiles = new Set<string>();
  for (const file of built.typeFiles) {
    const path = relative(sourceModules, file);
    if (path === '..' || path.startsWith(`..${sep}`)) continue;
    const target = join(modules, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
    let directory = dirname(file);
    while (directory.startsWith(sourceModules + sep)) {
      const metadata = join(directory, 'package.json');
      if (!metadataFiles.has(metadata) && ts.sys.fileExists(metadata)) {
        const destination = join(modules, relative(sourceModules, metadata));
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(metadata, destination); metadataFiles.add(metadata);
      }
      directory = dirname(directory);
    }
  }
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}');
  const entry = join(consumer, 'index.ts');
  await writeFile(entry, [
    'import { ApiError, apiError } from "@deviceforge/business-kit/api";',
    'import { registerBusinessWorkspace } from "@deviceforge/business-kit/workspace";',
    'import type { HostContext } from "@deviceforge/plugin-sdk";',
    'export function contribute(context: HostContext) {',
    '  registerBusinessWorkspace(context, { pluginId: "consumer", title: "独立功能", route: "/consumer",',
    '    navigation: { group: "扩展", order: 1 }, operations: [], provides: [], mount: async () => () => {} });',
    '}',
    'export const failure = apiError(new ApiError("http", "conflict", "冲突", 409, "actual-log"));',
    '// @ts-expect-error 日志 ID 不接受任务对象。',
    'new ApiError("http", "conflict", "冲突", 409, { taskId: "not-log" });',
  ].join('\n'));
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true, strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [],
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
  const compilerLibraries = join(frontend, 'node_modules/typescript/lib') + sep;
  assert.deepEqual(program.getSourceFiles().map((file) => resolve(file.fileName)).filter((file) =>
    file.startsWith(frontend + sep) && !file.startsWith(compilerLibraries)), []);
  const api = await import(pathToFileURL(join(modules, '@deviceforge/business-kit/dist/api/index.js')).href);
  const sdk = await import(pathToFileURL(join(modules, '@deviceforge/plugin-sdk/lib/index.js')).href);
  assert.equal(api.ApiError, sdk.ApiError);
  const error: unknown = api.apiError(new sdk.ApiError('http', 'conflict', '冲突', 409, 'actual-log'));
  assert.ok(error instanceof sdk.ApiError);
});

test('库发行拒绝未指明的本地依赖和越界出口，不猜测 registry 版本', async () => {
  const kit = await readWorkspaceLibrary(library);
  assert.throws(() => libraryMetadata({ ...kit, metadata: {
    ...kit.metadata, dependencies: { '@deviceforge/unknown': 'file:../unknown' },
  } }, { '@deviceforge/plugin-sdk': '0.1.0' }), /缺少真实配套版本/);
  assert.throws(() => libraryMetadata({ ...kit, metadata: {
    ...kit.metadata, peerDependencies: { '@deviceforge/unknown': 'workspace:*' },
  } }, { '@deviceforge/plugin-sdk': '0.1.0' }), /共享依赖缺少真实配套版本/);
  assert.throws(() => libraryMetadata({ ...kit, metadata: {
    ...kit.metadata, devDependencies: { '@deviceforge/contracts': 'file:../../contracts' },
  } }, { '@deviceforge/plugin-sdk': '0.1.0' }), /明确的公开配套版本/);
  const root = join(temporary, 'invalid');
  await mkdir(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deviceforge/invalid', version: '0.1.0', type: 'module',
    exports: { '.': { development: './src/../../host.ts', types: './dist/index.d.ts', import: './dist/index.js' } } }));
  await assert.rejects(readWorkspaceLibrary(root), /留在本包/);
});

test('库发行不借包外声明掩盖对宿主私有路径的依赖', async () => {
  const root = join(temporary, 'unsafe-declaration');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# 声明边界夹具\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deviceforge/unsafe', version: '0.1.0', type: 'module',
    exports: { '.': { development: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js' } } }));
  await writeFile(join(temporary, 'private.d.ts'), 'export interface PrivateValue { readonly value: string }\n');
  await writeFile(join(root, 'src/index.ts'), 'export type { PrivateValue } from "../../private.d.ts";\n');
  await assert.rejects(packageWorkspaceLibrary({ root, outputRoot: join(temporary, 'unsafe-output'), dependencies: {} }),
    /包外声明不属于/);
});

async function declarationFixture(name: string) {
  const root = join(temporary, name);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# 独立声明夹具\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: `@deviceforge/${name}`, version: '0.1.0', type: 'module',
    exports: { '.': { development: './src/index.ts', types: './dist/index.d.ts', import: './dist/index.js' } } }));
  return root;
}

test('库声明只改写模块说明符，路径字符串常量和字面量类型与运行时一致', async () => {
  const root = await declarationFixture('literal-types');
  await writeFile(join(root, 'src/worker.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'src/index.ts'), [
    'export { value } from "./worker.ts";',
    'export type Worker = typeof import("./worker.ts");',
    'export const sourcePath = "./worker.ts";',
    'export type AllowedSource = "./screen.tsx";',
  ].join('\n'));
  const result = await packageWorkspaceLibrary({ root, dependencies: {} });
  const consumer = join(temporary, 'literal-consumer');
  const contents = await unpack(result.archive, consumer);
  const declaration = contents.get('dist/index.d.ts')?.toString('utf8') ?? '';
  assert.match(declaration, /from ["']\.\/worker\.js["']/);
  assert.match(declaration, /import\(["']\.\/worker\.js["']\)/);
  assert.match(declaration, /sourcePath = ["']\.\/worker\.ts["']/);
  assert.match(declaration, /AllowedSource = ["']\.\/screen\.tsx["']/);
  const runtime = await import(pathToFileURL(join(consumer, 'dist/index.js')).href);
  assert.equal(runtime.sourcePath, './worker.ts');
});

test('库归档包含本包实际引用的传递声明，独立消费者无需原源码', async () => {
  const root = await declarationFixture('local-declarations');
  await writeFile(join(root, 'src/index.ts'), [
    'export type { Shared } from "./shared.js";',
    'export type { Explicit } from "./explicit.d.ts";',
  ].join('\n'));
  await writeFile(join(root, 'src/shared.d.ts'), 'import type { Nested } from "./nested.js";\nexport interface Shared { readonly nested: Nested }\n');
  await writeFile(join(root, 'src/nested.d.ts'), 'export interface Nested { readonly path: "./worker.ts" }\n');
  await writeFile(join(root, 'src/explicit.d.ts'), 'export interface Explicit { readonly enabled: boolean }\n');
  const result = await packageWorkspaceLibrary({ root, dependencies: {} });
  const consumer = join(temporary, 'declaration-consumer');
  const contents = await unpack(result.archive, join(consumer, 'node_modules/@deviceforge/local-declarations'));
  for (const file of ['shared', 'nested', 'explicit']) assert.ok(contents.has(`dist/${file}.d.ts`), file);
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}');
  const entry = join(consumer, 'index.ts');
  await writeFile(entry, [
    'import type { Shared, Explicit } from "@deviceforge/local-declarations";',
    'export const shared: Shared = { nested: { path: "./worker.ts" } };',
    'export const explicit: Explicit = { enabled: true };',
  ].join('\n'));
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true, strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [],
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
  assert.equal(program.getSourceFiles().some((file) => resolve(file.fileName).startsWith(root + sep)), false);
});

test('库发行拒绝本包输入声明中的未解析类型，不把损坏声明归档为成功', async () => {
  const root = await declarationFixture('invalid-local-declarations');
  await writeFile(join(root, 'src/index.ts'), 'export type { Shared } from "./shared.js";\n');
  await writeFile(join(root, 'src/shared.d.ts'), 'export interface Shared { readonly value: Missing }\n');
  await assert.rejects(packageWorkspaceLibrary({ root, dependencies: {} }), /Cannot find name 'Missing'/);
});

test('库发行从既有字符串公开出口派生构建位置，不修改开发清单', async () => {
  const root = await declarationFixture('string-exports');
  const metadata = JSON.stringify({ name: '@deviceforge/string-exports', version: '0.1.0', type: 'module',
    exports: { '.': './src/index.ts', './model': './src/model.ts' } });
  await writeFile(join(root, 'package.json'), metadata);
  await writeFile(join(root, 'src/index.ts'), 'export { value } from "./model.ts";\n');
  await writeFile(join(root, 'src/model.ts'), 'export const value = 42;\n');
  const result = await packageWorkspaceLibrary({ root, dependencies: {} });
  const files = await unpack(result.archive, join(temporary, 'string-consumer'));
  const manifest: unknown = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null');
  assert.ok(manifest && typeof manifest === 'object' && 'exports' in manifest);
  assert.deepEqual(manifest.exports, {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './model': { types: './dist/model.d.ts', import: './dist/model.js' },
  });
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), metadata);
  const runtime = await import(pathToFileURL(join(temporary, 'string-consumer/dist/index.js')).href);
  assert.equal(runtime.value, 42);
});
