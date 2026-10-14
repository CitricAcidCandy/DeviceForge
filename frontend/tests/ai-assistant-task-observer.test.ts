import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAiTaskObserver,
  createHttpAiTaskGateway,
} from '../src/features/ai-assistant/index.ts';
import type { AiTaskGateway, AiTaskObservation } from '../src/features/ai-assistant/index.ts';
import { ApiError, createApiClient } from '../src/services/api/index.ts';
import type { ApiResult, JobEventDto } from '../src/services/api/index.ts';
import type { JobTicket, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const operation = 'plugin.ai-assistant.cli.turn';
const ticket: JobTicket = { id: 'ai-job-1', operation, submitLogId: 'submit-log' };
function record(id = ticket.id): TaskRecord {
  return { id, operation, status: 'running', error: null, result: null };
}
function event(sequence: number, id = ticket.id): JobEventDto {
  return { job_id: id, sequence, timestamp: sequence, status: 'running' };
}
function gateway(overrides: Partial<AiTaskGateway> = {}): AiTaskGateway {
  return {
    submit: async () => {
      throw new Error('观测不得提交提示词');
    },
    getJob: async (id) => ({ data: record(id), logId: 'job-query-log' }),
    cancelJob: async () => {
      throw new Error('取消等待不得取消服务端任务');
    },
    getEvents: async () => ({ data: [event(1)], logId: 'events-query-log' }),
    ...overrides,
  };
}
const cancelled = (error: unknown) => error instanceof ApiError && error.kind === 'cancelled';

test('观测任务状态与增量事件，保留两次响应日志且不推断原子状态', async () => {
  const queries: { id: string; after?: number }[] = [];
  const observer = createAiTaskObserver(
    gateway({
      getEvents: async (id, query) => {
        queries.push({ id, ...query });
        return {
          data: [{ ...event(5), status: 'succeeded', timestamp: 0 }],
          logId: 'event-terminal-log',
        };
      },
    }),
  );
  const reply = await observer.select(ticket, { after: 2 }, signal());
  assert.equal(reply.data.job.status, 'running');
  assert.equal(reply.data.events[0]?.status, 'succeeded');
  assert.equal(reply.data.after, 5);
  assert.equal(reply.data.jobLogId, 'job-query-log');
  assert.equal(reply.data.eventsLogId, 'event-terminal-log');
  assert.equal(reply.logId, 'event-terminal-log');
  assert.equal(reply.data.ticket.submitLogId, 'submit-log');
  assert.deepEqual(queries, [{ id: ticket.id, after: 2 }]);
  assert.equal(observer.snapshot().result, reply);
  observer.dispose();
});

test('空事件保留原游标，五个正式操作均可查询且无任务重发', async () => {
  const observer = createAiTaskObserver(
    gateway({
      getJob: async () => ({ data: record(), logId: 'status-log' }),
      getEvents: async () => ({ data: [], logId: 'empty-events-log' }),
    }),
  );
  assert.equal((await observer.select(ticket, { after: 8 }, signal())).data.after, 8);
  observer.dispose();
  for (const action of [
    'runtime.status',
    'cli.single',
    'cli.turn',
    'session.get',
    'session.close',
  ]) {
    const current = { ...ticket, operation: `plugin.ai-assistant.${action}` };
    const selected = createAiTaskObserver(
      gateway({
        getJob: async () => ({ data: { ...record(), operation: current.operation }, logId: null }),
      }),
    );
    assert.equal(
      (await selected.select(current, {}, signal())).data.job.operation,
      current.operation,
    );
    selected.dispose();
  }
});

test('取消在途任务读取立即结束，忽略信号的晚到回应不读取事件或发布', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<TaskRecord>>();
  let eventReads = 0;
  let requestSignal: AbortSignal | undefined;
  const observer = createAiTaskObserver(
    gateway({
      getJob: async (_id, current) => {
        requestSignal = current;
        entered.resolve();
        return blocked.promise;
      },
      getEvents: async () => {
        eventReads++;
        return { data: [], logId: null };
      },
    }),
  );
  const controller = new AbortController();
  const waiting = observer.select(ticket, {}, controller.signal);
  const rejected = assert.rejects(waiting, cancelled);
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(requestSignal?.aborted, true);
  blocked.resolve({ data: record(), logId: 'late-job-log' });
  await blocked.promise;
  assert.equal(eventReads, 0);
  assert.equal(observer.snapshot().result, null);
  assert.equal(observer.snapshot().pending, false);
  observer.dispose();
});

test('取消在途事件读取保留已取得的任务日志，晚到拒绝不会覆盖快照', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<JobEventDto[]>>();
  const observer = createAiTaskObserver(
    gateway({
      getEvents: async () => {
        entered.resolve();
        return blocked.promise;
      },
    }),
  );
  const controller = new AbortController();
  const waiting = observer.select(ticket, {}, controller.signal);
  const rejected = assert.rejects(
    waiting,
    (error: unknown) =>
      cancelled(error) && error instanceof ApiError && error.logId === 'job-query-log',
  );
  await entered.promise;
  controller.abort();
  await rejected;
  blocked.reject(new Error('晚到网关失败'));
  await assert.rejects(blocked.promise);
  assert.equal(observer.snapshot().result, null);
  observer.dispose();
});

