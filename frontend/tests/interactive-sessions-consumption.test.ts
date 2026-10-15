import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHttpInteractiveSessions,
  createInteractiveSessions,
} from '../src/features/interactive-sessions/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import { isSessionBytes } from '../src/services/api/session-gateway.ts';
import type {
  ApiResult,
  SessionDefinitions,
  SessionGateway,
  SessionInfo,
  SessionOutputPage,
} from '../src/services/api/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const first = '12345678-1234-1234-1234-123456789abc';
const second = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function info(changes: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: first,
    operation: 'plugin.terminal.open',
    plugin_id: 'terminal',
    generation: 'generation-1',
    created_at: 1,
    status: 'running',
    output_sequence: 0,
    completion: null,
    ...changes,
  };
}
function finished(changes: Partial<SessionInfo> = {}): SessionInfo {
  return info({
    status: 'finished',
    completion: {
      outcome: { result: null, error: null, artifacts: [] },
      cleanup: 'complete',
      process_exited: true,
      sequence: 1,
      failure: null,
    },
    ...changes,
  });
}
function definitions(): SessionDefinitions {
  return {
    revision: 1,
    sessions: [
      {
        id: 'plugin.terminal.open',
        title: '终端',
        input_schema: { type: 'object' },
        execution: { api_version: 1, source: 'declared', total_timeout_ms: 1000 },
      },
    ],
  };
}
function page(changes: Partial<SessionOutputPage> = {}): SessionOutputPage {
  return { session: info(), chunks: [], next_sequence: 0, ...changes };
}
function gateway(changes: Partial<SessionGateway> = {}): SessionGateway {
  return {
    definitions: async () => ({ data: definitions(), logId: 'definitions-log' }),
    list: async () => ({ data: [info()], logId: 'records-log' }),
    open: async () => ({ data: info({ status: 'opening' }), logId: 'open-log' }),
    get: async (id) => ({ data: info({ id }), logId: 'query-log' }),
    output: async () => ({ data: page(), logId: 'output-log' }),
    send: async (id) => ({ data: { id, accepted: true }, logId: 'input-log' }),
    eof: async (id) => ({ data: { id, accepted: true }, logId: 'eof-log' }),
    cancel: async (id) => ({ data: info({ id, status: 'stopping' }), logId: 'cancel-log' }),
    release: async (id) => ({ data: info({ id, status: 'stopping' }), logId: 'release-log' }),
    remove: async (id) => ({ data: { id }, logId: 'remove-log' }),
    ...changes,
  };
}

test('原字节专用校验保留边界并拒绝稀疏、访问器及额外属性', () => {
  const sparse: number[] = [];
  sparse.length = 1;
  const accessor = [0];
  let getterCalls = 0;
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get: () => {
      getterCalls++;
      return 1;
    },
  });
  const invalid: unknown[] = [
    [-1],
    [256],
    [1.5],
    [NaN],
    [Infinity],
    [true],
    ['1'],
    new Uint8Array([1]),
    Array.from({ length: 8193 }, () => 0),
    sparse,
    accessor,
    Object.defineProperty([1], '0', { enumerable: false }),
    Object.assign([1], { extra: 2 }),
    Object.defineProperty([1], 'extra', { value: 2 }),
    Object.defineProperty([1], Symbol('额外属性'), { value: 2 }),
    Object.assign(Array<number>(1), { extra: 1 }),
  ];
  for (const value of invalid) assert.equal(isSessionBytes(value), false);
  for (const value of [[], [0, 255], Object.freeze([0, 255]), Array.from({ length: 8192 }, () => 255)])
    assert.equal(isSessionBytes(value), true);
  assert.equal(getterCalls, 0);
});

