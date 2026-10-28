import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { runDebuggerInstallationAcceptance } from '../scripts/debugger-installation-acceptance.ts';
import type { DebuggerInstallationAcceptancePorts } from '../scripts/debugger-installation-acceptance.ts';
import { debuggerObject as object, debuggerRecords as records, debuggerText as text } from '../scripts/debugger-fixture-contract.ts';

const suiteId = 'demo-debugger-suite';
const serverId = 'demo_debugger_server';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => object(JSON.parse(strFromU8(bytes)));
interface ApiCall { path: string; method: string; body: Uint8Array | Record<string, unknown> | undefined; media: string | undefined; }
interface McpCall { name: string; input: Record<string, unknown>; }
interface Hooks {
  submit?(name: string, input: Record<string, unknown>): unknown | Promise<unknown>;
  poll?(job: Record<string, unknown>, count: number): unknown | Promise<unknown>;
  read?(path: string, value: unknown, writes: number): unknown;
}

function fixture(hooks: Hooks = {}) {
  const apiCalls: ApiCall[] = [];
  const mcpCalls: McpCall[] = [];
  const artifacts = new Map<string, Uint8Array>();
  const jobs = new Map<string, { operation: string; input: Record<string, unknown>; polls: number;
    terminal: Record<string, unknown> | null }>();
  const state: { current: Record<string, unknown> | null; generation: string | null; sequence: number } = {
    current: null, generation: null, sequence: 0,
  };
  const clone = (value: unknown): unknown => structuredClone(value);

  function install(source: unknown, previous: Record<string, unknown> | null) {
    const input = object(source);
    assert.deepEqual(Object.keys(input).sort(), ['artifact_id', 'kind']);
    assert.equal(input['kind'], 'offline');
    const bytes = artifacts.get(text(input['artifact_id']));
    assert.ok(bytes);
    const files = unzipSync(bytes);
    const manifestBytes = files['release.json'];
    assert.ok(manifestBytes);
    const manifest = decode(manifestBytes);
    const revision = hash(manifestBytes);
    const components = records(manifest['components']).map((component) => {
      const variant = records(component['variants'])[0];
      assert.ok(variant);
      const blob = files[text(variant['path'])];
      assert.ok(blob);
      if (variant['sha256'] !== hash(blob) || variant['size'] !== blob.byteLength)
        throw new Error('离线资源大小或 SHA-256 不匹配');
      const browser = component['kind'] === 'browser';
      return { id: component['id'], kind: component['kind'], version: component['version'], revision,
        entry_path: browser ? 'src/index.js' : 'entry.mjs',
        entry_url: browser ? `/api/v2/plugin-installations/browser/${String(component['id'])}/revisions/${revision}/assets/src/index.js` : null };
    });
    const enabled = previous?.['enabled'] === true;
    state.current = { id: manifest['id'], version: manifest['version'], name: manifest['name'],
      description: manifest['description'], revision, enabled, status: enabled ? 'enabled' : 'installed',
      installed_at: 100, components, tools: [], requirements: [] };
    state.generation = enabled ? `generation-${++state.sequence}` : null;
  }

  function execute(operation: string, input: Record<string, unknown>) {
    if (operation === 'installation.install') {
      assert.equal(state.current, null);
      assert.equal(input['expected_revision'], null);
      install(input['source'], null);
      return;
    }
    assert.equal(input['id'], suiteId);
    const current = state.current;
    assert.ok(current);
    if (input['expected_revision'] !== current['revision']) throw new Error('安装修订已变化');
    if (operation === 'installation.update') install(input['source'], current);
    else {
      assert.equal(operation, 'installation.enabled');
      assert.equal(typeof input['enabled'], 'boolean');
      current['enabled'] = input['enabled'];
      current['status'] = input['enabled'] === true ? 'enabled' : 'installed';
      state.generation = input['enabled'] === true ? `generation-${++state.sequence}` : null;
    }
  }

  const ports: DebuggerInstallationAcceptancePorts = {
    async api(path, method = 'GET', body, media) {
      apiCalls.push({ path, method, body, media });
      if (path.startsWith('/api/v2/plugin-installations/artifacts?')) {
        assert.equal(method, 'POST');
        assert.equal(media, 'application/octet-stream');
        assert.ok(body instanceof Uint8Array);
        assert.ok(new URL(path, 'http://127.0.0.1').searchParams.get('filename')?.endsWith('.zip'));
        const id = `artifact-${artifacts.size + 1}`;
        artifacts.set(id, body.slice());
        return { id };
      }
      assert.equal(method, 'GET', '除原上传外 HTTP 只能查询');
      if (path.startsWith('/api/v2/jobs/')) {
        const id = decodeURIComponent(path.slice('/api/v2/jobs/'.length));
        const pending = jobs.get(id);
        assert.ok(pending, '只允许查询已提交的同一原 Job');
        pending.polls++;
        if (pending.polls === 1) {
          const running = { id, operation: pending.operation, status: 'running' };
          return hooks.poll ? await hooks.poll(running, pending.polls) : running;
        }
        if (!pending.terminal) {
          try {
            execute(pending.operation, pending.input);
            pending.terminal = { id, operation: pending.operation, status: 'succeeded', result: clone(state.current), error: null };
          } catch (error) {
            pending.terminal = { id, operation: pending.operation, status: 'failed', result: null,
              error: error instanceof Error ? error.message : '受控变更失败' };
          }
        }
        return hooks.poll ? await hooks.poll(pending.terminal, pending.polls) : pending.terminal;
      }
      let value: unknown;
      if (path === '/api/v2/plugin-installations') value = state.current ? [clone(state.current)] : [];
      else if (path === `/api/v2/plugin-installations/${suiteId}`) { assert.ok(state.current); value = clone(state.current); }
      else if (path === '/api/v2/plugins') value = state.generation
        ? [{ id: serverId, version: '1.0.0', generation: state.generation, state: 'loaded' }] : [];
      else assert.fail(`不应调用其他 HTTP 入口：${path}`);
      return hooks.read ? hooks.read(path, value, mcpCalls.length) : value;
    },
    async mcp(name, input) {
      mcpCalls.push({ name, input });
      if (hooks.submit) return hooks.submit(name, input);
      const id = `job-${mcpCalls.length}`;
      jobs.set(id, { operation: name, input, polls: 0, terminal: null });
      return { id, operation: name, status: 'queued', result: null, error: null };
    },
  };
  return { ports, state, apiCalls, mcpCalls, artifacts, jobs };
}

