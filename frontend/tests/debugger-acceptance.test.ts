import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { strFromU8, unzipSync } from 'fflate';
import { createDebuggerPackages, debuggerCompile, debuggerDigest, debuggerInside,
  debuggerPublicEntries, parseDebuggerFreeze, verifyDebuggerFreeze } from '../scripts/debugger-fixture.ts';
import { debuggerFixtureIds as ids, debuggerJson, debuggerLoopback, debuggerObject,
  DebuggerReceiptError, debuggerReceipt } from '../scripts/debugger-fixture-contract.ts';
import provider from '../scripts/debugger-fixture-provider.ts';
import consumer from '../scripts/debugger-fixture-consumer.ts';
import { createPluginManager } from '../src/plugins/manager.ts';
import { createExtensionRegistry } from '../src/plugins/extensions/registry.ts';
import { createNamedSlotAdapter } from '../src/plugins/extensions/slots.ts';
import { pageSlotId } from '../src/plugin-sdk/index.ts';
import { createLocalDebugger } from '../src/app/debugger-local/index.ts';
import type { LocalDebugger } from '../src/app/debugger-local/index.ts';
import type { HostContext, Job } from '../src/plugin-sdk/index.ts';

test('驱动仅接受显式冻结同一底座且文件变化可被发现', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-debugger-freeze-'));
  try {
    const bytes = Buffer.from('受控冻结字节');
    await writeFile(join(directory, 'host.exe'), bytes);
    await writeFile(join(directory, 'package.json'), bytes);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(directory, 'assets')); await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'plugin.json'), bytes);
    await writeFile(join(directory, 'dist/index.js'), bytes);
    await writeFile(join(directory, 'assets/debugger-browser-harness.js'), bytes);
    for (const path of Object.values(debuggerPublicEntries)) await writeFile(join(directory, path), bytes);
    const hash = debuggerDigest(bytes);
    const input = { confirmed: true, host: { path: join(directory, 'host.exe'), sha256: hash },
      frontend: { directory, files: ['assets/debugger-browser-harness.js', ...Object.values(debuggerPublicEntries)].map((path) => ({ path, sha256: hash })) },
      official: { directory, files: ['package.json', 'plugin.json', 'dist/index.js'].map((path) => ({ path, sha256: hash })) } };
    assert.throws(() => parseDebuggerFreeze({ ...input, confirmed: false }), /明确冻结/);
    assert.throws(() => parseDebuggerFreeze({ ...input, official: { directory, files: [] } }), /缺少/);
    assert.throws(() => parseDebuggerFreeze({ ...input, frontend: { directory, files: [{ path: '../escape.js', sha256: hash }] } }), /目录内/);
    const frozen = parseDebuggerFreeze(input); await verifyDebuggerFreeze(frozen);
    await writeFile(join(directory, 'dist/index.js'), '并行写入的新代');
    await assert.rejects(verifyDebuggerFreeze(frozen), /冻结输入变化/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('驱动拒绝用户服务、外部地址和越界回收，回执失败不变成成功', () => {
  for (const value of ['http://127.0.0.1:7031', 'http://127.0.0.1:5173', 'http://127.0.0.1:5186',
    'http://192.168.1.2:9000', 'https://127.0.0.1:9000', 'http://a:b@127.0.0.1:9000', 'http://127.0.0.1:9000/path']) {
    assert.throws(() => debuggerLoopback(value));
  }
  assert.equal(debuggerLoopback('http://127.0.0.1:39001').port, '39001');
  const parent = join(tmpdir(), 'debugger-run');
  assert.equal(debuggerInside(parent, join(parent, 'profile')), join(parent, 'profile'));
  assert.throws(() => debuggerInside(parent, parent));
  assert.throws(() => debuggerInside(parent, join(parent, '..', 'user-data')));
  assert.throws(() => debuggerReceipt({ command_id: 'one', state: 'timed_out_unconfirmed', response: null }), /未成功/);
  assert.throws(() => debuggerReceipt({ command_id: 'one', state: 'failed',
    response: { error: { code: 'debugger_stale_generation' } } }),
  (error: unknown) => error instanceof DebuggerReceiptError && error.code === 'debugger_stale_generation' && error.state === 'failed');
  assert.deepEqual(debuggerReceipt({ command_id: 'one', state: 'succeeded', response: { status: 'rejected' } }), { status: 'rejected' });
  assert.throws(() => debuggerJson({ value: undefined }));
});

test('两个独立浏览器包与更新包只含公开SDK转译产物且不执行安装脚本', async () => {
  const packages = await createDebuggerPackages();
  assert.equal(packages.length, 4);
  const browser = packages.filter((item) => item.kind === 'browser');
  assert.equal(browser.length, 3);
  const versions: string[] = [];
  for (const entry of browser) {
    const files = unzipSync(entry.bytes);
    assert.deepEqual(Object.keys(files).sort(), ['dist/index.js', 'package.json', 'plugin.json']);
    const descriptorBytes = files['package.json'], manifestBytes = files['plugin.json'], sourceBytes = files['dist/index.js'];
    assert.ok(descriptorBytes && manifestBytes && sourceBytes);
    const descriptor = debuggerObject(JSON.parse(strFromU8(descriptorBytes)));
    assert.equal(descriptor['scripts'], undefined);
    const manifest = debuggerObject(JSON.parse(strFromU8(manifestBytes)));
    assert.equal(manifest['id'], entry.id);
    const source = strFromU8(sourceBytes);
    assert.doesNotMatch(source, /frontend\/src|plugin-sdk|\bimport\s/);
    assert.match(source, /apiVersion: 2/);
    if (entry.id === ids.provider) {
      versions.push(String(manifest['version']));
      assert.ok(source.includes(`version: '${String(manifest['version'])}'`));
    }
  }
  assert.deepEqual(versions, ['1.0.0', '1.0.1']);
  assert.throws(() => debuggerCompile("import value from '../src/private.ts'; export default value;", 'bad.ts'), /运行时源码依赖/);
  const source = await readFile(new URL('../scripts/debugger-fixture-consumer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(debuggerCompile(source, 'consumer.ts'), /\bimport\s/);
});

test('独立消费服务保留原Job与日志，未选事件不采集，卸载停止资源与调用', async () => {
  const dom = new JSDOM('<main></main>');
  const parent = dom.window.document.querySelector('main'); assert.ok(parent);
  const lifetime = new AbortController(), extensions = createExtensionRegistry();
  const slotTarget = () => { const node = dom.window.document.createElement('section'); parent.append(node); return node; };
  const slots = await createNamedSlotAdapter([
    { id: 'debugger.fixture.append', target: slotTarget() },
    { id: 'debugger.fixture.replace', target: slotTarget() },
    { id: pageSlotId(ids.provider, '/debugger-fixture'), target: slotTarget() },
  ]);
  const jobs = new Map<string, Job>(), submissions: string[] = [];
  const host: HostContext = { apiVersion: 2, signal: lifetime.signal,
    onDispose: () => () => {}, listOperations: async () => ({ data: [], logId: null }),
    subscribeOperations: () => () => {},
    async submit(operation, input, signal) {
      signal.throwIfAborted(); assert.equal(operation, ids.operation); submissions.push(operation);
      const job: Job = { id: 'fixture-original-job', operation, status: 'succeeded', result: input, error: null };
      jobs.set(job.id, job); return { data: job, logId: 'fixture-original-log' };
    },
    async getJob(id) { const job = jobs.get(id); assert.ok(job); return { data: job, logId: 'fixture-query-log' }; },
    async cancelJob() { throw new Error('夹具不能取消设备任务'); },
  };
  let local: LocalDebugger | null = null;
  const manager = createPluginManager({ host, extensionRegistry: extensions, panelTarget: () => parent, slotAdapter: slots,
    debugForPlugin(id, generation, scope) { assert.ok(local); return local.attach(id, String(generation), scope); },
    observe(event) { local?.observe(event); },
  });
  local = createLocalDebugger({ document: dom.window.document, signal: lifetime.signal, extensions, manager: () => manager });
  try {
    manager.register({ id: provider.id, trusted: true, plugin: provider });
    manager.register({ id: consumer.id, trusted: true, plugin: consumer });
    const first = await manager.load(provider.id); await manager.load(consumer.id);
    await manager.mount(provider.id, `${provider.id}.panel`);
    for (const mode of ['append', 'replace']) await manager.mountComponent(`${provider.id}.${mode}`);
    await manager.mountModule(`${provider.id}.page`);
    await manager.mount(consumer.id, `${consumer.id}.panel`);
    const target = { plugin_id: provider.id, generation: String(first.generation) };
    await assert.rejects(local.execute('inspect', target, {}, lifetime.signal), /明确|显式/);
    local.select([target]);
    const inspected = debuggerObject(await local.execute('inspect', target, {}, lifetime.signal));
    const debug = debuggerObject(inspected['debug']);
    assert.deepEqual(debug['events'], []);
    assert.equal(inspected['registration_failures'], 0, '多个挂载根不能重复登记语义节点或资源');
    assert.ok(Array.isArray(inspected['roots']) && inspected['roots'].length === 4);
    assert.ok(Array.isArray(debug['resources']) && debug['resources'].length === 4);
    const response = await extensions.executeCommand(`${consumer.id}.consume`, { message: '纯回显', value: 42 }, lifetime.signal);
    assert.equal(response.logId, 'fixture-original-log');
    const data = debuggerObject(response.data), job = debuggerObject(data['job']);
    assert.equal(job['id'], 'fixture-original-job'); assert.equal(job['operation'], ids.operation);
    assert.equal(data['submission_log_id'], response.logId);
    assert.equal(submissions.length, 1);
    await manager.unload(provider.id);
    assert.equal(parent.querySelector('[aria-label="受控提供者"]'), null);
    await assert.rejects(extensions.executeCommand(`${consumer.id}.consume`, {}, lifetime.signal));
    assert.equal(submissions.length, 1, '提供者卸载后不能重新提交');
  } finally { local.dispose(); await manager.dispose(); extensions.dispose(); await slots.dispose(); dom.window.close(); }
});
