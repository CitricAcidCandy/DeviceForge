import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFrontendRuntime } from '../src/app/index.ts';
import { createHostContext } from '../src/app/host-context.ts';
import {
  createTaskHistoryGateway,
  publicHistoricalJob,
  publicJobEvents,
} from '../src/app/task-history-gateway.ts';
import type { TaskHistoryTransport } from '../src/app/task-history-gateway.ts';
import { createOperations } from '../src/features/operations/index.ts';
import { createTasks } from '../src/features/tasks/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, HostResult, TaskHistoryAccess } from '../src/plugin-sdk/index.ts';
import { createPluginScope } from '../src/plugins/scope.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ApiResult, JobDto, JobEventDto } from '../src/services/api/index.ts';
import { deferred, failure, job, plugin, requestUrl, signal, success } from './fixtures.ts';

const runtimeOptions = { baseUrl: 'http://localhost:7031', panelTarget: () => null };
const record: JobDto = {
  ...job('job-history'),
  operation: 'retired.run',
  input: { artifact_id: 'artifact-old', device: '原设备' },
  created_at: 123,
  status: 'succeeded',
  result: { result: { value: 7 }, artifacts: [] },
};
const events: JobEventDto[] = [
  { job_id: record.id, sequence: 2, status: 'running', timestamp: 9 },
  { job_id: record.id, sequence: 8, status: 'succeeded', timestamp: 0 },
];
type Entry = 'list' | 'get' | 'events';
const entries: readonly Entry[] = ['list', 'get', 'events'];
function query(access: TaskHistoryAccess, entry: Entry, caller: AbortSignal): Promise<unknown> {
  switch (entry) {
    case 'list':
      return access.list({}, caller);
    case 'get':
      return access.get(record.id, caller);
    case 'events':
      return access.events(record.id, {}, caller);
  }
}
function cancelled(error: unknown): boolean {
  assert.ok(error instanceof HostError);
  assert.equal(error.kind, 'cancelled');
  return true;
}
function protocol(code: string, logId: string | null) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HostError);
    assert.equal(error.kind, 'protocol');
    assert.equal(error.code, code);
    assert.equal(error.logId, logId);
    return true;
  };
}
function immediateTransport(): TaskHistoryTransport {
  return {
    list: async () => ({ data: [record], logId: 'history-log' }),
    get: async () => ({ data: record, logId: 'history-log' }),
    events: async () => ({ data: events, logId: 'events-log' }),
  };
}

test('旧API2上下文省略taskHistory，不补伪实现且旧createHostContext调用兼容', async () => {
  const client = createApiClient({ ...runtimeOptions, transport: async () => success([]) });
  const operations = createOperations(client);
  const tasks = createTasks(client);
  const host = createHostContext(operations, tasks, new AbortController());
  const context: HostContext = host.context;
  const scope = createPluginScope(context);
  try {
    assert.equal(context.apiVersion, 2);
    assert.equal(Object.hasOwn(context, 'taskHistory'), false);
    assert.equal(Object.hasOwn(scope.context, 'taskHistory'), false);
    assert.deepEqual((await context.listOperations(signal())).data, []);
  } finally {
    await scope.dispose();
    await host.dispose();
    operations.dispose();
    tasks.dispose();
  }
});