test('原 HTTP 上传与 MCP 任务完成整套同版本更新、旧修订拒绝和坏摘要保留', async () => {
  const host = fixture();
  const result = await runDebuggerInstallationAcceptance(host.ports);
  assert.equal(result.suiteId, suiteId);
  assert.equal(result.report.production_acceptance_complete, false);
  assert.equal(result.report.initial.enabled, false);
  assert.equal(result.report.initial.serverGeneration, null);
  assert.equal(result.report.enabled.serverGeneration, 'generation-1');
  assert.equal(result.report.updated.serverGeneration, 'generation-2');
  assert.equal(result.report.updated.version, '1.0.0');
  assert.notEqual(result.report.initial.revision, result.report.updated.revision);
  assert.deepEqual(result.report.afterStaleRevision, result.report.updated);
  assert.deepEqual(result.report.afterInvalidDigest, result.report.updated);
  assert.deepEqual(host.mcpCalls.map((call) => call.name), [
    'installation.install', 'installation.enabled', 'installation.update', 'installation.enabled', 'installation.update',
  ]);
  assert.deepEqual(result.report.jobs.map((job) => [job.status, job.polls]), [
    ['succeeded', 2], ['succeeded', 2], ['succeeded', 2], ['failed', 2], ['failed', 2],
  ]);
  assert.deepEqual(host.mcpCalls.map((call) => call.input['expected_revision']), [
    null, result.report.initial.revision, result.report.initial.revision,
    result.report.initial.revision, result.report.updated.revision,
  ]);
  assert.equal(host.mcpCalls[3]?.input['enabled'], false);
  assert.equal(host.artifacts.size, 3);
  assert.equal(host.apiCalls.filter((call) => call.path.startsWith('/api/v2/jobs/')).length, 10);
  for (const evidence of result.report.uploads) {
    const bytes = host.artifacts.get(evidence.artifactId);
    assert.ok(bytes);
    assert.equal(evidence.sha256, hash(bytes));
    assert.equal(evidence.size, bytes.byteLength);
  }
});

