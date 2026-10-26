// 这些响应仅用于客户端单元自检，绝不进入真实宿主 smoke 或其通过报告。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { client, targetPath, tools } from './client.mjs';
import { listenerReleased } from './source.mjs';

const logId = '12345678-1234-1234-1234-123456789abc';
const revision = 'a'.repeat(64);
const envelope = (data) => ({ body: { data, log_id: logId } });
const rpc = (request, result) => ({ body: { jsonrpc: '2.0', id: request.input.id,
  result: { ...result, _meta: { 'deviceforge/log_id': logId } } } });
const toolResult = (request, value) => rpc(request, { isError: false, structuredContent: value });

async function withApi(handler, run) {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-dependency-client-check-'));
  const requests = [], failures = [], report = { requests: [], jobs: [] };
  const server = createServer(async (incoming, response) => {
    try {
      const buffers = [];
      for await (const bytes of incoming) buffers.push(bytes);
      const text = Buffer.concat(buffers).toString();
      const request = { path: incoming.url, method: incoming.method, headers: incoming.headers,
        input: text ? JSON.parse(text) : undefined };
      requests.push(request);
      const reply = await handler(request);
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json',
        'x-deviceforge-log-id': reply.logId ?? logId });
      response.end(JSON.stringify(reply.body));
    } catch (error) { failures.push(error); response.writeHead(500).end(); }
  });
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const port = server.address().port, base = `http://127.0.0.1:${port}`;
    try { await run({ api: client(base, root, report), root, requests, report, base }); }
    finally {
      server.closeAllConnections();
      await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
      await listenerReleased(port);
    }
    assert.deepEqual(failures, []);
  } finally {
    const absolute = await realpath(root), offset = relative(await realpath(tmpdir()), absolute);
    assert.ok(offset && !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)
      && basename(absolute).startsWith('deviceforge-dependency-client-check-'));
    await rm(absolute, { recursive: true });
  }
}

test('客户端自检：MCP 初始化及分页带当前协议元数据，所属组件按规范化发布目标继续写入', async () => {
  const owner = { kind: 'release', id: 'owner' }, alias = { kind: 'browser', id: 'component' };
  const view = { target: owner, revision, ready: true, dependencies: [] };
  const job = { id: '12345678-1234-1234-1234-123456789abd', operation: 'dependency.install',
    status: 'succeeded', result: view, error: null };
  await withApi((request) => {
    if (request.path === '/mcp') {
      const { method, params } = request.input;
      assert.equal(request.headers['mcp-protocol-version'], '2025-11-25');
      assert.equal(request.headers['mcp-method'], method);
      assert.equal(params._meta['io.modelcontextprotocol/protocolVersion'], '2025-11-25');
      if (method === 'initialize') return rpc(request, { protocolVersion: '2025-11-25' });
      if (method === 'tools/list') return rpc(request, params.cursor
        ? { tools: [{ name: tools.install }] }
        : { tools: [{ name: tools.get }, { name: tools.scan }], nextCursor: 'next' });
      assert.equal(request.headers['mcp-name'], params.name);
      if (params.name === tools.get) return toolResult(request, view);
      if (params.name === 'deviceforge.get_job') return toolResult(request, job);
      assert.equal(params.name, tools.install); assert.deepEqual(params.arguments.target, owner);
      return toolResult(request, job);
    }
    if (request.path.startsWith('/api/v2/jobs/')) return envelope(request.path.endsWith('/events') ? [{ status: 'succeeded' }] : job);
    if (request.method === 'POST') {
      assert.equal(request.path, `${targetPath(owner)}/install`);
      assert.deepEqual(request.input, { expected_revision: revision });
      return { ...envelope(job), status: 202 };
    }
    return envelope(view);
  }, async ({ api, report, requests }) => {
    await api.requireTools();
    assert.equal(report.mcp_tools.length, 3);
    await assert.rejects(() => api.view(alias), '没有明确归属时不能接受另一目标');
    assert.deepEqual(await api.view(alias, 'mcp', owner), view);
    for (const transport of ['http', 'mcp']) {
      assert.deepEqual((await api.change(alias, 'install', { canonicalTarget: owner, transport })).view, view);
    }
    assert.equal(requests.filter((request) => request.input?.method === 'tools/list').length, 2);
    assert.equal(report.jobs.length, 2);
  });
});

test('客户端自检：重复 MCP 游标或缺少依赖工具均立即阻断，不绕过目录检查', async () => {
  for (const repeated of [false, true]) {
    await withApi((request) => request.input.method === 'initialize'
      ? rpc(request, { protocolVersion: '2025-11-25' })
      : rpc(request, { tools: [], ...(repeated ? { nextCursor: 'stuck' } : {}) }), async ({ api }) => {
      await assert.rejects(() => api.requireTools(), repeated ? /分页未推进/ : /尚未实现 MCP 工具/);
    });
  }
});

test('客户端自检：串任务、串操作与重复终态事件不能计作任务通过', async () => {
  const submitted = { id: '12345678-1234-1234-1234-123456789abd', operation: 'dependency.scan' };
  for (const failure of ['id', 'operation', 'events']) {
    const final = { ...submitted, status: 'succeeded', result: {},
      ...(failure === 'id' ? { id: '另一个任务' } : {}), ...(failure === 'operation' ? { operation: 'dependency.install' } : {}) };
    await withApi((request) => {
      if (request.path === '/mcp') return toolResult(request, final);
      return envelope(request.path.endsWith('/events') ? [{ status: 'succeeded' }, { status: 'succeeded' }] : final);
    }, async ({ api }) => { await assert.rejects(() => api.finish(submitted)); });
  }
});

test('客户端自检：取消业务等待后仍允许独占宿主正常 shutdown', async () => {
  await withApi(() => envelope({ stopping: true }), async ({ base, root, report, requests }) => {
    const controller = new AbortController(), api = client(base, root, report, controller.signal);
    controller.abort(new Error('夹具自检取消'));
    await assert.rejects(() => api.view({ kind: 'server', id: 'cancelled' }), /夹具自检取消/);
    assert.equal(requests.length, 0);
    assert.equal((await api.http('/api/v2/system/shutdown', { method: 'POST' })).stopping, true);
    assert.equal(requests.length, 1);
  });
});

test('客户端自检：缺接口、错误信封或 MCP 日志身份均真实失败并保存原响应', async () => {
  await withApi((request) => {
    if (request.path === '/mcp') return { body: { jsonrpc: '2.0', id: request.input.id, result: { _meta: {} } } };
    if (request.path === '/api/v2/bad-envelope') return { body: { log_id: logId } };
    if (request.path === '/api/v2/null') return envelope(null);
    return { status: 404, body: { log_id: logId, error: { code: 'not_found' } } };
  }, async ({ api, report }) => {
    await assert.rejects(() => api.view({ kind: 'server', id: 'missing' }), /尚未实现目标接口/);
    const saved = JSON.parse(await readFile(report.requests[0].evidence));
    assert.equal(saved.status, 404); assert.equal(JSON.parse(saved.body).error.code, 'not_found');
    await assert.rejects(() => api.http('/api/v2/bad-envelope'), /缺少公开信封/);
    assert.equal(await api.http('/api/v2/null'), null);
    await assert.rejects(() => api.rpc('tools/list'));
  });
});