test('真实生成端点消费所有会话请求并独立保留日志', async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const client = createApiClient({
    baseUrl: 'http://localhost:3000',
    transport: async (input, init) => {
      const url = requestUrl(input);
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      requests.push({ path: url.pathname + url.search, method: init?.method ?? 'GET', body });
      if (url.pathname.endsWith('/session-definitions'))
        return success(definitions(), 'definitions-log');
      if (url.pathname === '/api/v2/sessions')
        return init?.method === 'POST'
          ? success(info({ status: 'opening' }), 'open-log', 202)
          : success([info()], 'records-log');
      if (url.pathname.endsWith('/output')) return success(page(), 'output-log');
      if (url.pathname.endsWith('/input') || url.pathname.endsWith('/eof'))
        return success(
          { id: first, accepted: true },
          url.pathname.endsWith('/input') ? 'input-log' : 'eof-log',
        );
      if (url.pathname.endsWith('/cancel'))
        return success(info({ status: 'stopping' }), 'cancel-log');
      if (init?.method === 'DELETE') return success({ id: first }, 'remove-log');
      return success(finished(), 'query-log');
    },
  });
  const sessions = createHttpInteractiveSessions(client);
  await sessions.refreshDefinitions(signal());
  await sessions.refreshRecords(signal());
  await sessions.openTerminal('build-worker', signal());
  await sessions.readOutput({}, signal());
  await sessions.send([0, 255, 10], signal());
  await sessions.eof(signal());
  await sessions.cancel(signal());
  assert.equal(sessions.snapshot().session?.status, 'stopping');
  await sessions.query(signal());
  await sessions.remove(signal());
  assert.deepEqual(
    requests.map((item) => item.path),
    [
      '/api/v2/session-definitions',
      '/api/v2/sessions',
      '/api/v2/sessions',
      `/api/v2/sessions/${first}/output?after=0&limit=50`,
      `/api/v2/sessions/${first}/input`,
      `/api/v2/sessions/${first}/eof`,
      `/api/v2/sessions/${first}/cancel`,
      `/api/v2/sessions/${first}`,
      `/api/v2/sessions/${first}`,
    ],
  );
  assert.deepEqual(requests[2]?.body, {
    operation: 'plugin.terminal.open',
    input: { profile: 'build-worker' },
  });
  assert.deepEqual(requests[4]?.body, { bytes: [0, 255, 10] });
  assert.equal(requests[8]?.method, 'DELETE');
  assert.equal(sessions.snapshot().session, null);
  assert.equal(sessions.snapshot().logs.input, 'input-log');
  assert.equal(sessions.snapshot().logs.eof, 'eof-log');
  assert.equal(sessions.snapshot().logs.remove, 'remove-log');
  sessions.dispose();
});

test('仅消费真实动态目录；部署profile不接受服务器程序路径或未知字段', async () => {
  let opens = 0;
  const sessions = createInteractiveSessions(
    gateway({
      open: async () => {
        opens++;
        return { data: info({ status: 'opening' }), logId: 'open-log' };
      },
    }),
  );
  assert.throws(() => sessions.openTerminal('worker', signal()), ApiError);
  await sessions.refreshDefinitions(signal());
  for (const profile of ['', 'C:/cmd.exe', '../worker', 'A', 'a'.repeat(65)])
    assert.throws(() => sessions.openTerminal(profile, signal()), ApiError);
  assert.throws(
    () =>
      sessions.open(
        { operation: 'plugin.terminal.open', input: { profile: 'worker', executable: 'cmd.exe' } },
        signal(),
      ),
    ApiError,
  );
  assert.throws(
    () => sessions.open({ operation: 'plugin.other.open', input: {} }, signal()),
    ApiError,
  );
  await sessions.openTerminal('worker', signal());
  assert.equal(opens, 1);
  sessions.dispose();
});

test('分页保留双路原字节和真实序号，游标排他且不重复追加', async () => {
  const queries: unknown[] = [];
  const sessions = createInteractiveSessions(
    gateway({
      output: async (id, query) => {
        queries.push({ id, ...query });
        return {
          data:
            query.after === 0
              ? page({
                  session: info({ output_sequence: 2 }),
                  chunks: [
                    { sequence: 1, stream: 'stdout', bytes: [0xe4, 0xb8] },
                    { sequence: 2, stream: 'stderr', bytes: [0xad, 255] },
                  ],
                  next_sequence: 2,
                })
              : page({ session: info({ output_sequence: 2 }), next_sequence: 2 }),
          logId: 'output-log',
        };
      },
    }),
  );
  await sessions.resume(first.toUpperCase(), signal());
  await sessions.readOutput({ limit: 2 }, signal());
  await sessions.readOutput({}, signal());
  assert.deepEqual(queries, [
    { id: first, after: 0, limit: 2 },
    { id: first, after: 2, limit: 50 },
  ]);
  assert.deepEqual(
    sessions.snapshot().chunks.map((chunk) => [chunk.sequence, chunk.stream, ...chunk.bytes]),
    [
      [1, 'stdout', 0xe4, 0xb8],
      [2, 'stderr', 0xad, 255],
    ],
  );
  assert.equal(sessions.snapshot().cursor, 2);
  assert.ok(Object.isFrozen(sessions.snapshot().chunks[0]?.bytes));
  sessions.dispose();
});