test('真实独立包只在内存追加中文注释，保持服务器字节、所有版本和有效摘要', async () => {
  const host = fixture();
  await runDebuggerInstallationAcceptance(host.ports);
  function archive(id: string) {
    const bytes = host.artifacts.get(id); assert.ok(bytes);
    const files = unzipSync(bytes);
    const manifestBytes = files['release.json']; assert.ok(manifestBytes);
    const manifest = decode(manifestBytes);
    return { files, manifest, components: records(manifest['components']) };
  }
  const first = archive('artifact-1'), second = archive('artifact-2'), invalid = archive('artifact-3');
  for (const item of [first, second, invalid]) {
    assert.equal(item.manifest['version'], '1.0.0');
    for (const component of item.components) assert.equal(component['version'], '1.0.0');
  }
  for (const kind of ['server', 'browser']) {
    const oldComponent = first.components.find((item) => item['kind'] === kind);
    const newComponent = second.components.find((item) => item['kind'] === kind);
    assert.ok(oldComponent && newComponent);
    const before = records(oldComponent['variants'])[0], after = records(newComponent['variants'])[0];
    assert.ok(before && after);
    const oldBlob = first.files[text(before['path'])], newBlob = second.files[text(after['path'])];
    assert.ok(oldBlob && newBlob);
    assert.equal(after['sha256'], hash(newBlob));
    if (kind === 'server') { assert.deepEqual(oldBlob, newBlob); continue; }
    assert.notEqual(before['sha256'], after['sha256']);
    const oldFiles = unzipSync(oldBlob), newFiles = unzipSync(newBlob);
    assert.deepEqual(Object.keys(newFiles).sort(), Object.keys(oldFiles).sort());
    for (const path of Object.keys(oldFiles)) {
      const beforeBytes = oldFiles[path], afterBytes = newFiles[path]; assert.ok(beforeBytes && afterBytes);
      if (path === 'src/index.js') assert.equal(strFromU8(afterBytes), strFromU8(beforeBytes) +
        '\n// 独立整套导入验收：同版本更新仅追加这条中文注释。\n');
      else assert.deepEqual(afterBytes, beforeBytes);
    }
    const broken = invalid.components.find((item) => item['kind'] === 'browser'); assert.ok(broken);
    const brokenVariant = records(broken['variants'])[0]; assert.ok(brokenVariant);
    assert.equal(brokenVariant['sha256'], '0'.repeat(64));
    assert.deepEqual(invalid.files[text(brokenVariant['path'])], newBlob);
  }
});

test('已有同套或其他发布占有示例组件时零写入退出', async () => {
  for (const existing of [{ id: suiteId, components: [] }, { id: 'other-suite', components: [{ id: serverId }] }]) {
    const host = fixture({ read: (path, value) => path === '/api/v2/plugin-installations' ? [existing] : value });
    await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /停止以免覆盖/);
    assert.equal(host.artifacts.size, 0);
    assert.equal(host.mcpCalls.length, 0);
  }
});

test('上传传输异常不重新上传也不提交 MCP', async () => {
  const host = fixture();
  const api = host.ports.api;
  host.ports.api = async (path, method, body, media) => {
    if (method === 'POST') throw new Error('上传结果未知');
    return api(path, method, body, media);
  };
  await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /上传结果未知/);
  assert.equal(host.mcpCalls.length, 0);
});

test('MCP 结果丢失只派发一次，不将传输异常当作预期拒绝', async () => {
  const host = fixture({ submit: () => { throw new Error('提交结果未知'); } });
  await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /提交结果未知/);
  assert.equal(host.mcpCalls.length, 1);
  assert.equal(host.artifacts.size, 1);
  assert.equal(host.apiCalls.filter((call) => call.path.startsWith('/api/v2/jobs/')).length, 0);
});

