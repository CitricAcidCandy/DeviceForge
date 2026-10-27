import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiClient } from '../src/services/api/index.ts';
import { callServerServiceEndpoint, isServerService } from '../src/services/api/server-services.ts';
import { createServerServiceAccess } from '../src/app/server-services.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { failure, job, requestUrl, signal, success } from './fixtures.ts';

function directory() {
  return { service: { id: 'provider.echo', version: '1.0' },
    contract: { input_schema: { type: 'string' }, output_schema: { type: 'string' } },
    operation: 'provider.run', provider: { id: 'provider', version: '2.0', generation: 'generation-1' },
    available: true, unavailable_reason: null };
}
test('服务器服务目录映射精确字符串版本、契约、代际与日志，调用返回共享Job', async () => {
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (url, init) => {
    const path = requestUrl(url).pathname;
    if (path === '/api/v2/services') return success([directory()], 'directory-log');
    assert.equal(path, '/api/v2/services/provider.echo/calls'); assert.equal(init?.method, 'POST');
    assert.equal(init?.body, JSON.stringify({ version: '1.0', input: 'ok', generation: 'generation-1' }));
    return success(job(), 'job-log', 202);
  } });
  const access = createServerServiceAccess(client, signal());
  const listed = await access.list(signal());
  assert.equal(listed.logId, 'directory-log');
  assert.equal(listed.data[0]?.service.version, '1.0');
  assert.equal(listed.data[0]?.provider.generation, 'generation-1');
  assert.deepEqual(listed.data[0]?.contract.inputSchema, { type: 'string' });
  const result = await access.submit({ id: 'provider.echo', version: '1.0' }, 'ok', signal(), 'generation-1');
  assert.equal(result.data.status, 'queued'); assert.equal(result.logId, 'job-log');
});
test('服务器服务拒绝数值版本、错误目录与失效作用域，不把提交任务伪装成结果', async () => {
  assert.equal(isServerService({ ...directory(), service: { id: 'provider.echo', version: 1 } }), false);
  assert.equal(isServerService({ ...directory(), provider: { generation: 1 } }), false);
  assert.equal(isServerService({ ...directory(), available: 'yes' }), false);
  assert.throws(() => callServerServiceEndpoint.request({ id: 'provider.echo', body: { version: '', input: null, generation: null } }), /精确/);
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => failure('provider_generation_mismatch') });
  const lifetime = new AbortController();
  const access = createServerServiceAccess(client, lifetime.signal);
  await assert.rejects(access.submit({ id: 'provider.echo', version: '1' }, null, signal()),
    (error: unknown) => error instanceof HostError && error.code === 'provider_generation_mismatch' && error.logId === 'log-error');
  lifetime.abort(); await assert.rejects(access.list(signal()), /撤销/);
});
