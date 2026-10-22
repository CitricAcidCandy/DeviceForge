import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep, basename } from 'node:path';
import {
  installPluginRelease,
  installationApiUrl,
  listPluginInstallations,
} from '../src/plugin-installations.mjs';
import { parseOptions } from '../src/options.mjs';

const logId = 'e57c6c9c-04ad-43ab-9573-5cb7f3424988',
  revision = 'b'.repeat(64);
const source = {
  kind: 'market',
  source_url: 'https://market.test/api/v1/resources/' + revision,
  release_id: 'demo',
  version: '0.1.0',
  manifest_sha256: revision,
};
const job = (status = 'queued') => ({
  id: 'b74a877b-d990-4c46-be45-08c6c4018d3b',
  operation: 'installation.install',
  status,
  result: null,
  error: null,
  created_at: 0,
});
async function server(run, handler) {
  const instance = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await handler(request, Buffer.concat(chunks));
      response.writeHead(result.status ?? 200, {
        'content-type': 'application/json',
        'x-deviceforge-log-id': result.logId ?? logId,
      });
      response.end(JSON.stringify(result.raw ?? { log_id: logId, data: result.data }));
    } catch {
      response.writeHead(500);
      response.end('{}');
    }
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  try {
    return await run(`http://127.0.0.1:${instance.address().port}`);
  } finally {
    instance.closeAllConnections();
    await new Promise((resolve, reject) =>
      instance.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
test('在线来源使用统一安装 DTO，202之后读取真实任务终态', async () => {
  const calls = [];
  await server(
    async (apiUrl) => {
      const result = await installPluginRelease(
        { apiUrl, source },
        { environment: {}, pollIntervalMs: 1 },
      );
      assert.equal(result.job.status, 'succeeded');
      assert.equal(result.logId, logId);
    },
    (request, body) => {
      calls.push({ method: request.method, path: request.url });
      if (request.method === 'POST') {
        assert.deepEqual(JSON.parse(body), { source, expected_revision: null });
        return { status: 202, data: job() };
      }
      return { data: job('succeeded') };
    },
  );
  assert.deepEqual(
    calls.map((item) => item.method),
    ['POST', 'GET'],
  );
});
test('更新传旧修订并使用PUT，不重放安装POST', async () => {
  const calls = [];
  await server(
    (apiUrl) =>
      installPluginRelease(
        { apiUrl, source, updateId: 'demo', expectedRevision: revision },
        { environment: {}, pollIntervalMs: 1 },
      ),
    (request, body) => {
      calls.push(request.method);
      assert.equal(request.url, '/api/v2/plugin-installations/demo');
      assert.equal(JSON.parse(body).expected_revision, revision);
      return { status: 202, data: job('succeeded') };
    },
  );
  assert.deepEqual(calls, ['PUT']);
});
test('离线ZIP流先上传产物，随后同一个统一安装请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-cli-release-'));
  try {
    const path = join(root, '离线发布.zip'),
      bytes = Buffer.from('受控 ZIP 上传夹具，服务测试不解包');
    await writeFile(path, bytes);
    const calls = [];
    await server(
      (apiUrl) =>
        installPluginRelease({ apiUrl, source: path }, { environment: {}, pollIntervalMs: 1 }),
      (request, body) => {
        calls.push(request.url);
        if (request.url.startsWith('/api/v2/plugin-installations/artifacts?')) {
          assert.equal(request.headers['content-type'], 'application/octet-stream');
          assert.deepEqual(body, bytes);
          return { status: 201, data: { id: 'artifact-1' } };
        }
        assert.deepEqual(JSON.parse(body), {
          source: { kind: 'offline', artifact_id: 'artifact-1' },
          expected_revision: null,
        });
        return { status: 202, data: job('succeeded') };
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1], '/api/v2/plugin-installations');
  } finally {
    const actual = await realpath(root),
      parent = await realpath(tmpdir()),
      delta = relative(parent, actual);
    assert.ok(
      delta &&
        !isAbsolute(delta) &&
        delta !== '..' &&
        !delta.startsWith('..' + sep) &&
        basename(actual).startsWith('deviceforge-cli-release-'),
    );
    await rm(actual, { recursive: true, force: true });
  }
});
test('可选认证只发请求头，错误仅返回受控类别与日志ID', async () => {
  const token = 'session-only-test-token';
  await server(
    async (apiUrl) => {
      await assert.rejects(
        installPluginRelease({ apiUrl, source }, { environment: { APK_API_TOKEN: token } }),
        (error) =>
          !error.message.includes(token) &&
          error.message.includes('conflict') &&
          error.message.includes(logId),
      );
    },
    (request) => {
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      return { status: 409, raw: { log_id: logId, error: { code: 'conflict', message: token } } };
    },
  );
});
test('日志ID不一致和非202成功均作为协议失败', async () => {
  await server(
    async (apiUrl) => {
      await assert.rejects(
        installPluginRelease({ apiUrl, source }, { environment: {} }),
        /日志 ID 不一致/,
      );
    },
    () => ({ status: 202, logId: 'wrong', data: job() }),
  );
  await server(
    async (apiUrl) => {
      await assert.rejects(
        installPluginRelease({ apiUrl, source }, { environment: {} }),
        /返回202/,
      );
    },
    () => ({ status: 200, data: job('succeeded') }),
  );
});
test('失败或取消的任务绝不报告安装成功', async () => {
  for (const status of ['failed', 'cancelled'])
    await server(
      async (apiUrl) => {
        await assert.rejects(
          installPluginRelease({ apiUrl, source }, { environment: {} }),
          /失败|取消/,
        );
      },
      () => ({ status: 202, data: job(status) }),
    );
});
test('取消等待后停止轮询，不自动重发POST或撤销任务', async () => {
  const calls = [],
    controller = new AbortController();
  await server(
    async (apiUrl) => {
      await assert.rejects(
        installPluginRelease(
          { apiUrl, source },
          {
            environment: {},
            signal: controller.signal,
            pollIntervalMs: 1,
            onProgress: () => controller.abort(),
          },
        ),
        /abort/i,
      );
    },
    (request) => {
      calls.push(request.method);
      return { status: 202, data: job() };
    },
  );
  assert.deepEqual(calls, ['POST']);
});
test('等待期限覆盖整个安装任务，不会无限轮询', async () => {
  await server(
    async (apiUrl) => {
      await assert.rejects(
        installPluginRelease(
          { apiUrl, source },
          { environment: {}, timeoutMs: 35, pollIntervalMs: 10 },
        ),
        /timeout|abort/i,
      );
    },
    () => ({ status: 202, data: job() }),
  );
});
test('列表使用同一个公开安装视图', async () => {
  await server(
    async (apiUrl) => {
      assert.deepEqual(await listPluginInstallations({ apiUrl }, { environment: {} }), [
        { id: 'demo', name: '示例' },
      ]);
    },
    (request) => {
      assert.equal(request.url, '/api/v2/plugin-installations');
      return { data: [{ id: 'demo', name: '示例' }] };
    },
  );
});
test('入口参数区分统一和兼容安装，更新要求CAS，地址拒绝凭据', () => {
  assert.equal(
    parseOptions(['plugin', 'install', 'offline.zip', '--api-url', 'http://127.0.0.1:7031'], {})
      .apiUrl,
    'http://127.0.0.1:7031',
  );
  assert.equal(
    parseOptions(['plugin', 'install-legacy', 'package.tgz'], {}).command,
    'plugin.install-legacy',
  );
  assert.equal(
    parseOptions(['plugin', 'update', 'demo', 'offline.zip', '--expected-revision', revision], {})
      .updateId,
    'demo',
  );
  assert.throws(
    () => parseOptions(['plugin', 'update', 'demo', 'offline.zip'], {}),
    /expected-revision/,
  );
  for (const value of [
    'file:///root',
    'https://user:pass@host',
    'https://host/path',
    'https://host/?secret',
  ])
    assert.throws(() => installationApiUrl(value));
});
test('无效更新与混合离线身份在任何上传前拒绝', async () => {
  let calls = 0;
  const context = {
    environment: {},
    transport: async () => {
      calls++;
      throw new Error('不应调用网络');
    },
  };
  await assert.rejects(
    installPluginRelease(
      { source: '不存在.zip', updateId: '../demo', expectedRevision: revision },
      context,
    ),
    /更新需要发布 ID/,
  );
  await assert.rejects(
    installPluginRelease({ source: '不存在.zip', updateId: 'demo' }, context),
    /更新需要发布 ID/,
  );
  await assert.rejects(
    installPluginRelease({ source: '不存在.zip', releaseId: 'demo' }, context),
    /不能混用市场来源/,
  );
  await assert.rejects(
    installPluginRelease({ source, updateId: 'other', expectedRevision: revision }, context),
    /更新目标与发布 ID 不一致/,
  );
  assert.equal(calls, 0);
});