test('端口必须返回解包 data，缺少原 Job 身份时不尝试猜测或重放', async () => {
  const host = fixture({ submit: () => ({ data: { id: 'hidden', operation: 'installation.install', status: 'queued' } }) });
  await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /非空字符串/);
  assert.equal(host.mcpCalls.length, 1);
  assert.equal(host.apiCalls.filter((call) => call.path.startsWith('/api/v2/jobs/')).length, 0);
});

for (const invalid of ['id', 'operation', 'status']) {
  test(`Job 的 ${invalid} 无效时停止且不更换 Job 或重放写入`, async () => {
    const host = fixture({ poll: (job) => ({ ...job, [invalid]: invalid === 'status' ? 'unknown' : 'another' }) });
    await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /轮询不得更换|原 Job 状态无效/);
    assert.equal(host.mcpCalls.length, 1);
    assert.equal(host.apiCalls.filter((call) => call.path.startsWith('/api/v2/jobs/')).length, 1);
  });
}

test('原 Job 查询失败只停止等待，不重新提交或取消任务', async () => {
  const host = fixture({ poll: () => { throw new Error('Job 查询传输失败'); } });
  await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /Job 查询传输失败/);
  assert.equal(host.mcpCalls.length, 1);
  assert.deepEqual(host.apiCalls.filter((call) => call.path.startsWith('/api/v2/jobs/')).map((call) => call.path), ['/api/v2/jobs/job-1']);
});

for (const phase of ['submit', 'poll']) {
  test(`${phase} 无响应在同一 8 秒预算内结束，不重放且不假定已取消`, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    let announce = () => {};
    const reached = new Promise<void>((resolve) => { announce = resolve; });
    const stalled = () => { announce(); return new Promise<unknown>(() => {}); };
    const host = fixture(phase === 'submit' ? { submit: stalled } : { poll: stalled });
    const rejected = assert.rejects(runDebuggerInstallationAcceptance(host.ports), /等待未确认，不得重放写操作/);
    await reached;
    context.mock.timers.tick(8000);
    await rejected;
    assert.equal(host.mcpCalls.length, 1);
    assert.equal(host.artifacts.size, 1);
    assert.equal(host.apiCalls.filter((call) => call.path.startsWith('/api/v2/jobs/')).length, phase === 'poll' ? 1 : 0);
  });
}

test('原 Job 的取消终态不能当作成功或明确拒绝', async () => {
  const host = fixture({ poll: (job) => ({ ...job, status: 'cancelled' }) });
  await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /未成功/);
  assert.equal(host.mcpCalls.length, 1);
});

test('整套更新丢失启用意图或组件跨套归属时检查失败', async () => {
  const disabled = fixture({ read: (path, value, writes) => writes === 3 && path.endsWith(`/${suiteId}`)
    ? { ...object(value), enabled: false, status: 'installed' } : value });
  await assert.rejects(runDebuggerInstallationAcceptance(disabled.ports), /整套持久启停意图不符/);
  assert.equal(disabled.mcpCalls.length, 3);
  const crossOwned = fixture({ read: (path, value, writes) => writes === 3 && path === '/api/v2/plugin-installations'
    ? [...records(value), { id: 'other-suite', components: [{ id: serverId }] }] : value });
  await assert.rejects(runDebuggerInstallationAcceptance(crossOwned.ports), /组件只能归属/);
  assert.equal(crossOwned.mcpCalls.length, 3);
});

test('旧 expected_revision 必须明确因修订冲突失败，不能只看状态未变化', async () => {
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const host = fixture({ poll: (job) => job['id'] === 'job-4'
      ? { ...job, status, error: '服务器临时不可用' } : job });
    await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /明确失败终态|失败原因必须对应/);
    assert.equal(host.mcpCalls.length, 4);
  }
});

test('坏摘要失败之后必须保留当前成功包和服务器运行代次', async () => {
  const host = fixture({ read: (path, value, writes) => writes === 5 && path === '/api/v2/plugins'
    ? records(value).map((plugin) => ({ ...plugin, generation: 'unexpected-generation' })) : value });
  await assert.rejects(runDebuggerInstallationAcceptance(host.ports), /坏摘要更新失败后必须保留/);
  assert.equal(host.mcpCalls.length, 5);
  assert.equal(host.artifacts.size, 3);
});
