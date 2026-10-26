import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getPluginDependencies, changePluginDependencies } from '../src/plugin-dependencies.mjs';
import { parseOptions, help } from '../src/options.mjs';

const logId = '412c452a-e857-4e68-b25f-74ea03295f51';
const revision = 'a'.repeat(64);
const target = { kind: 'server', id: 'demo.plugin' };
const dependencies = { target, revision, ready: false, dependencies: [] };
const options = { dependencyTarget: target, expectedRevision: revision, dependencyIds: [] };
const job = (operation, status = 'succeeded', result = dependencies) => ({
  id: '79151a19-294b-4096-b7e1-5490fe104f31',
  operation,
  status,
  result,
});
const response = (data, status = 200, headerLogId = logId) =>
  new Response(JSON.stringify({ log_id: logId, data }), {
    status,
    headers: { 'x-deviceforge-log-id': headerLogId },
  });

test('依赖查询默认get，显式动作和三种目标均可解析', () => {
  for (const kind of ['release', 'server', 'browser']) {
    const parsed = parseOptions(['plugin', 'dependencies', kind, 'demo.plugin'], {});
    assert.equal(parsed.command, 'plugin.dependencies');
    assert.equal(parsed.dependencyAction, 'get');
    assert.deepEqual(parsed.dependencyTarget, { kind, id: 'demo.plugin' });
    assert.equal(parsed.apiUrl, 'http://127.0.0.1:7030');
  }
  for (const action of ['scan', 'install']) {
    const parsed = parseOptions(
      [
        'plugin',
        'dependencies',
        action,
        'server',
        'demo.plugin',
        '--expected-revision',
        revision,
        '--dependency-ids',
        'java,adb',
      ],
      {},
    );
    assert.equal(parsed.dependencyAction, action);
    assert.deepEqual(parsed.dependencyIds, ['java', 'adb']);
    assert.equal(parsed.expectedRevision, revision);
  }
  assert.equal(
    parseOptions(['plugin', 'dependencies', 'get', 'server', 'demo'], {
      DEVICEFORGE_API_URL: 'http://localhost:7031',
    }).apiUrl,
    'http://localhost:7031',
  );
  assert.match(help, /dependencies.*scan\|install/);
});

test('依赖参数拒绝无效目标、遗漏修订、跨命令参数和重复依赖', () => {
  const base = ['plugin', 'dependencies'];
  for (const tail of [
    [],
    ['unknown', 'demo'],
    ['server'],
    ['server', '../demo'],
    ['server', 'builtin.demo'],
    ['scan', 'server', 'demo'],
    ['install', 'server', 'demo', '--expected-revision', 'bad'],
    ['server', 'demo', '--expected-revision', revision],
    ['server', 'demo', '--dependency-ids', 'java'],
    ['server', 'demo', '--data-dir', 'local'],
    ['server', 'demo', '--release-id', 'demo'],
    ['server', 'demo', '--dry-run', 'true'],
    ['server', 'demo', '--api-url', 'http://user:secret@example.test'],
    ['server', 'demo', '--api-url', 'http://example.test/private'],
    ['scan', 'server', 'demo', '--expected-revision', revision, '--dependency-ids', 'java,java'],
    ['scan', 'server', 'demo', '--expected-revision', revision, '--dependency-ids', 'java,'],
    ['scan', 'server', 'demo', '--expected-revision', revision, '--dependency-ids', '../java'],
    ['scan', 'server', 'demo', '--expected-revision', revision, '--expected-revision', revision],
  ])
    assert.throws(() => parseOptions([...base, ...tail], {}));
  assert.throws(() => parseOptions(['plugin', 'list', '--dependency-ids', 'java'], {}));
});

test('依赖查询复用v2日志关联与可选鉴权，不提交任务', async () => {
  const calls = [];
  const result = await getPluginDependencies(options, {
    environment: { APK_API_TOKEN: 'dependency-test-only' },
    transport: async (url, init) => {
      calls.push(url.pathname);
      assert.equal(init.headers.authorization, 'Bearer dependency-test-only');
      assert.equal(init.method, undefined);
      return response(dependencies);
    },
  });
  assert.equal(result.logId, logId);
  assert.deepEqual(result.data, dependencies);
  assert.deepEqual(calls, ['/api/v2/plugin-dependencies/server/demo.plugin']);
});

