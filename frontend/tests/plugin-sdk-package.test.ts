import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { extract } from 'it-tar';
import ts from 'typescript';
import { packagePluginSdk } from '../scripts/package-plugin-sdk.ts';

let temporary = '';
let archive = '';
let packageRoot = '';
let typeFiles: readonly string[] = [];
let dependencyRoot = '';
const frontend = resolve(import.meta.dirname, '..');

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-independent-sdk-'));
  const built = await packagePluginSdk({ outputRoot: join(temporary, 'distribution') });
  archive = built.archive;
  typeFiles = built.typeFiles;
  dependencyRoot = built.dependencyRoot;
  packageRoot = join(temporary, 'consumer/node_modules/@deviceforge/plugin-sdk');
  const tar = gunzipSync(await readFile(archive));
  for await (const entry of extract()([tar])) {
    assert.ok(entry.header.name.startsWith('package/'));
    const destination = resolve(packageRoot, entry.header.name.slice('package/'.length));
    assert.ok(destination.startsWith(resolve(packageRoot) + sep));
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.concat(chunks));
  }
  // 只复制 SDK 声明实际引用的公开第三方类型，不拷贝宿主源码或使用源码路径映射。
  const copied = new Set<string>();
  for (const file of typeFiles) {
    const path = relative(dependencyRoot, file);
    assert.ok(!path.startsWith('..'));
    const destination = join(temporary, 'consumer/node_modules', path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
    let directory = dirname(file);
    while (directory.startsWith(dependencyRoot + sep)) {
      const metadata = join(directory, 'package.json');
      if (!copied.has(metadata) && ts.sys.fileExists(metadata)) {
        const output = join(temporary, 'consumer/node_modules', relative(dependencyRoot, metadata));
        await mkdir(dirname(output), { recursive: true });
        await copyFile(metadata, output);
        copied.add(metadata);
      }
      directory = dirname(directory);
    }
  }
});
after(async () => {
  if (!temporary) return;
  const checked = resolve(temporary);
  assert.ok(checked.startsWith(resolve(tmpdir()) + sep));
  await rm(checked, { recursive: true, force: true });
});