test('runtime公开历史沿真实client映射原字段与日志，旧Job和原tasks端口保持形状', async () => {
  const seen: string[] = [];
  const runtime = createFrontendRuntime({
    ...runtimeOptions,
    transport: async (input) => {
      const url = requestUrl(input);
      seen.push(url.pathname + url.search);
      if (url.pathname.endsWith('/events')) return success(events, 'events-log');
      if (url.pathname === '/api/v2/jobs') return success([record], 'list-log');
      return success(record, 'get-log');
    },
  });
  const scope = createPluginScope(runtime.host);
  try {
    const history = scope.context.taskHistory;
    assert.ok(history);
    assert.notEqual(history, runtime.tasks);
    assert.deepEqual(Object.keys(history).sort(), ['events', 'get', 'list']);
    const listed = await history.list({ limit: 1 }, signal());
    assert.equal(listed.logId, 'list-log');
    assert.equal(Object.isFrozen(listed.data), true);
    const current = await history.get(record.id, signal());
    assert.deepEqual(current.data, {
      id: record.id,
      operation: record.operation,
      status: record.status,
      result: record.result,
      error: null,
      input: record.input,
      createdAt: record.created_at,
    });
    assert.equal(current.logId, 'get-log');
    assert.equal(Object.isFrozen(current.data), true);
    const eventResult = await history.events(record.id, { after: 1 }, signal());
    assert.deepEqual(eventResult.data, [
      { jobId: record.id, sequence: 2, status: 'running', timestamp: 9 },
      { jobId: record.id, sequence: 8, status: 'succeeded', timestamp: 0 },
    ]);
    assert.equal(eventResult.logId, 'events-log');
    assert.equal(Object.isFrozen(eventResult.data), true);
    assert.equal(Object.isFrozen(eventResult.data[0]), true);
    const legacy = await runtime.host.getJob(record.id, signal());
    assert.deepEqual(Object.keys(legacy.data).sort(), [
      'error',
      'id',
      'operation',
      'result',
      'status',
    ]);
    assert.equal(Object.hasOwn(legacy.data, 'input'), false);
    assert.deepEqual((await runtime.tasks.get(record.id, signal())).data, record);
    assert.ok(seen.includes('/api/v2/jobs?limit=1'));
    assert.ok(seen.includes('/api/v2/jobs/' + record.id + '/events?after=1'));
    assert.equal(
      seen.some((path) => path.includes('cancel') || path.includes('operations')),
      false,
    );
  } finally {
    await scope.dispose();
    await runtime.dispose();
  }
});

test('查询缺省原样交服务端，显式边界允许且发起后不受caller选项变更影响', async () => {
  const observed: unknown[] = [];
  const transport = immediateTransport();
  const access = createTaskHistoryGateway(
    {
      ...transport,
      async list(input) {
        observed.push(input);
        return { data: [], logId: null };
      },
      async events(id, input) {
        observed.push({ id, ...input });
        return { data: [], logId: null };
      },
    },
    signal(),
  );
  await access.list({}, signal());
  await access.events(record.id, {}, signal());
  await access.list({ limit: 1 }, signal());
  await access.list({ limit: 200 }, signal());
  await access.events(record.id, { after: Number.MAX_SAFE_INTEGER }, signal());
  const input = { after: 1 };
  const pending = access.events(record.id, input, signal());
  input.after = 99;
  await pending;
  assert.deepEqual(observed, [
    {},
    { id: record.id },
    { limit: 1 },
    { limit: 200 },
    { id: record.id, after: Number.MAX_SAFE_INTEGER },
    { id: record.id, after: 1 },
  ]);
});

test('非法本地limit/after/标识零传输且不伪造日志，合法标识保持原文', async () => {
  let requests = 0;
  let expectedId = record.id;
  const transport: TaskHistoryTransport = {
    async list() {
      ++requests;
      return { data: [], logId: null };
    },
    async get(id) {
      ++requests;
      assert.equal(id, expectedId);
      return { data: { ...record, id }, logId: 'id-log' };
    },
    async events() {
      ++requests;
      return { data: [], logId: null };
    },
  };
  const access = createTaskHistoryGateway(transport, signal());
  for (const limit of [0, -1, 201, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(access.list({ limit }, signal()), protocol('invalid_history_query', null));
  }
  for (const after of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      access.events(record.id, { after }, signal()),
      protocol('invalid_history_query', null),
    );
  }
  for (const id of ['', ' \t ', '.', '..']) {
    await assert.rejects(access.get(id, signal()), protocol('invalid_history_query', null));
    await assert.rejects(access.events(id, {}, signal()), protocol('invalid_history_query', null));
  }
  assert.equal(requests, 0);
  expectedId = ' job/原文 ';
  assert.equal((await access.get(expectedId, signal())).data.id, expectedId);
  assert.equal(requests, 1);
});

