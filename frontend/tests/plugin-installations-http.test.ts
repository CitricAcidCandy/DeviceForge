import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { requestUrl, signal, success } from './fixtures.ts';
import type { HostContext } from '../src/plugin-sdk/index.ts';
import { release } from './plugin-installations-fixture.ts';

function installedDto(enabled = false, revision = 'a'.repeat(64)) {
  const value = release(enabled, '1.0.0', revision);
  return { id: value.id, name: value.name, description: value.description, version: value.version, revision: value.revision,
    enabled: value.enabled, status: value.status, installed_at: 1, tools: [], requirements: [], components: value.components.map((component) => ({
      id: component.id, kind: component.kind, version: component.version, revision, entry_path: component.entryPath, entry_url: component.entryUrl,
    })) };
}

test('HTTP 安装继承既有令牌、按冻结请求体等待任务并从不可变入口启动', async () => {
  let enabled = false;
  let tokenReads = 0;
  const requests: string[] = [];
  const imports: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    tokenProvider: () => { ++tokenReads; return 'test-only-token'; },
    esmImporter: async (url) => { imports.push(url); return { default: { id: 'example-browser', version: '1.0.0', apiVersion: 2, panels: [], activate: async (_host: HostContext) => undefined } }; },
    transport: async (input, init) => {
      const url = requestUrl(input), method = init?.method;
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-only-token');
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname === '/api/v2/plugin-installations/plan') {
        assert.deepEqual(JSON.parse(String(init?.body)), { kind: 'offline', artifact_id: 'offline-artifact' });
        return success({ id: 'example-release', version: '1.0.0', revision: 'a'.repeat(64), actions: ['verify', 'install'], issues: [] });
      }
      if (url.pathname === '/api/v2/plugin-installations' && method === 'POST') {
        assert.deepEqual(JSON.parse(String(init?.body)), { source: { kind: 'offline', artifact_id: 'offline-artifact' } });
        return success({ id: 'install-job', operation: 'installation.install', status: 'queued', input: {}, created_at: 1 }, 'install-log', 202);
      }
      if (url.pathname.endsWith('/enabled')) {
        assert.equal(method, 'PATCH');
        assert.deepEqual(JSON.parse(String(init?.body)), { expected_revision: 'a'.repeat(64), enabled: true });
        enabled = true;
        return success({ id: 'enable-job', operation: 'installation.enabled', status: 'queued', input: {}, created_at: 1 }, 'enable-log', 202);
      }
      if (url.pathname.startsWith('/api/v2/jobs/')) {
        if (url.pathname.endsWith('/events')) return success([]);
        const enabling = url.pathname.endsWith('/enable-job');
        return success({ id: enabling ? 'enable-job' : 'install-job', operation: enabling ? 'installation.enabled' : 'installation.install', status: 'succeeded', input: {}, created_at: 1, result: null });
      }
      assert.equal(url.pathname, '/api/v2/plugin-installations');
      return success([installedDto(enabled)], 'actual-directory-log');
    } });
  try {
    const value = await runtime.pluginInstallations.install({ kind: 'offline', artifactId: 'offline-artifact' }, signal());
    assert.equal(value.enabled, true);
    assert.equal(value.name, '示例功能');
    assert.equal(runtime.pluginInstallations.snapshot().result?.logId, 'actual-directory-log');
    assert.equal(tokenReads, requests.length);
    assert.deepEqual(imports, [`http://localhost:7031/api/v2/plugin-installations/browser/example-browser/revisions/${'a'.repeat(64)}/assets/dist/index.js`]);
  } finally { await runtime.dispose(); }
});

