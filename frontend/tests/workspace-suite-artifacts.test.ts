import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { extract } from 'it-tar';
import { unzipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { registerCompositionStartupImports } from './composition-startup-imports.ts';
import { success } from './fixtures.ts';
import type { HostContext, JsonValue, WebPlugin, WorkspaceLayout } from '../src/plugin-sdk/index.ts';
import type { BridgeCommand } from '../src/features/debugger/types/index.ts';
import type { DebuggerBridgePluginDto, DebuggerTargetDto } from '../src/services/api/index.ts';

const reportFile = process.env['DEVICEFORGE_WORKSPACE_SUITE_REPORT'];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function inside(root: string, path: string) {
  const part = relative(resolve(root), resolve(path));
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
async function json(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(object(value), '实际发行元数据必须是 JSON 对象');
  return value;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline)
    await new Promise<void>((accept) => setTimeout(accept, 5));
  assert.ok(predicate(), '实际归档的功能状态没有在有界等待内收敛');
}

/** 从最终 ZIP 读取发布清单与组件，不读取旁路 release.json、components 或 blobs。 */
async function releaseArchive(directory: string) {
  assert.ok((await lstat(directory)).isDirectory(), '报告必须指向已存在的 CLI 输出目录');
  const packed = await json(join(directory, 'pack-report.json'));
  assert.ok(typeof packed.archive === 'string' && typeof packed.sha256 === 'string' &&
    typeof packed.size === 'number' && typeof packed.revision === 'string');
  const archivePath = resolve(directory, packed.archive);
  assert.ok(inside(directory, archivePath), '最终 ZIP 必须属于实际 CLI 输出目录');
  const zip = await readFile(archivePath);
  assert.equal(zip.length, packed.size, '最终 ZIP 大小与打包报告一致');
  assert.equal(hash(zip), packed.sha256, '最终 ZIP 摘要与打包报告一致');
  assert.ok(zip.length <= 64 * 1024 * 1024);
  const zipNames = new Set<string>();
  let totalSize = 0;
  const files = unzipSync(zip, { filter(entry) {
    assert.ok(!entry.name.includes('\\') && !entry.name.includes('\0') && !entry.name.startsWith('/') &&
      entry.name.split('/').every((part) => part !== '.' && part !== '..' && part !== ''),
    '最终 ZIP 成员路径必须是包内普通相对路径');
    assert.ok(!zipNames.has(entry.name) && zipNames.size < 4096);
    zipNames.add(entry.name);
    totalSize += entry.originalSize;
    assert.ok(Number.isSafeInteger(entry.originalSize) && entry.originalSize >= 0 &&
      totalSize <= 64 * 1024 * 1024, '最终 ZIP 展开内容超过单元限额');
    return true;
  } });
  const releaseBytes = files['release.json'];
  assert.ok(releaseBytes, '最终 ZIP 必须真实包含 release.json');
  assert.equal(hash(releaseBytes), packed.revision);
  const release: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(releaseBytes));
  assert.ok(object(release));
  assert.equal(release.id, packed.id);
  assert.equal(release.version, packed.version);
  assert.equal(release.host_api_version, 2);
  assert.ok(release.format_version === 1 || release.format_version === 2);
  assert.equal(typeof release.id, 'string');
  assert.ok(Array.isArray(release.components));
  assert.equal(release.components.length, packed.components);
  for (const declaration of release.components) {
    assert.ok(object(declaration) && Array.isArray(declaration.variants));
    for (const resource of declaration.variants) {
      assert.ok(object(resource) && typeof resource.path === 'string' &&
        typeof resource.sha256 === 'string' && typeof resource.size === 'number');
      const content = files[resource.path];
      assert.ok(content, '最终 ZIP 必须包含其组件声明引用的真实 blob');
      assert.equal(content.length, resource.size);
      assert.equal(hash(content), resource.sha256);
    }
  }
  const components: readonly unknown[] = release.components;
  return { components, files };
}