test('非法历史整数/input/result及get关联拒绝整次映射，保留响应日志', async () => {
  let selected: JobDto = record;
  const access = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      list: async () => ({ data: [record, selected], logId: 'history-invalid-log' }),
      get: async () => ({ data: selected, logId: 'history-invalid-log' }),
    },
    signal(),
  );
  const malformed: readonly JobDto[] = [
    { ...record, id: ' ' },
    { ...record, created_at: -1 },
    { ...record, created_at: 0.5 },
    { ...record, created_at: Infinity },
    { ...record, created_at: Number.MAX_SAFE_INTEGER + 1 },
    { ...record, input: new Date() },
    { ...record, result: { value: Infinity } },
  ];
  for (const row of malformed) {
    selected = row;
    await assert.rejects(
      access.list({}, signal()),
      protocol('invalid_history', 'history-invalid-log'),
    );
    await assert.rejects(
      access.get(record.id, signal()),
      protocol('invalid_history', 'history-invalid-log'),
    );
  }
  selected = { ...record, id: record.id + '-other' };
  await assert.rejects(
    access.get(record.id, signal()),
    protocol('invalid_history', 'history-invalid-log'),
  );
  selected = { ...record, created_at: 0, input: null, result: null };
  assert.equal((await access.get(record.id, signal())).data.createdAt, 0);
  assert.equal(publicHistoricalJob(selected).result, null);
});

test('事件允许序号间隙和非单调时间；错jobId/重复/倒序/不安全整数拒绝整次响应', async () => {
  let selected: JobEventDto[] = events;
  const access = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      events: async () => ({ data: selected, logId: 'event-invalid-log' }),
    },
    signal(),
  );
  const first = events[0];
  const second = events[1];
  assert.ok(first);
  assert.ok(second);
  const malformed: readonly JobEventDto[][] = [
    [{ ...first, job_id: record.id + '-other' }],
    [{ ...first, job_id: ' ' }],
    [{ ...first, sequence: 0 }],
    [{ ...first, sequence: -1 }],
    [{ ...first, sequence: 1.5 }],
    [{ ...first, sequence: NaN }],
    [{ ...first, sequence: Number.MAX_SAFE_INTEGER + 1 }],
    [first, first],
    [second, first],
    [first, { ...second, timestamp: -1 }],
    [{ ...first, timestamp: 0.5 }],
    [{ ...first, timestamp: Infinity }],
    [{ ...first, timestamp: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const rows of malformed) {
    selected = rows;
    await assert.rejects(
      access.events(record.id, {}, signal()),
      protocol('invalid_job_events', 'event-invalid-log'),
    );
  }
  selected = [first];
  await assert.rejects(
    access.events(record.id, { after: first.sequence }, signal()),
    protocol('invalid_job_events', 'event-invalid-log'),
  );
  selected = events;
  assert.deepEqual(
    (await access.events(record.id, { after: 1 }, signal())).data.map((event) => event.sequence),
    [2, 8],
  );
  selected = [{ ...first, sequence: Number.MAX_SAFE_INTEGER, timestamp: Number.MAX_SAFE_INTEGER }];
  assert.equal(
    (await access.events(record.id, {}, signal())).data[0]?.sequence,
    Number.MAX_SAFE_INTEGER,
  );
  selected = [];
  assert.deepEqual((await access.events(record.id, {}, signal())).data, []);
  assert.deepEqual(publicJobEvents([], record.id, 0), []);
});