test('专用离线上传使用 File 原字节，不进入普通产物 64 MiB 路由', async () => {
  const file = new File(['offline-release'], '完整插件.zip', { type: 'application/zip' });
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async (input, init) => {
    const url = requestUrl(input);
    assert.equal(url.pathname, '/api/v2/plugin-installations/artifacts');
    assert.equal(url.searchParams.get('filename'), file.name);
    assert.equal(init?.body, file);
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/octet-stream');
    return success({ id: 'release-artifact', filename: file.name, sha256: 'a'.repeat(64), size: file.size, media_type: 'application/zip', created_at: 1 }, 'artifact-log', 201);
  } });
  try { assert.equal((await runtime.installationArtifacts.upload(file.name, file, signal())).logId, 'artifact-log'); }
  finally { await runtime.dispose(); }
});

test('安装目录损坏字段在 API 边界拒绝并保留日志，不运行浏览器', async () => {
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: async () =>
    success([{ ...installedDto(true), revision: 'bad-revision' }], 'malformed-installation-log') });
  try {
    await assert.rejects(runtime.pluginInstallations.refresh(signal()), (reason: unknown) => reason instanceof ApiError && reason.kind === 'protocol' && reason.logId === 'malformed-installation-log');
    assert.deepEqual(runtime.webPlugins.snapshot(), []);
  } finally { await runtime.dispose(); }
});

test('安装 HTTP 适配保留组件清理及文件事务失败阶段和原始原因', async () => {
  for (const phase of ['component_cleanup', 'activation_cleanup', 'commit_rollback']) {
    const failure = { phase, reason: '原始清理或事务错误' };
    const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
      transport: async () => success([{ ...installedDto(true), status: 'recovery_blocked', failure }], 'failure-log') });
    try {
      const result = await runtime.pluginInstallations.refresh(signal());
      assert.equal(result.data[0]?.status, 'recovery_blocked');
      assert.deepEqual(result.data[0]?.failure, failure);
      assert.equal(result.logId, 'failure-log');
    } finally { await runtime.dispose(); }
  }
});

test('HTTP 配置需求兼容旧发布无候选路径，也接受空候选、转义指针和16项上限', async () => {
  const requirement = { component_id: 'example-server', config_pointer: '/token', title: '凭据',
    description: '填写令牌或配置凭据来源', required: true, sensitive: true };
  let current: unknown = requirement;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async () => success([{ ...installedDto(), requirements: [current] }], 'requirement-compatible-log'),
  });
  try {
    for (const value of [
      requirement,
      { ...requirement, any_of: [] },
      { ...requirement, any_of: ['/credentials/file', '/sources/a~1b', '/sources/a~0b', '/凭据/文件'] },
      { ...requirement, any_of: Array.from({ length: 16 }, (_, index) => `/sources/${index}`) },
    ]) {
      current = value;
      await runtime.pluginInstallations.refresh(signal());
      const result = runtime.pluginInstallations.snapshot().result;
      assert.equal(result?.logId, 'requirement-compatible-log');
      assert.equal(result?.data[0]?.id, 'example-release');
      assert.equal(result?.data[0]?.name, '示例功能');
    }
    assert.deepEqual(runtime.webPlugins.snapshot(), []);
  } finally { await runtime.dispose(); }
});

test('HTTP 拒绝候选配置路径的错误类型、空字符串、超量和重复并保留日志', async () => {
  let anyOf: unknown;
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async () => success([{ ...installedDto(), requirements: [{
      component_id: 'example-server', config_pointer: '/token', title: '凭据', description: '',
      required: true, sensitive: true, any_of: anyOf,
    }] }], 'requirement-invalid-log'),
  });
  try {
    for (const invalid of [
      null, false, 1, '/credentials/file', {}, [''], ['   '], [null], [1], ['/credentials/file', false],
      ['/credentials/file', '/credentials/file'], ['/token'],
      Array.from({ length: 17 }, (_, index) => `/sources/${index}`),
    ]) {
      anyOf = invalid;
      await assert.rejects(runtime.pluginInstallations.refresh(signal()), (reason: unknown) => reason instanceof ApiError &&
        reason.kind === 'protocol' && reason.logId === 'requirement-invalid-log');
    }
    assert.deepEqual(runtime.webPlugins.snapshot(), []);
  } finally { await runtime.dispose(); }
});