test('页缺口、错身份、错代次、错误游标和不安全序号拒绝且保留日志', async () => {
  const badPages: unknown[] = [
    page({ session: info({ id: second }) }),
    page({ session: info({ generation: 'generation-2' }) }),
    page({
      session: info({ output_sequence: 2 }),
      chunks: [{ sequence: 2, stream: 'stdout', bytes: [1] }],
      next_sequence: 2,
    }),
    page({ session: info({ output_sequence: 1 }), chunks: [], next_sequence: 0 }),
    page({ next_sequence: 1 }),
    page({ session: info({ output_sequence: Number.MAX_SAFE_INTEGER + 1 }) }),
    page({
      session: info({ output_sequence: 1 }),
      chunks: [{ sequence: 1, stream: 'stdout', bytes: [256] }],
      next_sequence: 1,
    }),
  ];
  for (const value of badPages) {
    const sessions = createInteractiveSessions(
      gateway({ output: async () => ({ data: value, logId: 'bad-page-log' }) }),
    );
    await sessions.resume(first, signal());
    await assert.rejects(
      sessions.readOutput({}, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'bad-page-log',
    );
    assert.equal(sessions.snapshot().cursor, 0);
    assert.equal(sessions.snapshot().chunks.length, 0);
    sessions.dispose();
  }
});

test('显式轮询耗尽Finished剩余输出，原completion证据完整保留', async () => {
  const queries: number[] = [];
  const completion = {
    outcome: null,
    cleanup: 'unconfirmed',
    process_exited: true,
    sequence: null,
    failure: { code: 'dependency_unavailable', message: '监督未确认' },
  };
  const sessions = createInteractiveSessions(
    gateway({
      output: async (_id, query) => {
        queries.push(query.after ?? 0);
        return {
          data: page({
            session: finished({
              output_sequence: 2,
              completion: { ...completion, cleanup: 'unconfirmed' },
            }),
            chunks: [{ sequence: (query.after ?? 0) + 1, stream: 'stdout', bytes: [1] }],
            next_sequence: (query.after ?? 0) + 1,
          }),
          logId: 'output-log',
        };
      },
    }),
    { pollIntervalMs: 1 },
  );
  await sessions.resume(first, signal());
  const result = await sessions.pollOutput({ limit: 1 }, signal());
  assert.deepEqual(queries, [0, 1]);
  assert.equal(result.data.status, 'finished');
  assert.deepEqual(sessions.snapshot().session?.completion, completion);
  assert.equal(sessions.snapshot().chunks.length, 2);
  sessions.dispose();
});

test('输入与EOF本地串行、单块限额、原字节副本与EOF后的输入拒绝', async () => {
  const pending = deferred<ApiResult<unknown>>();
  let seen: readonly number[] = [];
  const sessions = createInteractiveSessions(
    gateway({
      send: async (_id, bytes) => {
        seen = bytes;
        return pending.promise;
      },
    }),
  );
  await sessions.resume(first, signal());
  for (const bytes of [[-1], [256], [1.5], Array.from({ length: 8193 }, () => 0)])
    assert.throws(() => sessions.send(bytes, signal()), ApiError);
  const bytes = [0, 255];
  const writing = sessions.send(bytes, signal());
  bytes[0] = 7;
  assert.throws(() => sessions.eof(signal()), ApiError);
  assert.deepEqual(seen, [0, 255]);
  pending.resolve({ data: { id: first, accepted: true }, logId: 'input-log' });
  await writing;
  await sessions.eof(signal());
  assert.equal(sessions.snapshot().inputState, 'eof');
  assert.throws(() => sessions.send([1], signal()), ApiError);
  assert.throws(() => sessions.eof(signal()), ApiError);
  sessions.dispose();
});

test('输入等待取消及时结束且不自动停止、不重放，收据不确定状态显式呈现', async () => {
  const pending = deferred<ApiResult<unknown>>();
  let sends = 0;
  let cancels = 0;
  const sessions = createInteractiveSessions(
    gateway({
      send: async () => {
        sends++;
        return pending.promise;
      },
      cancel: async () => {
        cancels++;
        return { data: info({ status: 'stopping' }), logId: 'cancel-log' };
      },
    }),
  );
  await sessions.resume(first, signal());
  const controller = new AbortController();
  const writing = sessions.send([1], controller.signal);
  controller.abort();
  await assert.rejects(
    writing,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  assert.equal(sessions.snapshot().inputState, 'uncertain');
  assert.throws(() => sessions.send([1], signal()), ApiError);
  pending.resolve({ data: { id: first, accepted: true }, logId: 'late-input-log' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(cancels, 0);
  assert.equal(sessions.snapshot().logs.input, null);
  sessions.dispose();
});

test('切换会话与销毁撤销忽略信号的等待并拒绝晚到观测', async () => {
  const pending = deferred<ApiResult<unknown>>();
  const sessions = createInteractiveSessions(gateway({ output: async () => pending.promise }));
  await sessions.resume(first, signal());
  const reading = sessions.readOutput({}, signal());
  await sessions.resume(second, signal());
  await assert.rejects(reading, ApiError);
  pending.resolve({ data: page(), logId: 'late-output-log' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions.snapshot().session?.id, second);
  assert.equal(sessions.snapshot().logs.output, undefined);
  sessions.dispose();
  assert.equal(sessions.snapshot().session, null);
  assert.throws(() => sessions.resume(first, signal()), ApiError);
});

test('只有已观察Finished可删除；Stopping不冒充资源完成', async () => {
  let removes = 0;
  const sessions = createInteractiveSessions(
    gateway({
      remove: async (id) => {
        removes++;
        return { data: { id }, logId: 'remove-log' };
      },
    }),
  );
  await sessions.resume(first, signal());
  assert.throws(() => sessions.remove(signal()), ApiError);
  await sessions.cancel(signal());
  assert.equal(sessions.snapshot().session?.status, 'stopping');
  assert.equal(sessions.snapshot().session?.completion, null);
  assert.throws(() => sessions.send([1], signal()), ApiError);
  assert.throws(() => sessions.remove(signal()), ApiError);
  assert.equal(removes, 0);
  sessions.dispose();
});

test('恢复已知游标只读原会话，不重开；非法游标与旧ID失败保持空选择', async () => {
  let opens = 0;
  const queries: unknown[] = [];
  const sessions = createInteractiveSessions(
    gateway({
      open: async () => {
        opens++;
        return { data: info(), logId: 'open-log' };
      },
      get: async (id) => {
        if (id === second)
          throw new ApiError('http', 'not_found', '会话记录不存在', 404, 'missing-log');
        return { data: info({ output_sequence: 3 }), logId: 'resume-log' };
      },
      output: async (_id, query) => {
        queries.push(query);
        return {
          data: page({ session: info({ output_sequence: 3 }), next_sequence: 3 }),
          logId: 'output-log',
        };
      },
    }),
  );
  await sessions.resume(first, signal(), 3);
  assert.equal(sessions.snapshot().inputState, 'unknown');
  await sessions.readOutput({}, signal());
  assert.deepEqual(queries, [{ after: 3, limit: 50 }]);
  await assert.rejects(sessions.resume(first, signal(), 4), ApiError);
  assert.equal(sessions.snapshot().session, null);
  await assert.rejects(
    sessions.resume(second, signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'missing-log',
  );
  assert.equal(sessions.snapshot().session, null);
  assert.equal(opens, 0);
  sessions.dispose();
});

test('打开响应失联不重发，只通过显式记录目录定位服务器实际记录', async () => {
  let opens = 0;
  const pending = deferred<ApiResult<unknown>>();
  const sessions = createInteractiveSessions(
    gateway({
      open: async () => {
        opens++;
        return pending.promise;
      },
    }),
  );
  await sessions.refreshDefinitions(signal());
  const controller = new AbortController();
  const opening = sessions.openTerminal('worker', controller.signal);
  controller.abort();
  await assert.rejects(opening, ApiError);
  assert.equal(sessions.snapshot().session, null);
  await sessions.refreshRecords(signal());
  assert.equal(sessions.snapshot().records[0]?.id, first);
  pending.resolve({ data: info({ status: 'opening' }), logId: 'late-open-log' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sessions.snapshot().session, null);
  assert.equal(opens, 1);
  sessions.dispose();
});

test('终态查询及时撤销忽略信号的在途输入并拒绝晚收据', { timeout: 1000 }, async (context) => {
  const pending = deferred<ApiResult<unknown>>();
  const running = createInteractiveSessions(
    gateway({
      send: async () => pending.promise,
      get: async () => ({ data: info(), logId: 'query-log' }),
      output: async () => ({ data: page({ session: finished() }), logId: 'output-log' }),
    }),
  );
  context.after(() => running.dispose());
  await running.resume(first, signal());
  const sending = running.send([1], signal());
  await running.readOutput({}, signal());
  await assert.rejects(sending, ApiError);
  pending.resolve({ data: { id: first, accepted: true }, logId: 'late-input-log' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(running.snapshot().session?.status, 'finished');
  assert.equal(running.snapshot().logs.input, null);
});

test('轮询与输入并行，取消轮询定时等待保持最后日志且不停止服务器', async (context) => {
  const pageRead = deferred<void>();
  let cancels = 0;
  const sessions = createInteractiveSessions(
    gateway({
      output: async () => {
        pageRead.resolve();
        return { data: page(), logId: 'last-output-log' };
      },
      cancel: async () => {
        cancels++;
        return { data: info({ status: 'stopping' }), logId: 'cancel-log' };
      },
    }),
    { pollIntervalMs: 60000 },
  );
  context.after(() => sessions.dispose());
  await sessions.resume(first, signal());
  const controller = new AbortController();
  const polling = sessions.pollOutput({}, controller.signal);
  await pageRead.promise;
  await sessions.send([1], signal());
  controller.abort();
  await assert.rejects(polling, ApiError);
  assert.equal(sessions.snapshot().logs.output, 'last-output-log');
  assert.equal(sessions.snapshot().logs.input, 'input-log');
  assert.equal(cancels, 0);
  sessions.dispose();
});

test('拒绝稀疏输入字节、未知读取字段、非法页长与取消信号，不发送请求', async () => {
  let sends = 0;
  let reads = 0;
  const sessions = createInteractiveSessions(
    gateway({
      send: async (id) => {
        sends++;
        return { data: { id, accepted: true }, logId: 'input-log' };
      },
      output: async () => {
        reads++;
        return { data: page(), logId: 'output-log' };
      },
    }),
  );
  await sessions.resume(first, signal());
  const sparse: number[] = [];
  sparse.length = 2;
  assert.throws(() => sessions.send(sparse, signal()), ApiError);
  for (const limit of [0, 101, 1.5, Infinity])
    assert.throws(() => sessions.readOutput({ limit }, signal()), ApiError);
  const unknown = { limit: 50, after: 0 };
  assert.throws(() => sessions.readOutput(unknown, signal()), ApiError);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => sessions.send([1], controller.signal), ApiError);
  assert.equal(sends, 0);
  assert.equal(reads, 0);
  sessions.dispose();
});

test('晚到Running输出不回退并行停止的Stopping状态，但仍收取原输出', async () => {
  const pending = deferred<ApiResult<unknown>>();
  const sessions = createInteractiveSessions(gateway({ output: async () => pending.promise }));
  await sessions.resume(first, signal());
  const reading = sessions.readOutput({}, signal());
  await sessions.cancel(signal());
  pending.resolve({
    data: page({
      session: info({ output_sequence: 1 }),
      chunks: [{ sequence: 1, stream: 'stdout', bytes: [255] }],
      next_sequence: 1,
    }),
    logId: 'output-log',
  });
  await reading;
  assert.equal(sessions.snapshot().session?.status, 'stopping');
  assert.equal(sessions.snapshot().session?.output_sequence, 1);
  assert.equal(sessions.snapshot().cursor, 1);
  assert.equal(sessions.snapshot().logs.cancel, 'cancel-log');
  assert.equal(sessions.snapshot().logs.output, 'output-log');
  sessions.dispose();
});

test('坏收据、缺失终态、Complete但直接进程未退出均拒绝并保留响应日志', async () => {
  for (const receipt of [
    { id: second, accepted: true },
    { id: first, accepted: false },
    { id: first },
  ]) {
    const sessions = createInteractiveSessions(
      gateway({ send: async () => ({ data: receipt, logId: 'bad-receipt-log' }) }),
    );
    await sessions.resume(first, signal());
    await assert.rejects(
      sessions.send([1], signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'bad-receipt-log',
    );
    assert.equal(sessions.snapshot().inputState, 'uncertain');
    sessions.dispose();
  }
  for (const record of [
    info({ status: 'finished' }),
    finished({ completion: { cleanup: 'complete', process_exited: false } }),
  ]) {
    const sessions = createInteractiveSessions(
      gateway({ get: async () => ({ data: record, logId: 'bad-completion-log' }) }),
    );
    await assert.rejects(
      sessions.resume(first, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'bad-completion-log',
    );
    assert.equal(sessions.snapshot().session, null);
    sessions.dispose();
  }
});

test('目录变更失去操作后拒绝新打开，目录及记录副本冻结且重复身份拒绝', async () => {
  const source = definitions();
  let empty = false;
  let duplicated = false;
  const sessions = createInteractiveSessions(
    gateway({
      definitions: async () => ({
        data: empty ? { revision: 2, sessions: [] } : source,
        logId: 'definitions-log',
      }),
      list: async () => ({ data: duplicated ? [info(), info()] : [info()], logId: 'records-log' }),
    }),
  );
  await sessions.refreshDefinitions(signal());
  source.sessions.splice(0);
  assert.equal(sessions.snapshot().definitions?.sessions[0]?.title, '终端');
  assert.ok(Object.isFrozen(sessions.snapshot().definitions?.sessions));
  await sessions.refreshRecords(signal());
  assert.ok(Object.isFrozen(sessions.snapshot().records[0]));
  duplicated = true;
  await assert.rejects(
    sessions.refreshRecords(signal()),
    (error: unknown) => error instanceof ApiError && error.logId === 'records-log',
  );
  assert.equal(sessions.snapshot().records.length, 0);
  empty = true;
  await sessions.refreshDefinitions(signal());
  assert.throws(() => sessions.openTerminal('worker', signal()), ApiError);
  sessions.dispose();
});

test('订阅重入清除立即停止旧通知与结果交付，异常订阅隔离', async () => {
  const sessions = createInteractiveSessions(gateway());
  let oldNotifications = 0;
  sessions.subscribe(() => {
    throw new Error('坏订阅');
  });
  const release = sessions.subscribe((snapshot) => {
    if (snapshot.session) sessions.clear();
  });
  sessions.subscribe((snapshot) => {
    if (snapshot.session) oldNotifications++;
  });
  await assert.rejects(sessions.resume(first, signal()), ApiError);
  assert.equal(sessions.snapshot().session, null);
  assert.equal(oldNotifications, 0);
  release();
  await sessions.resume(first, signal());
  assert.equal(sessions.snapshot().session?.id, first);
  sessions.dispose();
});

test('dispose撤销永不返回的轮询并消费晚拒绝，资源停止只由显式cancel发起', async () => {
  const pending = deferred<ApiResult<unknown>>();
  let cancels = 0;
  const sessions = createInteractiveSessions(
    gateway({
      output: async () => pending.promise,
      cancel: async () => {
        cancels++;
        return { data: info({ status: 'stopping' }), logId: 'cancel-log' };
      },
    }),
  );
  await sessions.resume(first, signal());
  const reading = sessions.pollOutput({}, signal());
  sessions.dispose();
  sessions.dispose();
  await assert.rejects(
    reading,
    (error: unknown) => error instanceof ApiError && error.kind === 'cancelled',
  );
  pending.reject(new Error('晚到拒绝'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancels, 0);
  assert.equal(sessions.snapshot().session, null);
  assert.throws(() => sessions.subscribe(() => {}), ApiError);
});