test('历史和事件HTTP错误保留code/status/retryAfter/logId，网络失败日志为null', async () => {
  let network = false;
  const runtime = createFrontendRuntime({
    ...runtimeOptions,
    transport: async () => {
      if (network) throw new Error('传输失败');
      const response = failure('job_missing', 404);
      response.headers.set('retry-after', '2');
      return response;
    },
  });
  try {
    const access = runtime.host.taskHistory;
    assert.ok(access);
    for (const entry of entries) {
      await assert.rejects(query(access, entry, signal()), (error: unknown) => {
        assert.ok(error instanceof HostError);
        assert.equal(error.kind, 'http');
        assert.equal(error.code, 'job_missing');
        assert.equal(error.status, 404);
        assert.equal(error.retryAfter, '2');
        assert.equal(error.logId, 'log-error');
        return true;
      });
    }
    network = true;
    await assert.rejects(access.get(record.id, signal()), (error: unknown) => {
      assert.ok(error instanceof HostError);
      assert.equal(error.kind, 'network');
      assert.equal(error.logId, null);
      return true;
    });
  } finally {
    await runtime.dispose();
  }
});

test('caller预取消和runtime关闭后三入口零传输，不调用服务器取消或删除历史', async () => {
  let requests = 0;
  const runtime = createFrontendRuntime({
    ...runtimeOptions,
    transport: async () => {
      ++requests;
      return success(record);
    },
  });
  const caller = new AbortController();
  caller.abort();
  try {
    const access = runtime.host.taskHistory;
    assert.ok(access);
    for (const entry of entries)
      await assert.rejects(query(access, entry, caller.signal), cancelled);
    assert.equal(requests, 0);
    await runtime.dispose();
    for (const entry of entries) await assert.rejects(query(access, entry, signal()), cancelled);
    assert.equal(requests, 0);
  } finally {
    await runtime.dispose();
  }
});

test(
  '三入口忽略信号并永不返回时caller/runtime取消均及时结束等待，晚结果不交付',
  { timeout: 5000 },
  async () => {
    for (const entry of entries) {
      for (const cause of ['caller', 'runtime']) {
        const gate = deferred<void>();
        const entered = deferred<AbortSignal>();
        const lifetime = new AbortController();
        const caller = new AbortController();
        async function wait<T>(data: T, current: AbortSignal): Promise<ApiResult<T>> {
          entered.resolve(current);
          await gate.promise;
          return { data, logId: 'late-log' };
        }
        const access = createTaskHistoryGateway(
          {
            list: (_query, current) => wait([record], current),
            get: (_id, current) => wait(record, current),
            events: (_id, _query, current) => wait(events, current),
          },
          lifetime.signal,
        );
        const pending = query(access, entry, caller.signal);
        const rejected = assert.rejects(pending, cancelled);
        try {
          const current = await entered.promise;
          if (cause === 'caller') caller.abort();
          else lifetime.abort();
          assert.equal(current.aborted, true);
          await rejected;
        } finally {
          gate.resolve();
          lifetime.abort();
        }
        await assert.rejects(pending, cancelled);
      }
    }
  },
);

test('取消后端口晚拒绝被消费，同步取消重入/同步抛错也安全收口', { timeout: 5000 }, async () => {
  const gate = deferred<ApiResult<JobDto>>();
  const entered = deferred<AbortSignal>();
  const lifetime = new AbortController();
  const access = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      get: (_id, current) => {
        entered.resolve(current);
        return gate.promise;
      },
    },
    lifetime.signal,
  );
  const pending = access.get(record.id, signal());
  const rejected = assert.rejects(pending, cancelled);
  await entered.promise;
  lifetime.abort();
  await rejected;
  gate.reject(new Error('取消后的晚拒绝'));
  // 让真实Promise拒绝处理器全部运行；不使用长sleep或伪造通过结果。
  await setImmediate();
  const reentrant = new AbortController();
  const late = deferred<ApiResult<JobDto>>();
  const second = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      get() {
        reentrant.abort();
        return late.promise;
      },
    },
    reentrant.signal,
  );
  await assert.rejects(second.get(record.id, signal()), cancelled);
  late.reject(new Error('同步取消之后的拒绝'));
  await setImmediate();
  const aborted = new AbortController();
  const third = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      get() {
        aborted.abort();
        throw new ApiError('http', 'obsolete_error', '同步取消后旧失败', 503, 'obsolete-log');
      },
    },
    aborted.signal,
  );
  await assert.rejects(third.get(record.id, signal()), cancelled);
  const failed = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      get() {
        throw new ApiError('http', 'injected_failure', '公开错误', 503, 'sync-log', '3');
      },
    },
    signal(),
  );
  await assert.rejects(failed.get(record.id, signal()), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'injected_failure');
    assert.equal(error.logId, 'sync-log');
    assert.equal(error.status, 503);
    assert.equal(error.retryAfter, '3');
    return true;
  });
});