test('切换任务撤销旧选择并立即清除旧结果，旧事件不能写回新任务', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<JobEventDto[]>>();
  let reads = 0;
  const observer = createAiTaskObserver(
    gateway({
      getEvents: async (id) => {
        if (++reads === 2) {
          entered.resolve();
          return blocked.promise;
        }
        return { data: [event(1, id)], logId: id + '-events-log' };
      },
    }),
  );
  await observer.select(ticket, {}, signal());
  const previous = observer.select(ticket, {}, signal());
  const rejected = assert.rejects(previous, cancelled);
  await entered.promise;
  const next = { ...ticket, id: 'ai-job-2' };
  const current = observer.select(next, {}, signal());
  assert.equal(observer.snapshot().pending, true);
  assert.equal(observer.snapshot().result, null);
  await rejected;
  const reply = await current;
  blocked.resolve({ data: [event(9)], logId: 'old-events-log' });
  await blocked.promise;
  assert.equal(observer.snapshot().result, reply);
  assert.equal(reply.data.job.id, next.id);
  observer.dispose();
});

test('销毁撤销在途事件和订阅，晚到成功不能复活且新调用不发请求', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<JobEventDto[]>>();
  let requests = 0;
  let notifications = 0;
  const observer = createAiTaskObserver(
    gateway({
      getEvents: async () => {
        requests++;
        entered.resolve();
        return blocked.promise;
      },
    }),
  );
  observer.subscribe(() => {
    notifications++;
  });
  const waiting = observer.select(ticket, {}, signal());
  const rejected = assert.rejects(waiting, cancelled);
  await entered.promise;
  observer.dispose();
  await rejected;
  const before = notifications;
  blocked.resolve({ data: [event(1)], logId: 'late-events-log' });
  await blocked.promise;
  assert.equal(notifications, before);
  assert.equal(observer.snapshot().pending, false);
  assert.equal(observer.snapshot().result, null);
  await assert.rejects(observer.select(ticket, {}, signal()), cancelled);
  assert.equal(requests, 1);
  assert.throws(() => observer.subscribe(() => {}));
});

test('拒绝错任务回应且不读取事件，保留真实读取日志', async () => {
  let eventReads = 0;
  for (const value of [
    { ...record(), id: 'other-job' },
    { ...record(), operation: 'plugin.settings.get' },
  ]) {
    const observer = createAiTaskObserver(
      gateway({
        getJob: async () => ({ data: value, logId: 'wrong-job-log' }),
        getEvents: async () => {
          eventReads++;
          return { data: [], logId: null };
        },
      }),
    );
    await assert.rejects(
      observer.select(ticket, {}, signal()),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'invalid_job' &&
        error.logId === 'wrong-job-log',
    );
    observer.dispose();
  }
  assert.equal(eventReads, 0);
});

