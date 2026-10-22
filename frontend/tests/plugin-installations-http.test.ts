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