test('所属组件接受完整发布的规范身份，独立目标仍校验同名类别', async () => {
  const canonical = { ...dependencies, target: { kind: 'release', id: 'suite' } };
  const result = await getPluginDependencies(options, { environment: {},
    transport: async () => response(canonical) });
  assert.deepEqual(result.data.target, canonical.target);
  await assert.rejects(getPluginDependencies(options, { environment: {},
    transport: async () => response({ ...dependencies, target: { kind: 'browser', id: target.id } }) }));
});

test('scan/install只提交一次DependencyChange并复用任务终态等待', async () => {
  for (const action of ['scan', 'install']) {
    const calls = [];
    const result = await changePluginDependencies(
      { ...options, dependencyAction: action, dependencyIds: ['java'] },
      {
        environment: {},
        pollIntervalMs: 1,
        transport: async (url, init) => {
          calls.push(url.pathname);
          if (init.method === 'POST') {
            assert.equal(url.pathname, `/api/v2/plugin-dependencies/server/demo.plugin/${action}`);
            assert.deepEqual(JSON.parse(init.body), {
              expected_revision: revision,
              dependency_ids: ['java'],
            });
            return response(job(`dependency.${action}`, 'queued', null), 202);
          }
          assert.equal(url.pathname, `/api/v2/jobs/${job().id}`);
          return response(job(`dependency.${action}`));
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(result.logId, logId);
    assert.deepEqual(result.dependencies, dependencies);
  }
});

test('依赖变更缺省提交空列表，由服务选择全部依赖', async () => {
  await changePluginDependencies(
    { ...options, dependencyAction: 'scan', dependencyIds: undefined },
    {
      environment: {},
      transport: async (_, init) => {
        assert.deepEqual(JSON.parse(init.body).dependency_ids, []);
        return response(job('dependency.scan'), 202);
      },
    },
  );
});

test('错误操作、任务身份漂移和非202响应均拒绝', async () => {
  for (const [data, status, expected] of [
    [job('installation.install'), 202, /操作或状态无效/],
    [job('dependency.scan'), 200, /返回202/],
  ])
    await assert.rejects(
      changePluginDependencies(
        { ...options, dependencyAction: 'scan' },
        {
          environment: {},
          transport: async () => response(data, status),
        },
      ),
      expected,
    );
  let calls = 0;
  await assert.rejects(
    changePluginDependencies(
      { ...options, dependencyAction: 'scan' },
      {
        environment: {},
        pollIntervalMs: 1,
        transport: async () => {
          if (calls++ === 0) return response(job('dependency.scan', 'queued'), 202);
          return response({ ...job('dependency.scan'), id: 'another-job' });
        },
      },
    ),
    /身份、操作或状态无效/,
  );
});

test('失败或取消任务不报告成功，当前缺失依赖不被伪装为ready', async () => {
  for (const status of ['failed', 'cancelled'])
    await assert.rejects(
      changePluginDependencies(
        { ...options, dependencyAction: 'install' },
        {
          environment: {},
          transport: async () => response(job('dependency.install', status), 202),
        },
      ),
      /失败|取消/,
    );
  const result = await changePluginDependencies(
    { ...options, dependencyAction: 'scan' },
    {
      environment: {},
      transport: async () => response(job('dependency.scan'), 202),
    },
  );
  assert.equal(result.dependencies.ready, false);
});

test('目标不一致、缺少报告和日志ID不一致均为协议失败', async () => {
  for (const data of [
    null,
    { ...dependencies, target: { ...target, id: 'other' } },
    { ...dependencies, revision: 'bad' },
  ]) {
    await assert.rejects(
      getPluginDependencies(options, {
        environment: {},
        transport: async () => response(data),
      }),
      /依赖响应/,
    );
    await assert.rejects(
      changePluginDependencies(
        { ...options, dependencyAction: 'scan' },
        {
          environment: {},
          transport: async () => response(job('dependency.scan', 'succeeded', data), 202),
        },
      ),
      /依赖响应/,
    );
  }
  await assert.rejects(
    getPluginDependencies(options, {
      environment: {},
      transport: async () => response(dependencies, 200, 'different-log-id'),
    }),
    /日志 ID 不一致/,
  );
});

test('无效直接调用在任何网络写入前失败', async () => {
  let calls = 0;
  const context = {
    environment: {},
    transport: async () => {
      calls++;
      throw new Error('不应请求');
    },
  };
  for (const change of [
    { dependencyTarget: { kind: 'server', id: '../escape' } },
    { expectedRevision: 'bad' },
    { dependencyAction: 'other' },
    { dependencyIds: ['java', 'java'] },
    { dependencyIds: ['a'.repeat(100)] },
    { dependencyIds: Array.from({ length: 129 }, (_, index) => `dep${index}`) },
  ])
    await assert.rejects(
      changePluginDependencies({ ...options, dependencyAction: 'scan', ...change }, context),
    );
  await assert.rejects(
    changePluginDependencies(
      { ...options, dependencyAction: 'scan' },
      {
        ...context,
        timeoutMs: 0,
      },
    ),
    /等待期限/,
  );
  assert.equal(calls, 0);
});

test('客户端中止停止轮询，不取消服务器任务或重放POST', async () => {
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(
    changePluginDependencies(
      { ...options, dependencyAction: 'install' },
      {
        environment: {},
        signal: controller.signal,
        pollIntervalMs: 1,
        onProgress: () => controller.abort(),
        transport: async (_, init) => {
          calls.push(init.method);
          return response(job('dependency.install', 'queued', null), 202);
        },
      },
    ),
    /abort/i,
  );
  assert.deepEqual(calls, ['POST']);
});

test('等待总期限有界，不因轮询重置', async () => {
  const calls = [];
  await assert.rejects(
    changePluginDependencies(
      { ...options, dependencyAction: 'scan' },
      {
        environment: {},
        timeoutMs: 30,
        pollIntervalMs: 100,
        transport: async (_, init) => {
          calls.push(init.method);
          return response(job('dependency.scan', 'queued'), 202);
        },
      },
    ),
    /abort|timeout/i,
  );
  assert.deepEqual(calls, ['POST']);
});

test('服务错误只输出受控代码和日志ID，不回显敏感错误载荷', async () => {
  const privateMessage = 'session-only-private-error';
  await assert.rejects(
    getPluginDependencies(options, {
      environment: {},
      transport: async () =>
        new Response(
          JSON.stringify({
            log_id: logId,
            error: { code: 'dependencies_required', message: privateMessage },
          }),
          { status: 409, headers: { 'x-deviceforge-log-id': logId } },
        ),
    }),
    (error) =>
      error.message.includes('dependencies_required') &&
      error.message.includes(logId) &&
      !error.message.includes(privateMessage),
  );
});

test('真实CLI入口分派查询和任务变更，输出公开日志关联', async () => {
  const calls = [];
  const server = createServer(async (request, output) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push(request.url);
    const action = request.url.endsWith('/scan') ? 'scan' : 'install';
    if (request.method === 'POST') {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {
        expected_revision: revision,
        dependency_ids: [],
      });
    }
    output.writeHead(request.method === 'POST' ? 202 : 200, {
      'content-type': 'application/json',
      'x-deviceforge-log-id': logId,
    });
    output.end(
      JSON.stringify({
        log_id: logId,
        data: request.method === 'POST' ? job(`dependency.${action}`) : dependencies,
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const entry = fileURLToPath(new URL('../bin/deviceforge.mjs', import.meta.url));
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    for (const action of ['get', 'scan', 'install']) {
      const args = [
        entry,
        'plugin',
        'dependencies',
        action,
        target.kind,
        target.id,
        '--api-url',
        apiUrl,
      ];
      if (action !== 'get') args.push('--expected-revision', revision);
      const result = await promisify(execFile)(process.execPath, args, {
        timeout: 10000,
        windowsHide: true,
        env: { ...process.env, APK_API_TOKEN: '' },
      });
      const value = JSON.parse(result.stdout);
      assert.equal(value.log_id, logId);
      assert.deepEqual(value.data, dependencies);
      assert.equal(result.stderr, '');
      if (action !== 'get') assert.equal(value.job_id, job().id);
    }
    assert.deepEqual(calls, [
      '/api/v2/plugin-dependencies/server/demo.plugin',
      '/api/v2/plugin-dependencies/server/demo.plugin/scan',
      '/api/v2/plugin-dependencies/server/demo.plugin/install',
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
