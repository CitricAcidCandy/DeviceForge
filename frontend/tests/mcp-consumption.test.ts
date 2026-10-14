import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpClient } from '../src/features/mcp/index.ts';
import { ApiError, createMcpTransport } from '../src/services/api/index.ts';
import { signal } from './fixtures.ts';

const tool = (name: string) => ({
  name,
  description: '工具描述',
  inputSchema: { type: 'object', additionalProperties: false },
});
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function rpc(id: number, result: unknown, logId = 'mcp-log'): Response {
  return Response.json(
    { jsonrpc: '2.0', id, result },
    { headers: { 'x-deviceforge-log-id': logId } },
  );
}
function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  return new Promise((resolve, reject) => {
    const check = () =>
      predicate()
        ? resolve()
        : Date.now() >= deadline
          ? reject(new Error('等待 MCP 状态超时'))
          : setTimeout(check, 5);
    check();
  });
}

test('MCP 工具目录分页沿协议字段消费并冻结快照', async () => {
  const calls: { readonly body: Record<string, unknown>; readonly headers: Headers }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    assert.ok(body && typeof body === 'object' && !Array.isArray(body));
    const record = body as Record<string, unknown>;
    calls.push({ body: record, headers: request.headers });
    const params = record.params as Record<string, unknown>;
    const result =
      params.cursor === undefined
        ? {
            resultType: 'complete',
            tools: [tool('one')],
            nextCursor: '1',
            ttlMs: 0,
            cacheScope: 'private',
            _meta: { 'deviceforge/log_id': 'page-one' },
          }
        : {
            resultType: 'complete',
            tools: [tool('two')],
            ttlMs: 0,
            cacheScope: 'private',
            _meta: { 'deviceforge/log_id': 'page-two' },
          };
    return rpc(Number(record.id), result, params.cursor === undefined ? 'page-one' : 'page-two');
  };
  const client = createMcpClient(
    createMcpTransport({ baseUrl: 'http://localhost:7031', transport }),
  );
  const snapshot = await client.listTools(signal());
  assert.deepEqual(
    snapshot.tools.map((entry) => entry.name),
    ['one', 'two'],
  );
  assert.equal(snapshot.logId, 'page-two');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.headers.get('MCP-Protocol-Version'), '2026-07-28');
  assert.equal(calls[0]?.headers.get('Mcp-Method'), 'tools/list');
  assert.deepEqual((calls[0]?.body.params as Record<string, unknown>)['_meta'], {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'deviceforge-web', version: '0.1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  });
  assert.throws(() => {
    (snapshot.tools[0]?.inputSchema as Record<string, unknown>).type = 'string';
  }, TypeError);
  await client.dispose();
});

test('MCP 订阅先确认再按目录失效通知刷新并可释放', async () => {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let listCalls = 0;
  const changed: string[][] = [];
  let subscriptionRequest: Record<string, unknown> | undefined;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body: unknown = await request.json();
    assert.ok(body && typeof body === 'object' && !Array.isArray(body));
    const record = body as Record<string, unknown>;
    if (record.method === 'tools/list')
      return rpc(
        Number(record.id),
        { tools: [tool(`dynamic-${++listCalls}`)], _meta: { 'deviceforge/log_id': 'catalog-log' } },
        'catalog-log',
      );
    subscriptionRequest = record;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: { toolsListChanged: true } } })}\n\n`,
            ),
          );
        },
      }),
      {
        headers: {
          'content-type': 'text/event-stream',
          'x-deviceforge-log-id': 'subscription-log',
        },
      },
    );
    return response;
  };
  const client = createMcpClient(
    createMcpTransport({ baseUrl: 'http://localhost:7031', transport }),
  );
  const release = await client.subscribe(
    {
      changed: (snapshot) => changed.push(snapshot.tools.map((entry) => entry.name)),
      error: (error) => {
        throw error;
      },
    },
    signal(),
  );
  assert.equal(subscriptionRequest?.method, 'subscriptions/listen');
  assert.deepEqual((subscriptionRequest?.params as Record<string, unknown>)['notifications'], {
    toolsListChanged: true,
  });
  streamController?.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { 'deviceforge/log_id': 'subscription-log' } } })}\n\n`,
    ),
  );
  await waitFor(() => changed.length === 1);
  assert.deepEqual(changed, [['dynamic-1']]);
  await release();
  assert.equal(listCalls, 1);
  await client.dispose();
});

test('MCP 响应、订阅和日志边界错误不伪造成功', async () => {
  const invalid = createMcpClient(
    createMcpTransport({
      baseUrl: 'http://localhost:7031',
      transport: async (_input, init) => {
        const request = new Request(_input, init);
        const body: unknown = await request.json();
        const id = record(body) && typeof body.id === 'number' ? body.id : 1;
        return Response.json(
          { jsonrpc: '2.0', id, result: { tools: [], unknown: true } },
          { headers: { 'x-deviceforge-log-id': 'invalid' } },
        );
      },
    }),
  );
  await assert.rejects(
    invalid.listTools(signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'protocol' &&
      error.code === 'invalid_mcp_response',
  );
  await invalid.dispose();

  const invalidResultType = createMcpClient(
    createMcpTransport({
      baseUrl: 'http://localhost:7031',
      transport: async (_input, init) => {
        const request = new Request(_input, init);
        const body: unknown = await request.json();
        const id = record(body) && typeof body.id === 'number' ? body.id : 1;
        return rpc(id, { resultType: 'streaming', tools: [] }, 'invalid-result-type');
      },
    }),
  );
  await assert.rejects(
    invalidResultType.listTools(signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.kind === 'protocol' &&
      error.code === 'invalid_mcp_response',
  );
  await invalidResultType.dispose();

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const broken = createMcpClient(
    createMcpTransport({
      baseUrl: 'http://localhost:7031',
      transport: async (_input, init) => {
        const request = new Request(_input, init);
        const body: unknown = await request.json();
        assert.ok(body && typeof body === 'object' && !Array.isArray(body));
        const id = (body as Record<string, unknown>).id;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
            },
          }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'x-deviceforge-log-id': 'subscription-log',
            },
          },
        );
      },
    }),
  );
  const subscription = broken.subscribe({ changed: () => undefined }, signal());
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller?.enqueue(
    new TextEncoder().encode(
      'data: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged","params":{"notifications":{}}}\n\n',
    ),
  );
  await assert.rejects(
    subscription,
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_mcp_response',
  );
  await broken.dispose();
});

test('MCP 目录取消及时结束忽略信号的传输等待', async () => {
  const client = createMcpClient({ request: async () => new Promise<never>(() => undefined) });
  const controller = new AbortController();
  const waiting = client.listTools(controller.signal);
  controller.abort();
  await assert.rejects(
    waiting,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  await client.dispose();
});