async function componentArchive(directory: string, destination: string, kind: 'browser' | 'server') {
  const { components, files } = await releaseArchive(directory);
  const candidates = components.filter((item) => object(item) && item.kind === kind);
  assert.equal(candidates.length, 1, `每个示例应交付唯一 ${kind} 组件`);
  const component = candidates[0];
  assert.ok(object(component) && typeof component.id === 'string' && typeof component.version === 'string');
  assert.ok(Array.isArray(component.variants));
  const platform = kind === 'browser' ? 'any' : `${process.platform}-${process.arch}`;
  const matching: unknown[] = component.variants.filter((item: unknown) => object(item) && item.platform === platform);
  const variants: unknown[] = matching.length ? matching :
    component.variants.filter((item: unknown) => object(item) && item.platform === 'any');
  assert.equal(variants.length, 1);
  const variant = variants[0];
  assert.ok(object(variant) && variant.format === 'tgz' && typeof variant.path === 'string' &&
    typeof variant.sha256 === 'string' && typeof variant.size === 'number');
  const archive = files[variant.path];
  assert.ok(archive, '被运行的组件必须来自最终 ZIP 内部');
  assert.equal(archive.length, variant.size);
  assert.equal(hash(archive), variant.sha256);
  assert.ok(archive.length <= 32 * 1024 * 1024);
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 });
  const names = new Set<string>();
  await mkdir(destination);
  for await (const entry of extract()([tar])) {
    const name = entry.header.name;
    assert.ok(name.startsWith('package/') && !name.includes('\\') && !name.includes('\0'));
    assert.ok(name.split('/').every((part) => part !== '.' && part !== '..'));
    if (entry.header.type === 'directory') continue;
    assert.equal(entry.header.type, 'file', '组件不能包含链接或特殊成员');
    assert.ok(!names.has(name) && names.size < 4096, '组件成员重复或超过上限');
    names.add(name);
    const target = resolve(destination, name.slice('package/'.length));
    assert.ok(inside(destination, target));
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.body) chunks.push(chunk.subarray());
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.concat(chunks), { flag: 'wx' });
  }
  const metadata = await json(join(destination, 'package.json'));
  assert.equal(metadata.type, 'module');
  assert.equal(metadata.version, component.version);
  assert.ok(object(metadata.deviceforge) && metadata.deviceforge.kind === kind &&
    object(metadata.deviceforge.entrypoints) && object(metadata.deviceforge.entrypoints.any));
  const entrypoint = metadata.deviceforge.entrypoints.any;
  assert.ok(entrypoint.runtime === (kind === 'browser' ? 'browser' : 'node') && typeof entrypoint.path === 'string');
  const entry = resolve(destination, entrypoint.path);
  assert.ok(inside(destination, entry) && names.has(`package/${entrypoint.path}`),
    '必须使用归档实际声明且已收录的身份包装入口');
  return { id: component.id, version: component.version, entry, metadata, names };
}

async function browserArchive(directory: string, destination: string) {
  return componentArchive(directory, destination, 'browser');
}

async function protocolOne(entry: string, args: readonly string[], request: Readonly<Record<string, unknown>>) {
  const pending = promisify(execFile)(process.execPath, [entry, ...args], {
    cwd: dirname(entry), encoding: 'utf8', windowsHide: true,
    timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  });
  const child = pending.child;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => {
    child.once('close', (code, signal) => accept({ code, signal }));
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cutoff = new Promise<never>((_accept, reject) => {
    deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`实际服务器组件没有在有界窗口退出，PID=${child.pid ?? '未创建'}`));
    }, 6500);
  });
  try {
    assert.ok(child.stdin && typeof child.pid === 'number');
    const pid = child.pid;
    const text = JSON.stringify(request) + '\n';
    assert.ok(Buffer.byteLength(text) <= 512 * 1024);
    child.stdin.end(text);
    const [output, exit] = await Promise.race([Promise.all([pending, closed]), cutoff]);
    assert.equal(exit.code, 0, '协议业务失败通过响应报告，进程本身仍应正常关闭');
    assert.equal(exit.signal, null, '成功和非法输入单元都不应靠强杀结束');
    assert.equal(child.exitCode, 0);
    assert.equal(child.stdin.writableEnded, true, '每个进程只写一条请求并关闭 stdin');
    return { ...output, pid, ...exit };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      let reap: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_accept, reject) => {
          reap = setTimeout(() => reject(new Error(`无法确认测试子进程已回收，PID=${child.pid ?? '未创建'}`)), 1000);
        })]);
      } finally { clearTimeout(reap); }
    }
  }
}

interface ArtifactDebugReceipt {
  readonly commandId: string;
  readonly pluginId: string;
  readonly generation: string | null;
  readonly success: boolean;
  readonly response: Record<string, unknown>;
}