test('已取得响应后映射期间撤销拒绝交付，保留该次真实日志', async () => {
  const lifetime = new AbortController();
  const input = Object.defineProperty({}, 'cancel', {
    enumerable: true,
    get() {
      lifetime.abort();
      return true;
    },
  });
  const access = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      get: async () => ({ data: { ...record, input }, logId: 'accepted-response-log' }),
    },
    lifetime.signal,
  );
  await assert.rejects(access.get(record.id, signal()), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.kind, 'cancelled');
    assert.equal(error.code, 'stale_result');
    assert.equal(error.logId, 'accepted-response-log');
    return true;
  });
});

test('scoped历史已取得结果后退出保留响应日志，旧引用仍零调用且不补造日志', async () => {
  const runtime = createFrontendRuntime({
    ...runtimeOptions,
    transport: async () => success(record),
  });
  try {
    for (const logId of ['scoped-response-log', null]) {
      let requests = 0;
      const completed = deferred<HostResult<ReturnType<typeof publicHistoricalJob>>>();
      const reply = { data: publicHistoricalJob(record), logId };
      const upstream: TaskHistoryAccess = {
        list: async () => {
          ++requests;
          return { data: [], logId: null };
        },
        get: () => {
          ++requests;
          return completed.promise;
        },
        events: async () => {
          ++requests;
          return { data: [], logId: null };
        },
      };
      const scope = createPluginScope({ ...runtime.host, taskHistory: upstream });
      // 先登记此反应：它排入退出微任务，随后等待器接受结果并移除取消监听，
      // 退出必定先于scope的await续执行；不用sleep猜测交付前关闭窗口。
      const closing = completed.promise.then(() => {
        queueMicrotask(() => scope.close());
      });
      try {
        const history = scope.context.taskHistory;
        assert.ok(history);
        const pending = history.get(record.id, signal());
        const rejected = assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof HostError);
          assert.equal(error.kind, 'cancelled');
          assert.equal(error.code, 'plugin_unloaded');
          assert.equal(error.logId, logId);
          assert.equal(error.status, null);
          return true;
        });
        assert.equal(requests, 1);
        completed.resolve(reply);
        await rejected;
        await closing;
        assert.equal(scope.context.signal.aborted, true);
        for (const entry of entries) {
          await assert.rejects(query(history, entry, signal()), (error: unknown) => {
            assert.ok(error instanceof HostError);
            assert.equal(error.kind, 'cancelled');
            assert.equal(error.code, 'plugin_unloaded');
            assert.equal(error.logId, null);
            return true;
          });
        }
        assert.equal(requests, 1);
      } finally {
        completed.resolve(reply);
        await closing;
        await scope.dispose();
      }
    }
  } finally {
    await runtime.dispose();
  }
});