test('HTTP 目录保留恢复受阻状态，客户端恢复不加载其浏览器', async () => {
  const imports: string[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    esmImporter: async (url) => { imports.push(url); throw new Error('恢复受阻时不应加载模块'); },
    transport: async () => success([{ ...installedDto(true), status: 'recovery_blocked' }], 'recovery-directory-log'),
  });
  try {
    await runtime.pluginInstallations.restore(signal());
    assert.equal(runtime.pluginInstallations.snapshot().result?.data[0]?.status, 'recovery_blocked');
    assert.equal(runtime.pluginInstallations.snapshot().result?.logId, 'recovery-directory-log');
    assert.deepEqual(imports, []);
    assert.deepEqual(runtime.pluginInstallations.clientSnapshot(), []);
  } finally { await runtime.dispose(); }
});

test('HTTP 未知安装状态在边界拒绝并保留日志', async () => {
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async () => success([{ ...installedDto(true), status: 'unknown_status' }], 'unknown-status-log'),
  });
  try {
    await assert.rejects(runtime.pluginInstallations.refresh(signal()), (reason: unknown) => reason instanceof ApiError &&
      reason.kind === 'protocol' && reason.logId === 'unknown-status-log');
    assert.deepEqual(runtime.webPlugins.snapshot(), []);
  } finally { await runtime.dispose(); }
});

test('HTTP 任务进度接受未知总量，拒绝非法阶段与字节并保留日志', async () => {
  let progress: unknown = { stage: 'downloading', resource_id: '0'.repeat(64), completed_bytes: 2 };
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async () => success([{ job_id: 'progress-job', sequence: 1, timestamp: 1, status: 'running', progress }], 'progress-boundary-log'),
  });
  try {
    const unknownTotal = await runtime.tasks.events('progress-job', {}, signal());
    assert.equal(unknownTotal.data[0]?.progress?.total_bytes, undefined);
    assert.equal(unknownTotal.data[0]?.progress?.resource_id, '0'.repeat(64), '真实下载进度使用可能以数字开头的摘要');
    for (const invalid of [
      { stage: 'unknown', completed_bytes: 0 },
      { stage: 'downloading', completed_bytes: -1 },
      { stage: 'downloading', completed_bytes: 3, total_bytes: 2 },
      { stage: 'downloading', completed_bytes: 0.5 },
      { stage: 'downloading', completed_bytes: 0, resource_id: '../payload' },
    ]) {
      progress = invalid;
      await assert.rejects(runtime.tasks.events('progress-job', {}, signal()), (reason: unknown) =>
        reason instanceof ApiError && reason.kind === 'protocol' && reason.logId === 'progress-boundary-log');
    }
  } finally { await runtime.dispose(); }
});

test('HTTP 托管资源检查和清理明确发送 dry_run，不隐式清理其他接口', async () => {
  const requests: boolean[] = [];
  const runtime = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      if (path === '/api/v2/plugin-installations/cleanup') {
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body));
        requests.push(body.dry_run);
        return success({ id: 'cleanup-job', operation: 'installation.cleanup', status: 'queued', input: {}, created_at: 1 }, 'cleanup-submit-log', 202);
      }
      if (path === '/api/v2/jobs/cleanup-job') return success({ id: 'cleanup-job', operation: 'installation.cleanup',
        status: 'succeeded', input: {}, created_at: 1, result: { dry_run: requests.at(-1), items: [], total_bytes: 0 } }, 'cleanup-terminal-log');
      assert.ok(path === '/api/v2/jobs/cleanup-job/events' || path === '/api/v2/plugin-installations');
      return success([]);
    },
  });
  try {
    const report = await runtime.pluginInstallations.cleanup(true, signal());
    assert.equal(report.logId, 'cleanup-terminal-log');
    assert.deepEqual(requests, [true]);
    await runtime.pluginInstallations.cleanup(false, signal());
    assert.deepEqual(requests, [true, false]);
  } finally { await runtime.dispose(); }
});
