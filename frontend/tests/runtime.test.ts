import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import { failure, job, requestUrl, signal, success } from './fixtures.ts';

test('app 装配 SDK v2 公共模型与日志，服务令牌不进入上下文', async () => {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async (url) => {
      if (requestUrl(url).pathname.endsWith('/operations'))
        return success(
          [{ id: 'example.run', title: '运行', input_schema: true }],
          'operations-log',
        );
      return success(job(), 'job-log');
    },
  });
  assert.equal(runtime.host.apiVersion, 2);
  assert.equal('tokenProvider' in runtime.host, false);
  assert.equal('transport' in runtime.host, false);
  for (const name of ['serverPlugins', 'pluginPackages']) {
    assert.equal(name in runtime, true);
    assert.equal(name in runtime.host, false);
  }
  assert.ok(runtime.host.artifacts);
  assert.notEqual(runtime.host.artifacts, runtime.artifacts);
  assert.deepEqual(Object.keys(runtime.host.artifacts).sort(), ['download', 'upload']);
  assert.equal((await runtime.host.listOperations(signal())).data[0]?.input_schema, true);
  const submitted = await runtime.host.submit('example.run', {}, signal());
  assert.equal(submitted.logId, 'job-log');
  assert.equal(submitted.data.result, null);
  assert.equal(submitted.data.error, null);
  let updates = 0;
  runtime.host.subscribeOperations(() => {
    ++updates;
  });
  await runtime.operations.refresh(signal());
  assert.equal(updates, 1);
  let cleanups = 0;
  runtime.host.onDispose(() => {
    ++cleanups;
  });
  await Promise.all([runtime.dispose(), runtime.dispose()]);
  assert.equal(cleanups, 1);
  await assert.rejects(
    runtime.host.getJob('job-test', signal()),
    (error: unknown) => error instanceof HostError && error.kind === 'cancelled',
  );
});

test('宿主将内部 API 错误映射成公开错误，保留日志和状态', async () => {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    transport: async () => failure('unauthorized', 401),
  });
  await assert.rejects(runtime.host.listOperations(signal()), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.status, 401);
    assert.equal(error.logId, 'log-error');
    return true;
  });
  await runtime.dispose();
});