test(
  '自建旧宿主历史端口无视信号时，caller和实例退出均取消三入口；晚拒绝安全消费',
  { timeout: 5000 },
  async () => {
    const runtime = createFrontendRuntime({
      ...runtimeOptions,
      transport: async () => success(record),
    });
    try {
      for (const entry of entries) {
        for (const cause of ['caller', 'plugin']) {
          const gate = deferred<void>();
          const entered = deferred<AbortSignal>();
          const caller = new AbortController();
          async function wait<T>(data: T, current: AbortSignal): Promise<HostResult<T>> {
            entered.resolve(current);
            await gate.promise;
            return { data, logId: 'late-public-log' };
          }
          const history: TaskHistoryAccess = {
            list: (_query, current) => wait([publicHistoricalJob(record)], current),
            get: (_id, current) => wait(publicHistoricalJob(record), current),
            events: (_id, _query, current) => wait(publicJobEvents(events, record.id, 0), current),
          };
          const scope = createPluginScope({ ...runtime.host, taskHistory: history });
          try {
            const access = scope.context.taskHistory;
            assert.ok(access);
            const pending = query(access, entry, caller.signal);
            const rejected = assert.rejects(pending, cancelled);
            const current = await entered.promise;
            if (cause === 'caller') caller.abort();
            else scope.close();
            assert.equal(current.aborted, true);
            await rejected;
            gate.reject(new Error('旧宿主端口取消之后晚拒绝'));
            await setImmediate();
            await assert.rejects(pending, cancelled);
          } finally {
            gate.resolve();
            await scope.dispose();
          }
        }
      }
    } finally {
      await runtime.dispose();
    }
  },
);

test(
  '挂载子作用域退出立即取消查询，不关闭兄弟；父代撤销后旧引用零调用',
  { timeout: 5000 },
  async () => {
    let requests = 0;
    let delayed = true;
    const gate = deferred<void>();
    const entered = deferred<AbortSignal>();
    const runtime = createFrontendRuntime({
      ...runtimeOptions,
      transport: async () => success(record),
    });
    const upstream: TaskHistoryAccess = {
      list: async () => ({ data: [], logId: null }),
      async get(_id, current) {
        ++requests;
        if (delayed) {
          entered.resolve(current);
          await gate.promise;
        }
        return { data: publicHistoricalJob(record), logId: 'sibling-history-log' };
      },
      events: async () => ({ data: [], logId: null }),
    };
    const parent = createPluginScope({ ...runtime.host, taskHistory: upstream });
    const child = createPluginScope(parent.context);
    const sibling = createPluginScope(parent.context);
    try {
      const childAccess = child.context.taskHistory;
      const siblingAccess = sibling.context.taskHistory;
      assert.ok(childAccess);
      assert.ok(siblingAccess);
      const pending = childAccess.get(record.id, signal());
      const rejected = assert.rejects(pending, cancelled);
      const current = await entered.promise;
      child.close();
      assert.equal(current.aborted, true);
      await rejected;
      assert.equal(parent.context.signal.aborted, false);
      assert.equal(sibling.context.signal.aborted, false);
      delayed = false;
      assert.equal((await siblingAccess.get(record.id, signal())).logId, 'sibling-history-log');
      parent.close();
      assert.equal(sibling.context.signal.aborted, true);
      for (const access of [childAccess, siblingAccess]) {
        for (const entry of entries)
          await assert.rejects(query(access, entry, signal()), cancelled);
      }
      assert.equal(requests, 2);
      gate.resolve();
      await assert.rejects(pending, cancelled);
    } finally {
      gate.resolve();
      await child.dispose();
      await sibling.dispose();
      await parent.dispose();
      await runtime.dispose();
    }
  },
);