test('真实 TGZ 保留独立 ESM 与声明，不包含宿主源码、源码路径或发布假象', async () => {
  const metadata: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(metadata && typeof metadata === 'object' && 'name' in metadata && 'private' in metadata);
  assert.equal(metadata.name, '@deviceforge/plugin-sdk');
  assert.equal(metadata.private, true);
  const declaration = await readFile(join(packageRoot, 'lib/index.d.ts'), 'utf8');
  assert.match(declaration, /points\.js/);
  assert.match(declaration, /workspace\.js/);
  assert.match(declaration, /transport\.js/);
  assert.match(declaration, /data-sources\.js/);
  assert.match(declaration, /api-errors\.js/);
  assert.match(declaration, /job-errors\.js/);
  assert.match(declaration, /onCleanup\?: CleanupRegistration/);
  const cleanupDeclaration = await readFile(join(packageRoot, 'lib/cleanup.d.ts'), 'utf8');
  assert.match(cleanupDeclaration, /readonly deadline: number/);
  assert.match(cleanupDeclaration, /Pick<PluginTransport, 'request'>/);
  assert.doesNotMatch(declaration, /\.ts['"]|\.\.\/src|[A-Z]:\\/);
  const dataDeclaration = await readFile(join(packageRoot, 'lib/data-sources.d.ts'), 'utf8');
  assert.match(dataDeclaration, /persistence\?:\s*'memory'\s*\|\s*'persistent'/);
  const workspaceDeclaration = await readFile(join(packageRoot, 'lib/workspace.d.ts'), 'utf8');
  assert.match(workspaceDeclaration, /mount\?:\s*\(instanceId: string, target: HTMLElement, signal: AbortSignal\)\s*=>\s*Promise<Dispose>/);
  assert.match(workspaceDeclaration, /updatePage\?:\s*\(pageId: string, changes: WorkspacePageUpdate\)\s*=>\s*void/);
  const pointsDeclaration = await readFile(join(packageRoot, 'lib/points.d.ts'), 'utf8');
  assert.match(pointsDeclaration, /selection\?:\s*\(point: PointRef\)\s*=>\s*string \| null/);
  const uiDeclaration = await readFile(join(packageRoot, 'lib/ui.d.ts'), 'utf8');
  assert.match(uiDeclaration, /usePortalContentRef\?:\s*<Element extends HTMLElement>/);
  const tar = gunzipSync(await readFile(archive));
  const names: string[] = [];
  for await (const entry of extract()([tar])) {
    names.push(entry.header.name);
    for await (const _chunk of entry.body) { /* 顺序读完归档条目。 */ }
  }
  assert.ok(names.includes('package/lib/json.js'));
  assert.ok(names.includes('package/lib/json.d.ts'));
  assert.ok(names.includes('package/lib/api-errors.js'));
  assert.ok(names.includes('package/lib/job-errors.d.ts'));
  assert.equal(names.some((name) => /node_modules|\/src\/|\.tsx?$/.test(name) && !name.endsWith('.d.ts')), false);
});

test('脱离宿主源码的临时插件工程可严格消费所有新契约，错误使用被类型系统拒绝', async () => {
  const file = join(temporary, 'consumer/index.ts');
  await writeFile(join(temporary, 'consumer/package.json'), '{"type":"module"}', 'utf8');
  await writeFile(file, [
    'import type { HostContext, WebPlugin, PointRef, PointAccess, UiAccess, PluginTransport, DataAccess, DataSourceDefinition, Dispose, CleanupContext, Job, HostUi } from "@deviceforge/plugin-sdk";',
    'import { ApiError, JobFailure, JobWaitFailure, readHostError } from "@deviceforge/plugin-sdk";',
    'import { isJsonValue } from "@deviceforge/plugin-sdk/json";',
    'const cause = new ApiError("network", "disconnected", "连接断开", null, "read-log");',
    'const job: Job = { id: "owned-job", operation: "sample.run", status: "failed", result: null, error: "任务失败" };',
    'const known: Job = new JobFailure(job, "submit-log", "result-log").job;',
    'const pending: Job = new JobWaitFailure(job, "submit-log", null, cause).job;',
    'const errorLog: string | null | undefined = readHostError(cause)?.logId;',
    'export function usePopupRef(ui: HostUi, ref: import("react").Ref<HTMLDivElement> | undefined) {',
    '  const owned: import("react").Ref<HTMLDivElement> | undefined = ui.usePortalContentRef?.(ref) ?? ref;',
    '  return owned;',
    '}',
    'const reference: PointRef = { id: "sample.tools", version: "1" };',
    'const source: DataSourceDefinition = { id: "sample.settings", version: "1", title: "配置", readOnly: true, applyPolicy: "immediate", persistence: "persistent", read: { id: "sample.read", version: "1" } };',
    'const consume = (context: HostContext): [PointAccess | undefined, UiAccess | undefined, PluginTransport | undefined, DataAccess | undefined] =>',
    '  [context.extensions?.points, context.ui, context.transport, context.data];',
    'export async function mountView(context: HostContext, target: HTMLElement, signal: AbortSignal): Promise<Dispose | null> {',
    '  const ui = context.ui; if (!ui?.mount) return null;',
    '  const release: Dispose = await ui.mount("sample.instance", target, signal); context.onDispose(release); return release;',
    '}',
    'export function trackRemoteResource(context: HostContext): Dispose | null {',
    '  if (!context.onCleanup) return null;',
    '  return context.onCleanup(async (cleanup: CleanupContext) => {',
    '    const deadline: number = cleanup.deadline; cleanup.signal.throwIfAborted();',
    '    if (deadline > 0 && cleanup.transport) await cleanup.transport.request({ path: "/api/v2/example/owned/release", method: "POST" }, cleanup.signal);',
    '  });',
    '}',
    'export const plugin: WebPlugin = { id: "sample", version: "1", apiVersion: 2, panels: [], async activate(context) {',
    '  consume(context); context.data?.register(source); if (isJsonValue(reference.id)) context.extensions?.points?.contribute({ id: "sample.item", point: reference, data: reference.id });',
    '  context.ui?.register({ pages: [{ id: "sample.page", title: "示例", route: "/new", navigation: { group: "工作台", order: 20, hidden: false }, operations: ["sample.run"], taskPolicy: "listed", mount: async () => () => {} }] });',
    '  context.ui?.updatePage?.("sample.page", { operations: ["sample.read"], taskPolicy: "listed" });',
    '  const intent: string | null | undefined = context.extensions?.points?.selection?.(reference);',
    '} };',
  ].join('\n'), 'utf8');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true,
    skipLibCheck: false, types: [], lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  };
  const valid = ts.createProgram([file], options);
  assert.deepEqual(ts.getPreEmitDiagnostics(valid).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
  assert.equal(valid.getSourceFiles().some((source) => source.fileName.startsWith(join(frontend, 'src'))), false);
  await writeFile(file, [
    'import { JobFailure } from "@deviceforge/plugin-sdk";',
    'import type { PointRef, JsonValue, WorkspacePageUpdate } from "@deviceforge/plugin-sdk";',
    'const invalid: PointRef = { id: "sample.tools", version: 1 };',
    'new JobFailure({ status: "failed" }, null, null);',
    'export function unverified(error: JobFailure) {',
    '  const result: JsonValue = error.job.result; return result;',
    '}',
    'const wrongPage: WorkspacePageUpdate = { route: "/other" };',
  ].join('\n'), 'utf8');
  const invalid = ts.createProgram([file], options);
  const invalidDiagnostics = ts.getPreEmitDiagnostics(invalid);
  assert.ok(invalidDiagnostics.some((item) => item.code === 2345), '任务错误必须带有真实任务身份');
  assert.ok(invalidDiagnostics.some((item) => item.code === 2322 && item.start !== undefined &&
    item.file?.getLineAndCharacterOfPosition(item.start).line === 5),
  '未经检查的历史任务结果不能被默认声明成 SDK JSON');
  assert.ok(invalidDiagnostics.some((item) => item.code === 2353 && item.start !== undefined &&
    item.file?.getLineAndCharacterOfPosition(item.start).line === 7), '页面原位元数据更新不能改写路由');
});

test('运行时只加载 SDK 辅助而不加载 React，JSON 子入口可直接执行', async () => {
  const sdk: unknown = await import(pathToFileURL(join(packageRoot, 'lib/index.js')).href);
  assert.ok(sdk && typeof sdk === 'object' && 'hostUi' in sdk && typeof sdk.hostUi === 'function');
  const hostUi = sdk.hostUi;
  assert.throws(() => hostUi(), /宿主未提供/);
  assert.ok('ApiError' in sdk && typeof sdk.ApiError === 'function');
  assert.ok('readHostError' in sdk && typeof sdk.readHostError === 'function');
  assert.ok('JobWaitFailure' in sdk && typeof sdk.JobWaitFailure === 'function');
  const failure: unknown = Reflect.construct(sdk.ApiError, ['http', 'conflict', '数据已变化', 409, 'owned-log']);
  assert.deepEqual(sdk.readHostError(failure), {
    kind: 'http', code: 'conflict', message: '数据已变化', status: 409, logId: 'owned-log', retryAfter: null,
  });
  const job = { id: 'owned-job', status: 'running', operation: 'sample.run', result: null, error: null };
  const wait: unknown = Reflect.construct(sdk.JobWaitFailure, [job, 'submit-log', null, failure]);
  assert.ok(wait instanceof Error && 'job' in wait && 'cause' in wait);
  assert.equal(wait.job, job);
  assert.equal(wait.cause, failure);
  const json: unknown = await import(pathToFileURL(join(packageRoot, 'lib/json.js')).href);
  assert.ok(json && typeof json === 'object' && 'isJsonValue' in json && typeof json.isJsonValue === 'function');
  assert.equal(json.isJsonValue({ title: '独立插件' }), true);
  assert.equal(json.isJsonValue({ run: () => {} }), false);
});