test('错归属、重复倒序、越过游标及不安全序号或时间拒绝整批事件', async () => {
  const malformed: JobEventDto[][] = [
    [event(3, 'other-job')],
    [event(0)],
    [event(-1)],
    [event(1.5)],
    [event(Number.MAX_SAFE_INTEGER + 1)],
    [event(NaN)],
    [event(Infinity)],
    [event(3), event(3)],
    [event(4), event(3)],
    [event(2)],
    [{ ...event(3), timestamp: -1 }],
    [{ ...event(3), timestamp: 1.5 }],
    [{ ...event(3), timestamp: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const rows of malformed) {
    const observer = createAiTaskObserver(
      gateway({ getEvents: async () => ({ data: rows, logId: 'invalid-events-log' }) }),
    );
    await assert.rejects(
      observer.select(ticket, { after: 2 }, signal()),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'invalid_ai_task_events' &&
        error.logId === 'invalid-events-log',
    );
    assert.equal(observer.snapshot().result, null);
    observer.dispose();
  }
});

test('事件允许序号间隙、非单调时间及安全整数边界，接受后复制并冻结', async () => {
  const first = { ...event(3), timestamp: 9 };
  const second = { ...event(Number.MAX_SAFE_INTEGER), timestamp: 0 };
  const rows = [first, second];
  const task = record();
  const mutableTicket = { ...ticket };
  const observer = createAiTaskObserver(
    gateway({
      getJob: async () => ({ data: task, logId: null }),
      getEvents: async () => ({ data: rows, logId: null }),
    }),
  );
  const reply = await observer.select(mutableTicket, { after: 2 }, signal());
  first.sequence = 99;
  task.status = 'failed';
  mutableTicket.id = 'changed-ticket';
  rows.length = 0;
  assert.deepEqual(
    reply.data.events.map((row) => row.sequence),
    [3, Number.MAX_SAFE_INTEGER],
  );
  assert.equal(reply.data.after, Number.MAX_SAFE_INTEGER);
  assert.equal(reply.data.job.status, 'running');
  assert.equal(reply.data.ticket.id, ticket.id);
  assert.ok(Object.isFrozen(reply.data));
  assert.ok(Object.isFrozen(reply.data.job));
  assert.ok(Object.isFrozen(reply.data.events));
  assert.ok(Object.isFrozen(reply.data.events[0]));
  observer.dispose();
});

test('非法票据或游标在副作用前拒绝，不影响已接受选择', async () => {
  let queries = 0;
  const observer = createAiTaskObserver(
    gateway({
      getJob: async () => {
        queries++;
        return { data: record(), logId: null };
      },
    }),
  );
  const accepted = await observer.select(ticket, {}, signal());
  for (const value of [
    { ...ticket, id: ' ' },
    { ...ticket, id: '..' },
    { ...ticket, operation: 'plugin.settings.get' },
  ]) {
    await assert.rejects(
      observer.select(value, {}, signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_ai_ticket',
    );
  }
  for (const after of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      observer.select(ticket, { after }, signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_ai_task_query',
    );
  }
  const unknownQuery = { after: 0, tokenStream: true };
  await assert.rejects(observer.select(ticket, unknownQuery, signal()), ApiError);
  assert.equal(queries, 1);
  assert.equal(observer.snapshot().result, accepted);
  observer.dispose();
});

test('读取复制游标及票据，调用者修改不能换掉在途查询身份', async () => {
  const entered = deferred<void>();
  const blocked = deferred<ApiResult<TaskRecord>>();
  const parameters = { after: 2 };
  const mutableTicket = { ...ticket };
  const observer = createAiTaskObserver(
    gateway({
      getJob: async () => {
        entered.resolve();
        return blocked.promise;
      },
      getEvents: async (id, query) => {
        assert.equal(id, ticket.id);
        assert.equal(query.after, 2);
        return { data: [], logId: null };
      },
    }),
  );
  const waiting = observer.select(mutableTicket, parameters, signal());
  await entered.promise;
  mutableTicket.id = 'changed-ticket';
  mutableTicket.operation = 'plugin.settings.get';
  parameters.after = 9;
  blocked.resolve({ data: record(), logId: 'original-job-log' });
  assert.equal((await waiting).data.after, 2);
  observer.dispose();
});

test('订阅可同步换选或抛错，旧交付停止且不影响新任务', async () => {
  const observer = createAiTaskObserver(
    gateway({ getEvents: async (id) => ({ data: [event(1, id)], logId: id }) }),
  );
  let next: Promise<ApiResult<AiTaskObservation>> | undefined;
  const notified: string[] = [];
  observer.subscribe((value) => {
    if (!value.pending && value.result?.data.job.id === ticket.id)
      next = observer.select({ ...ticket, id: 'ai-job-2' }, {}, signal());
  });
  observer.subscribe(() => {
    throw new Error('消费者订阅失败');
  });
  observer.subscribe((value) => {
    if (!value.pending && value.result) notified.push(value.result.data.job.id);
  });
  await assert.rejects(observer.select(ticket, {}, signal()), cancelled);
  assert.ok(next);
  const reply = await next;
  assert.deepEqual(notified, ['ai-job-2']);
  assert.equal(observer.snapshot().result, reply);
  observer.dispose();
});

test('预取消不调用网关；事件网络错误保留诊断且不伪造成功', async () => {
  let reads = 0;
  const expected = new ApiError(
    'http',
    'events_unavailable',
    '事件读取失败',
    503,
    'events-failure-log',
  );
  const observer = createAiTaskObserver(
    gateway({
      getJob: async () => {
        reads++;
        return { data: record(), logId: null };
      },
      getEvents: async () => {
        throw expected;
      },
    }),
  );
  await assert.rejects(observer.select(ticket, {}, AbortSignal.abort()), cancelled);
  assert.equal(reads, 0);
  await assert.rejects(
    observer.select(ticket, {}, signal()),
    (error: unknown) => error === expected,
  );
  assert.equal(observer.snapshot().error, expected);
  assert.equal(observer.snapshot().pending, false);
  assert.equal(observer.snapshot().result, null);
  observer.dispose();
});

test('HTTP接线使用既有任务和事件端点、原游标和组合取消信号', async () => {
  const paths: string[] = [];
  const client = createApiClient({
    baseUrl: 'http://127.0.0.1:7420',
    transport: async (input, init) => {
      const url = requestUrl(input);
      paths.push(url.pathname + url.search);
      assert.equal(init?.method, 'GET');
      assert.ok(init?.signal instanceof AbortSignal);
      return success(
        url.pathname.endsWith('/events') ? [event(3)] : { ...record(), input: {}, created_at: 1 },
        url.pathname.endsWith('/events') ? 'http-events-log' : 'http-job-log',
      );
    },
  });
  const observer = createAiTaskObserver(createHttpAiTaskGateway(client));
  const reply = await observer.select(ticket, { after: 2 }, signal());
  assert.deepEqual(paths, ['/api/v2/jobs/ai-job-1', '/api/v2/jobs/ai-job-1/events?after=2']);
  assert.equal(reply.data.jobLogId, 'http-job-log');
  assert.equal(reply.data.eventsLogId, 'http-events-log');
  observer.dispose();
});