test(
  'manager同ID卸载重载后历史代理换代，旧引用不复活且不会自动取消服务器Job',
  { timeout: 5000 },
  async () => {
    let requests = 0;
    let delayed = true;
    const gate = deferred<Response>();
    const entered = deferred<AbortSignal>();
    const runtime = createFrontendRuntime({
      ...runtimeOptions,
      transport: async (input, init) => {
        ++requests;
        assert.equal(requestUrl(input).pathname, '/api/v2/jobs/' + record.id);
        if (delayed) {
          assert.ok(init?.signal);
          entered.resolve(init.signal);
          return gate.promise;
        }
        return success(record, 'new-history-log');
      },
    });
    const contexts: HostContext[] = [];
    const id = 'history_consumer';
    runtime.webPlugins.register({
      id,
      trusted: true,
      plugin: {
        id,
        version: '1.0',
        apiVersion: 2,
        panels: [],
        async activate(context) {
          contexts.push(context);
        },
      },
    });
    try {
      const before = await runtime.webPlugins.load(id);
      const old = contexts[0]?.taskHistory;
      assert.ok(old);
      const pending = old.get(record.id, signal());
      const rejected = assert.rejects(pending, cancelled);
      const current = await entered.promise;
      await runtime.webPlugins.unload(id);
      assert.equal(current.aborted, true);
      await rejected;
      delayed = false;
      const after = await runtime.webPlugins.load(id);
      assert.notEqual(before.generation, after.generation);
      const next = contexts[1]?.taskHistory;
      assert.ok(next);
      assert.notEqual(next, old);
      assert.equal((await next.get(record.id, signal())).logId, 'new-history-log');
      for (const entry of entries) await assert.rejects(query(old, entry, signal()), cancelled);
      assert.equal(requests, 2);
    } finally {
      gate.resolve(success(record, 'old-late-log'));
      await runtime.dispose();
    }
  },
);

test('管理撤销旧服务器插件与当前目录换代后历史仍按持久化响应读取，不补当前元数据', async () => {
  const seen: string[] = [];
  const runtime = createFrontendRuntime({
    ...runtimeOptions,
    transport: async (input) => {
      const path = requestUrl(input).pathname;
      seen.push(path);
      if (path === '/api/v2/plugins/retired/unload')
        return success(plugin({ id: 'retired', state: 'unloaded', operations: ['retired.run'] }));
      if (path === '/api/v2/operations')
        return success([
          {
            id: record.operation,
            title: '新代声明',
            input_schema: {},
            execution: { api_version: 1, total_timeout_ms: 120000, source: 'declared' },
          },
        ]);
      if (path === '/api/v2/jobs') return success([record], 'persistent-list-log');
      if (path.startsWith('/api/v2/jobs/')) return success(record, 'persistent-get-log');
      return success([]);
    },
  });
  try {
    const history = runtime.host.taskHistory;
    assert.ok(history);
    const before = (await history.get(record.id, signal())).data;
    await runtime.serverPlugins.unload('retired', signal());
    const after = (await history.list({}, signal())).data[0];
    assert.ok(after);
    assert.deepEqual(after, before);
    for (const name of ['execution', 'provider', 'generation', 'rawState'])
      assert.equal(Object.hasOwn(after, name), false);
    assert.equal(
      seen.some((path) => path.endsWith('/cancel')),
      false,
    );
  } finally {
    await runtime.dispose();
  }
});

test('并发查询互不撤销且无共享历史缓存，每次结果已交付后不追溯改变', async () => {
  const first = deferred<ApiResult<JobDto>>();
  const second = deferred<ApiResult<JobDto>>();
  let requests = 0;
  const lifetime = new AbortController();
  const access = createTaskHistoryGateway(
    {
      ...immediateTransport(),
      get: (id) => {
        ++requests;
        return id === 'job-a' ? first.promise : second.promise;
      },
    },
    lifetime.signal,
  );
  const a = access.get('job-a', signal());
  const b = access.get('job-b', signal());
  second.resolve({ data: { ...record, id: 'job-b' }, logId: 'b-log' });
  const acceptedB = await b;
  first.resolve({ data: { ...record, id: 'job-a' }, logId: 'a-log' });
  assert.equal((await a).data.id, 'job-a');
  assert.equal(acceptedB.data.id, 'job-b');
  lifetime.abort();
  assert.equal(await b, acceptedB);
  assert.equal(requests, 2);
});