/** 只模拟HTTP对端队列；目录、附件及数据执行仍走原平台的 gateway/bridge/local。 */
function artifactDebuggerQueue() {
  const instanceId = 'workspace-suite-artifact-browser';
  const sessionId = 'workspace-suite-artifact-observer';
  const paths: string[] = [], completed: string[] = [];
  const commands: BridgeCommand[] = [];
  const receipts = new Map<string, ArtifactDebugReceipt>();
  const held: { id: string | null; release: (() => void) | null } = { id: null, release: null };
  let plugins: readonly DebuggerBridgePluginDto[] = [], selected: DebuggerTargetDto | null = null, sequence = 0;
  function receiveDirectory(value: unknown) {
    assert.ok(Array.isArray(value));
    plugins = value.map((item: unknown) => {
      assert.ok(object(item) && typeof item.plugin_id === 'string' && typeof item.generation === 'string' &&
        (item.version === null || typeof item.version === 'string'));
      return { plugin_id: item.plugin_id, generation: item.generation, version: item.version };
    });
  }
  function target(pluginId: string): DebuggerTargetDto {
    const plugin = plugins.find((entry) => entry.plugin_id === pluginId);
    assert.ok(plugin, '目标必须来自register/heartbeat实际上报的插件目录');
    return { target_kind: 'browser', instance_id: instanceId, ...plugin };
  }
  const status = () => ({ instance_id: instanceId, targets: plugins.map((plugin) => target(plugin.plugin_id)),
    active_sessions: selected ? [{ session_id: sessionId, target: selected, state: 'active', idle_ttl_ms: 60000 }] : [] });
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    paths.push(path);
    assert.ok(path.startsWith('/api/v2/debugger/bridge/'), '本单元不得发起调试控制之外的网络或业务请求');
    assert.equal(init?.method, 'POST');
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(object(body));
    if (path.endsWith('/register')) {
      receiveDirectory(body.plugins);
      return success({ instance_id: instanceId, plugins, active_sessions: 0, idle_ttl_ms: 60000 });
    }
    assert.equal(body.instance_id, instanceId);
    if (path.endsWith('/heartbeat')) {
      receiveDirectory(body.plugins);
      return success(status());
    }
    if (path.endsWith('/poll')) {
      assert.ok(typeof body.limit === 'number' && body.limit >= 1 && body.limit <= 4);
      return success({ ...status(), commands: commands.splice(0, body.limit) });
    }
    if (path.endsWith('/ack')) {
      assert.ok(typeof body.command_id === 'string' && typeof body.plugin_id === 'string' &&
        (body.generation === null || typeof body.generation === 'string') &&
        typeof body.success === 'boolean' && object(body.response));
      assert.ok(!receipts.has(body.command_id), '同一调试命令不能被自动重放');
      receipts.set(body.command_id, { commandId: body.command_id, pluginId: body.plugin_id,
        generation: body.generation, success: body.success, response: body.response });
      if (body.command_id === held.id) await new Promise<void>((accept, reject) => {
        const signal = init?.signal;
        const clear = () => { signal?.removeEventListener('abort', abort); held.release = null; };
        const abort = () => { clear(); reject(signal?.reason ?? new Error('调试ACK等待已撤销')); };
        held.release = () => { clear(); accept(); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      completed.push(body.command_id);
      return success({ command_id: body.command_id, session_id: sessionId,
        state: body.success ? 'succeeded' : 'failed', timeout_ms: 10000 });
    }
    if (path.endsWith('/disconnect')) return success({ disconnected: true });
    assert.fail('没有为此调试控制端点安排响应');
  };
  function enqueue(tool: BridgeCommand['tool'], parameters: JsonValue, selectedTarget: DebuggerTargetDto) {
    const id = `archive-debug-command-${++sequence}`;
    commands.push({ command_id: id, session_id: sessionId, target: selectedTarget, tool, parameters, remaining_ms: 10000 });
    return id;
  }
  async function receipt(id: string) {
    await until(() => completed.includes(id));
    const result = receipts.get(id);
    assert.ok(result);
    return result;
  }
  return { transport, paths, completed, receipts, target, enqueue, receipt,
    directory: () => plugins,
    select: (value: DebuggerTargetDto) => { selected = value; },
    hold: (id: string) => { held.id = id; },
    held: () => held.release !== null,
    release: () => { held.release?.(); },
    async command(tool: BridgeCommand['tool'], parameters: JsonValue, selectedTarget: DebuggerTargetDto) {
      return receipt(enqueue(tool, parameters, selectedTarget));
    },
  };
}

function successfulDebugReceipt(receipt: ArtifactDebugReceipt): Record<string, unknown> {
  assert.equal(receipt.success, true, JSON.stringify(receipt.response));
  return receipt.response;
}

function failedDebugReceipt(receipt: ArtifactDebugReceipt, code: string) {
  assert.equal(receipt.success, false);
  assert.ok(object(receipt.response.error));
  assert.equal(receipt.response.error.code, code);
}

test('实际配套最终ZIP内服务器组件按公开协议1执行成功与非法输入并有界退出',
  { skip: reportFile ? false : '未设置 DEVICEFORGE_WORKSPACE_SUITE_REPORT，不临时构建或使用源码替代归档',
    timeout: 25_000 }, async (t) => {
    assert.ok(reportFile);
    const reportPath = resolve(reportFile), report = await json(reportPath);
    assert.ok(typeof report.suiteDirectory === 'string');
    const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-workspace-suite-server-'));
    try {
      const destination = join(temporary, 'server');
      const server = await componentArchive(resolve(dirname(reportPath), report.suiteDirectory), destination, 'server');
      assert.equal(server.metadata.name, `deviceforge-plugin-${server.id}`);
      assert.ok(object(server.metadata.deviceforge) && typeof server.metadata.deviceforge.manifest === 'string');
      const manifestPath = server.metadata.deviceforge.manifest;
      const path = resolve(destination, manifestPath);
      assert.ok(inside(destination, path) && server.names.has(`package/${manifestPath}`),
        '服务器声明清单必须实际来自同一最终 ZIP 的 TGZ 成员');
      const manifest = await json(path);
      assert.equal(manifest.id, server.id);
      assert.equal(manifest.version, server.version);
      assert.equal(manifest.protocol_version, 1);
      assert.ok(Array.isArray(manifest.operations));
      const operations: readonly unknown[] = manifest.operations;
      assert.equal(operations.filter((operation) => object(operation) && operation.name === 'normalize').length, 1);
      assert.ok(Array.isArray(manifest.args));
      const declaredArgs: readonly unknown[] = manifest.args;
      const args: string[] = [];
      for (const argument of declaredArgs) {
        assert.ok(typeof argument === 'string');
        args.push(argument);
      }
      const cases = [
        { name: 'success', input: { message: '  cafe\u0301\n\t归档   消息  ' }, success: true },
        { name: 'invalid-type', input: { message: 7 }, success: false },
        { name: 'invalid-extra', input: { message: '合法内容', unexpected: true }, success: false },
      ];
      for (const current of cases) {
        const requestId = `${server.id}.archive.${current.name}`;
        const result = await protocolOne(server.entry, args, {
          protocol_version: 1, request_id: requestId, operation: 'normalize', input: current.input,
        });
        const lines = result.stdout.trim().split(/\r?\n/);
        assert.equal(lines.length, 1, 'stdout 只允许本次请求的一条协议响应');
        assert.equal(result.stderr, '', '普通输入校验失败不能向协议输出混入日志或额外诊断');
        const response: unknown = JSON.parse(result.stdout);
        assert.ok(object(response));
        assert.equal(response.protocol_version, 1);
        assert.equal(response.request_id, requestId);
        if (current.success) {
          assert.deepEqual(response.result, { message: 'café 归档 消息' });
          assert.equal(response.error, undefined);
        } else {
          assert.ok(typeof response.error === 'string' && response.error.trim());
          assert.equal(response.result, undefined, '非法输入不能同时报告业务成功');
        }
        t.diagnostic(`${current.name}：PID=${result.pid}，一条请求+EOF，close=0，无强杀`);
      }
    } finally {
      const checked = await realpath(temporary);
      assert.ok(inside(await realpath(tmpdir()), checked), '只回收本单元在临时目录创建的独占解包目录');
      await rm(checked, { recursive: true, force: true });
    }
  });

test('实际配套最终ZIP经纯平台调试桥发现统一源并验证修订冲突及代次隔离',
  { skip: reportFile ? false : '未设置 DEVICEFORGE_WORKSPACE_SUITE_REPORT，不临时构建或使用源码替代归档',
    timeout: 25_000 }, async () => {
    assert.ok(reportFile);
    const reportPath = resolve(reportFile), report = await json(reportPath);
    assert.ok(typeof report.suiteDirectory === 'string');
    const parser = registerCompositionStartupImports();
    const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const temporary = await mkdtemp(join(artifacts, '.workspace-suite-debugger-'));
    const browser = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const originals = new Map(['self', 'document'].map((name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: browser.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.window.document });
    const queue = artifactDebuggerQueue();
    try {
      assert.deepEqual(parser.diagnostics, []);
      const suite = await browserArchive(resolve(dirname(reportPath), report.suiteDirectory), join(temporary, 'suite'));
      const { readPluginModule } = await import('../src/plugins/contracts.ts');
      const { createPlatformRuntime } = await import('../src/app/platform-runtime.ts');
      const plugin = readPluginModule(await import(pathToFileURL(suite.entry).href));
      assert.equal(plugin.id, suite.id);
      assert.equal(plugin.version, suite.version);
      const runtime = createPlatformRuntime({
        baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
        debugger: { document: browser.window.document }, transport: queue.transport,
      });
      try {
        runtime.bundledPlugins.register({ id: suite.id, trusted: true, plugin });
        const first = await runtime.webPlugins.load(suite.id);
        assert.equal(queue.paths.length, 0, '装载归档和登记调试附件不得自动联网');
        const host = required(runtime.host), signal = runtime.host.signal;
        const publicSources = host.data.catalog().filter((entry) => entry.provider.pluginId === suite.id);
        assert.equal(publicSources.length, 1, '目录数据源必须由实际suite归档登记，不另造等价源');
        const publicSource = publicSources[0];
        assert.ok(publicSource);
        const sourceRef = { id: publicSource.id, version: publicSource.version };
        const debuggerRuntime = runtime.debugger;
        assert.ok(debuggerRuntime);
        await debuggerRuntime.start();
        assert.equal(debuggerRuntime.snapshot().state, 'connected');
        const target = queue.target(suite.id);
        assert.equal(target.generation, String(first.generation));
        assert.equal(target.version, suite.version);
        queue.select(target);

        const inspected = successfulDebugReceipt(await queue.command('inspect', {}, target));
        assert.deepEqual(inspected.target, { plugin_id: suite.id, generation: target.generation });
        assert.ok(object(inspected.catalog) && object(inspected.catalog.workspace));
        const pages = inspected.catalog.workspace.pages;
        assert.ok(Array.isArray(pages) && pages.some((page: unknown) => object(page) &&
          page.pluginId === suite.id && page.route === '/workspace-suite'));
        assert.ok(Array.isArray(inspected.catalog.data_sources));
        assert.equal(inspected.catalog.data_sources.length, 1);
        const sourceInfo = inspected.catalog.data_sources[0];
        assert.ok(object(sourceInfo));
        assert.equal(sourceInfo.id, publicSource.id);
        assert.equal(sourceInfo.version, publicSource.version);
        assert.deepEqual(sourceInfo.provider, publicSource.provider);
        const catalog = successfulDebugReceipt(await queue.command('data_catalog', {}, target));
        assert.ok(Array.isArray(catalog.sources) && catalog.sources.length === 1);
        const source = catalog.sources[0];
        assert.ok(object(source) && typeof source.id === 'string');
        assert.equal(source.origin, 'public-data-source');
        assert.equal(source.persistence, 'memory');
        assert.equal(source.writable, true);
        assert.deepEqual(source.source_ref, sourceRef);
        assert.ok(object(inspected.capabilities));
        assert.equal(inspected.capabilities.data_read, true);
        assert.equal(inspected.capabilities.data_write, true);

        const initial = successfulDebugReceipt(await queue.command('data_read', { source_id: source.id }, target));
        assert.ok(typeof initial.revision === 'string');
        assert.deepEqual(initial.value, { message: '' });
        const saved = successfulDebugReceipt(await queue.command('data_write', {
          source_id: source.id, expected_revision: initial.revision,
          value: { message: '来自真实归档的调试修改' }, confirmed: true,
        }, target));
        assert.ok(typeof saved.revision === 'string');
        assert.notEqual(saved.revision, initial.revision);
        assert.deepEqual(saved.value, { message: '来自真实归档的调试修改' });
        assert.deepEqual((await host.data.read(sourceRef, signal)).data.value, saved.value);
        const draft = { message: '冲突时应保留的调试草稿' };
        failedDebugReceipt(await queue.command('data_write', { source_id: source.id,
          expected_revision: initial.revision, value: draft, confirmed: true }, target), 'debugger_revision_conflict');
        assert.deepEqual(draft, { message: '冲突时应保留的调试草稿' });
        assert.deepEqual((await host.data.read(sourceRef, signal)).data.value, saved.value);

        // 控制对端只延迟ACK，不改写真实插件的服务；旧结果身份必须在卸载换代后仍保持旧代。
        const delayed = queue.enqueue('data_read', { source_id: source.id }, target);
        queue.hold(delayed);
        await until(queue.held);
        const oldReceipt = queue.receipts.get(delayed);
        assert.ok(oldReceipt);
        assert.deepEqual(successfulDebugReceipt(oldReceipt).value, saved.value);
        assert.equal(oldReceipt.generation, target.generation);
        await runtime.webPlugins.unload(suite.id);
        assert.equal(host.data.catalog().some((entry) => entry.provider.pluginId === suite.id), false);
        failedDebugReceipt(await queue.command('data_read', { source_id: source.id }, target), 'debugger_target_unavailable');
        const second = await runtime.webPlugins.load(suite.id);
        assert.notEqual(second.generation, first.generation);
        await until(() => queue.directory().some((entry) => entry.plugin_id === suite.id &&
          entry.generation === String(second.generation)));
        const next = queue.target(suite.id);
        queue.select(next);
        failedDebugReceipt(await queue.command('data_read', { source_id: source.id }, target), 'debugger_stale_generation');
        const nextCatalog = successfulDebugReceipt(await queue.command('data_catalog', {}, next));
        assert.ok(Array.isArray(nextCatalog.sources) && nextCatalog.sources.length === 1);
        const nextSource = nextCatalog.sources[0];
        assert.ok(object(nextSource) && typeof nextSource.id === 'string');
        assert.notEqual(nextSource.id, source.id, '新附件不得复用旧调试数据源标识');
        assert.deepEqual(nextSource.source_ref, sourceRef);
        failedDebugReceipt(await queue.command('data_read', { source_id: source.id }, next), 'debugger_data_source_unavailable');
        const fresh = successfulDebugReceipt(await queue.command('data_read', { source_id: nextSource.id }, next));
        assert.ok(typeof fresh.revision === 'string');
        assert.deepEqual(fresh.value, { message: '' });
        failedDebugReceipt(await queue.command('data_write', { source_id: nextSource.id,
          expected_revision: saved.revision, value: { message: '不能带入新代的旧草稿' }, confirmed: true }, next),
        'debugger_revision_conflict');
        const freshSaved = successfulDebugReceipt(await queue.command('data_write', {
          source_id: nextSource.id, expected_revision: fresh.revision,
          value: { message: '新代独立保存' }, confirmed: true,
        }, next));
        queue.release();
        await queue.receipt(delayed);
        assert.equal(queue.receipts.get(delayed), oldReceipt);
        assert.equal(oldReceipt.generation, target.generation);
        const latest = successfulDebugReceipt(await queue.command('data_read', { source_id: nextSource.id }, next));
        assert.deepEqual(latest.value, freshSaved.value, '晚到旧代ACK不得覆盖新代已保存值');
        assert.equal(latest.revision, freshSaved.revision);
        assert.equal(debuggerRuntime.snapshot().unconfirmedReceipts, 0);
        assert.equal(debuggerRuntime.snapshot().state, 'connected');
      } finally { queue.release(); await runtime.dispose(); }
      assert.ok(queue.paths.includes('/api/v2/debugger/bridge/disconnect'));
    } finally {
      queue.release();
      browser.window.close();
      for (const [name, original] of originals) {
        if (original) Object.defineProperty(globalThis, name, original);
        else Reflect.deleteProperty(globalThis, name);
      }
      parser.dispose();
      const checked = await realpath(temporary);
      assert.ok(inside(await realpath(artifacts), checked));
      await rm(checked, { recursive: true, force: true });
    }
  });

function workspaceFixture(): WebPlugin {
  const id = 'archive_workspace_fixture';
  return {
    id, version: '1', apiVersion: 2, panels: [],
    async activate(context) {
      const ui = context.ui;
      assert.ok(ui);
      ui.register({
        pages: ['devices', 'files'].map((page) => ({
          id: `${id}.${page}.page`, title: page, route: `/${page}`, workspaceId: `${id}.${page}.workspace`,
        })),
        workspaces: ['devices', 'files'].map((page) => ({
          id: `${id}.${page}.workspace`, title: page,
        })),
        views: [{ id: `${id}.original`, title: '原工作区视图',
          mount: async () => { throw new Error('本单元禁止挂载业务或夹具 UI'); } }],
      });
      for (const page of ['devices', 'files']) {
        const workspaceId = `${id}.${page}.workspace`;
        for (const suffix of ['main', 'float', 'overlay']) ui.open({
          instanceId: `${id}.${page}.${suffix}`, workspaceId,
          provider: { pluginId: id, viewId: `${id}.original` },
        });
        ui.writeLayout(workspaceId, {
          version: 1, root: { kind: 'view', instanceId: `${id}.${page}.main` },
          floating: [{ instanceId: `${id}.${page}.float`, x: 10, y: 20, width: 200, height: 140, z: 1 }],
          overlays: [{ instanceId: `${id}.${page}.overlay`, relativeTo: `${id}.${page}.main`,
            x: 20, y: 30, width: 160, height: 100, z: 2 }],
        });
      }
    },
  };
}

function required(host: HostContext) {
  assert.ok(host.ui && host.data && host.services && host.extensions?.points);
  return { ui: host.ui, data: host.data, services: host.services, extensions: host.extensions,
    points: host.extensions.points };
}

test('实际配套归档经纯平台 runtime 装卸并组合公开工作区，不挂业务 UI 或访问服务器',
  { skip: reportFile ? false : '未设置 DEVICEFORGE_WORKSPACE_SUITE_REPORT，不临时构建或使用源码替代归档',
    timeout: 20_000 }, async (t) => {
    assert.ok(reportFile);
    const reportPath = resolve(reportFile), report = await json(reportPath);
    assert.ok(typeof report.suiteDirectory === 'string' && typeof report.contributorDirectory === 'string',
      '报告需要 suiteDirectory 和 contributorDirectory 两个实际 CLI 输出目录');
    const parser = registerCompositionStartupImports();
    const artifacts = fileURLToPath(new URL('../artifacts/', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const temporary = await mkdtemp(join(artifacts, '.workspace-suite-artifacts-'));
    const browser = new JSDOM('<!doctype html><html><head></head><body></body></html>');
    const originals = new Map(['self', 'document'].map((name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperty(globalThis, 'self', { configurable: true, writable: true, value: browser.window });
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.window.document });
    try {
      assert.deepEqual(parser.diagnostics, [], '真实宿主公开包解析必须有效');
      const suite = await browserArchive(resolve(dirname(reportPath), report.suiteDirectory), join(temporary, 'suite'));
      const contributor = await browserArchive(resolve(dirname(reportPath), report.contributorDirectory),
        join(temporary, 'contributor'));
      assert.notEqual(suite.id, contributor.id);
      const { readPluginModule } = await import('../src/plugins/contracts.ts');
      const { createPlatformRuntime } = await import('../src/app/platform-runtime.ts');
      const { readHostError } = await import('../src/plugin-sdk/index.ts');
      const suitePlugin = readPluginModule(await import(pathToFileURL(suite.entry).href));
      const contributorPlugin = readPluginModule(await import(pathToFileURL(contributor.entry).href));
      assert.equal(suitePlugin.id, suite.id);
      assert.equal(suitePlugin.version, suite.version);
      assert.equal(contributorPlugin.id, contributor.id);
      assert.equal(contributorPlugin.version, contributor.version);
      let requests = 0;
      const runtime = createPlatformRuntime({
        baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
        transport: async () => { requests++; throw new Error('实际归档单元禁止网络和业务请求'); },
      });
      try {
        const access = required(runtime.host), signal = runtime.host.signal;
        const point = { id: `${suite.id}.tools`, version: '1' };
        const readCommand = `${contributor.id}.read-provider`, statusCommand = `${contributor.id}.status`;
        const invokeStatus = async () => {
          const result = await access.extensions.executeCommand(statusCommand, {}, signal);
          assert.ok(object(result.data));
          return result.data;
        };
        const currentContribution = () => access.points.list(point).find((entry) =>
          entry.provider.pluginId === contributor.id);
        for (const plugin of [workspaceFixture(), contributorPlugin, suitePlugin])
          runtime.bundledPlugins.register({ id: plugin.id, trusted: true, plugin });
        await runtime.webPlugins.load('archive_workspace_fixture');
        const baseline = new Map<string, WorkspaceLayout>();
        for (const page of ['devices', 'files']) {
          const workspaceId = `archive_workspace_fixture.${page}.workspace`;
          const layout = access.ui.readLayout(workspaceId);
          assert.ok(layout);
          baseline.set(workspaceId, structuredClone(layout));
        }
        let oldRevision = '', oldGeneration = 0;
        let dataRef: { id: string; version: string } | null = null;

        await t.test('先装贡献者只进入等待，独立状态命令可用且不伪报业务成功', async () => {
          await runtime.webPlugins.load(contributor.id);
          await until(() => currentContribution()?.state === 'waiting');
          assert.equal(currentContribution()?.reason, 'point_missing');
          assert.equal((await invokeStatus()).active, false);
          assert.equal(access.extensions.catalog().commands.some((entry) => entry.id === readCommand), false);
          assert.equal(access.ui.catalog().pages.some((entry) => entry.pluginId === suite.id), false);
          assert.equal(requests, 0);
        });

        await t.test('提供者归档激活后公开页面、服务和数据真实可用，原工作区不被自动改写', async () => {
          await runtime.webPlugins.load(suite.id);
          await until(() => currentContribution()?.state === 'active' &&
            access.extensions.catalog().commands.some((entry) => entry.id === readCommand));
          assert.equal((await invokeStatus()).active, true);
          const pages = access.ui.catalog().pages;
          assert.equal(pages.filter((entry) => entry.route === '/workspace-suite' && entry.pluginId === suite.id).length, 1);
          assert.equal(new Set(pages.map((entry) => entry.route)).size, pages.length);
          const services = access.services.catalog().filter((entry) => entry.provider.id === suite.id && entry.available);
          assert.deepEqual(services.map((entry) => entry.service.id).sort(),
            [`${suite.id}.message.read`, `${suite.id}.message.write`, `${suite.id}.normalize`].sort());
          const sources = access.data.catalog().filter((entry) => entry.provider.pluginId === suite.id);
          assert.equal(sources.length, 1);
          const source = sources[0];
          assert.ok(source);
          assert.equal(source.persistence, 'memory');
          assert.equal(source.readOnly, false);
          dataRef = { id: source.id, version: source.version };
          oldGeneration = source.provider.generation;
          for (const [workspaceId, layout] of baseline)
            assert.deepEqual(access.ui.readLayout(workspaceId), layout);
          assert.equal(requests, 0);
        });

        await t.test('实际数据源按不透明修订写入，冲突不丢草稿或覆盖已保存值', async () => {
          assert.ok(dataRef);
          const initial = await access.data.read(dataRef, signal);
          assert.deepEqual(initial.data.value, { message: '' });
          const saved = await access.data.write(dataRef,
            { value: { message: '实际归档保存' }, expectedRevision: initial.data.revision }, signal);
          const draft = { message: '冲突时保留的编辑草稿' };
          await assert.rejects(access.data.write(dataRef,
            { value: draft, expectedRevision: initial.data.revision }, signal),
          (error: unknown) => readHostError(error)?.code === 'data_source_conflict');
          assert.deepEqual(draft, { message: '冲突时保留的编辑草稿' });
          assert.deepEqual((await access.data.read(dataRef, signal)).data, saved.data);
          oldRevision = saved.data.revision;
        });

        const attached = new Map<string, WorkspaceLayout>();
        await t.test('显式向设备与文件工作区追加自有实例，保留原根、浮窗、覆盖层和目标', async () => {
          for (const page of ['devices', 'files']) {
            const workspaceId = `archive_workspace_fixture.${page}.workspace`;
            const instanceId = `${suite.id}.artifact.${page}`;
            const target = page === 'devices' ? {
              kind: 'device', reference: {
                providerId: 'archive_fixture_provider', generation: 'fixture-device-generation', localId: 'chosen-device',
              },
            } : { directory: 'explicit-file-target' };
            await access.extensions.executeCommand(`${suite.id}.attach`, { workspaceId, instanceId, target }, signal);
            const original = baseline.get(workspaceId), layout = access.ui.readLayout(workspaceId);
            assert.ok(original && layout);
            assert.equal(layout.root?.kind, 'tabs');
            if (layout.root?.kind !== 'tabs') throw new Error('追加后没有保留页签布局');
            assert.deepEqual(layout.root.items[0]?.node, original.root);
            assert.deepEqual(layout.root.items[1]?.node, { kind: 'view', instanceId });
            assert.deepEqual(layout.floating, original.floating);
            assert.deepEqual(layout.overlays, original.overlays);
            const instance = access.ui.snapshot().instances.find((entry) => entry.instanceId === instanceId);
            assert.ok(instance);
            assert.equal(instance.pluginId, suite.id);
            assert.deepEqual(instance.target, target);
            assert.deepEqual(instance.provider, { pluginId: suite.id, viewId: `${suite.id}.main` });
            attached.set(workspaceId, structuredClone(layout));
          }
          assert.equal(access.ui.snapshot().instances.some((entry) => entry.instanceId.includes('.delegate.')), false,
            '登记和追加不应暗中挂载文件视图');
          assert.equal(requests, 0);
        });

        await t.test('卸载撤销相关命令并保留贡献者根状态与布局，重载隔离旧调用和修订', async () => {
          assert.ok(dataRef && oldRevision);
          const oldRead = access.extensions.executeCommand(readCommand, {}, signal);
          const rejected = assert.rejects(oldRead,
            (error: unknown) => readHostError(error)?.kind === 'cancelled');
          await runtime.webPlugins.unload(suite.id);
          await rejected;
          await until(() => currentContribution()?.state === 'waiting');
          assert.equal(access.extensions.catalog().commands.some((entry) => entry.id === readCommand), false);
          assert.equal((await invokeStatus()).active, false);
          assert.equal((await invokeStatus()).completedReads, 0);
          assert.equal(access.ui.catalog().pages.some((entry) => entry.pluginId === suite.id), false);
          assert.equal(access.data.catalog().some((entry) => entry.provider.pluginId === suite.id), false);
          for (const [workspaceId, layout] of attached) {
            assert.deepEqual(access.ui.readLayout(workspaceId), layout);
            const instanceId = `${suite.id}.artifact.${workspaceId.includes('.devices.') ? 'devices' : 'files'}`;
            assert.equal(access.ui.snapshot().instances.find((entry) => entry.instanceId === instanceId)?.reason,
              'owner_inactive');
          }
          await runtime.webPlugins.load(suite.id);
          await until(() => currentContribution()?.state === 'active' &&
            access.extensions.catalog().commands.some((entry) => entry.id === readCommand));
          const source = access.data.catalog().find((entry) => entry.id === dataRef?.id);
          assert.ok(source && source.provider.generation > oldGeneration);
          const fresh = await access.data.read(dataRef, signal);
          assert.deepEqual(fresh.data.value, { message: '' });
          assert.notEqual(fresh.data.revision, oldRevision);
          await assert.rejects(access.data.write(dataRef,
            { value: { message: '不应写入的新代旧值' }, expectedRevision: oldRevision }, signal),
          (error: unknown) => readHostError(error)?.code === 'data_source_conflict');
          const current = await access.extensions.executeCommand(readCommand, {}, signal);
          assert.deepEqual(current.data, fresh.data);
          await new Promise<void>((accept) => setImmediate(accept));
          assert.equal((await invokeStatus()).active, true);
          assert.equal((await invokeStatus()).completedReads, 1,
            '旧调用不能在重载后增加新功能完成计数');
          for (const [workspaceId, layout] of attached)
            assert.deepEqual(access.ui.readLayout(workspaceId), layout);
          assert.equal(requests, 0);
        });
        await t.test('最终归档的替换命令按真实实例选择与恢复，不把选择成功当挂载成功', async () => {
          const instanceId = `${suite.id}.main.default`;
          const instance = access.ui.snapshot().instances.find((entry) => entry.instanceId === instanceId);
          const alternate = access.ui.catalog().views.find((entry) => entry.id === 'archive_workspace_fixture.original');
          assert.ok(instance && alternate);
          const original = { ownerPluginId: instance.pluginId, generation: instance.generation,
            provider: instance.provider ? { ...instance.provider } : null,
            providerGeneration: instance.providerGeneration, target: instance.target };
          const replaced = await access.extensions.executeCommand(`${suite.id}.replace-view`, {
            instanceId, workspaceId: instance.workspaceId, expected: original,
            provider: { pluginId: alternate.pluginId, viewId: alternate.id, generation: alternate.generation },
          }, signal);
          assert.ok(object(replaced.data) && typeof replaced.data.replacementId === 'string' &&
            object(replaced.data.current));
          assert.equal(replaced.data.status, 'selected');
          assert.equal(replaced.data.mount, 'not_observed');
          assert.deepEqual(access.ui.snapshot().instances.find((entry) => entry.instanceId === instanceId)?.provider,
            { pluginId: alternate.pluginId, viewId: alternate.id });
          const restore = { instanceId, workspaceId: instance.workspaceId,
            replacementId: replaced.data.replacementId, expected: replaced.data.current };
          const restored = await access.extensions.executeCommand(`${suite.id}.restore-view`, restore, signal);
          assert.ok(object(restored.data));
          assert.equal(restored.data.status, 'restored');
          assert.equal(restored.data.mount, 'not_observed');
          const current = access.ui.snapshot().instances.find((entry) => entry.instanceId === instanceId);
          assert.deepEqual(current?.provider, original.provider);
          assert.deepEqual(current?.target, original.target);
          await assert.rejects(access.extensions.executeCommand(`${suite.id}.restore-view`, restore, signal),
            (error: unknown) => readHostError(error)?.code === 'example_replacement_conflict');
        });
        assert.ok(runtime.webPlugins.snapshot().every((entry) => entry.state === 'loaded'));
        assert.equal(requests, 0);
        assert.equal(browser.window.document.head.querySelectorAll('style,link').length, 0);
      } finally { await runtime.dispose(); }
    } finally {
      browser.window.close();
      for (const [name, original] of originals) {
        if (original) Object.defineProperty(globalThis, name, original);
        else Reflect.deleteProperty(globalThis, name);
      }
      parser.dispose();
      const checked = await realpath(temporary);
      assert.ok(inside(await realpath(artifacts), checked), '只回收本单元在 artifacts 下创建的独占暂存');
      await rm(checked, { recursive: true, force: true });
    }
  });
