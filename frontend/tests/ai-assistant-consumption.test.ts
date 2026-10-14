import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiAssistant } from '../src/features/ai-assistant/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import type { ApiResult } from '../src/services/api/index.ts';
import { deferred, signal } from './fixtures.ts';

const thread = '12345678-1234-1234-1234-123456789abc';
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return {
    submit: async (operation, input) => ({
      data: {
        id: 'ai-job',
        operation,
        status: 'succeeded',
        error: null,
        result: { result: respond(operation, input), artifacts: [] },
      },
      logId: 'ai-log',
    }),
    getJob: async () => {
      throw new Error('终态不应查询');
    },
    cancelJob: async () => {
      throw new Error('未授权取消');
    },
  };
}
const completed = {
  project_id: 'demo',
  text: '完成',
  thread_id: thread,
  events: [
    { type: 'thread.started', thread_id: thread },
    { type: 'item.completed', item: { type: 'agent_message', text: '完成' } },
    { type: 'turn.completed' },
  ],
};
test('状态、单次与轮次消费真实线程、事件和原提示词', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const ai = createAiAssistant(
    gateway((operation, input) => {
      seen.push({ operation, input });
      return operation.endsWith('.status')
        ? { configured: true, provider: 'codex_cli', projects: ['demo'] }
        : completed;
    }),
  );
  assert.equal((await ai.runtimeStatus(signal())).data.provider, 'codex_cli');
  const result = await ai.single(
    { project_id: 'demo', prompt: ' 请保留换行\n完成任务 ' },
    signal(),
  );
  assert.equal(result.data.thread_id, thread);
  await ai.turn({ project_id: 'demo', prompt: '继续', thread_id: thread }, signal());
  assert.deepEqual(seen[1]?.input, { project_id: 'demo', prompt: ' 请保留换行\n完成任务 ' });
  assert.equal(seen[2]?.operation, 'plugin.ai-assistant.cli.turn');
  ai.dispose();
});
test('拒绝路径项目、空提示词及非UUID线程，单次禁止已有线程', () => {
  const ai = createAiAssistant(gateway(() => completed));
  assert.throws(() => ai.single({ project_id: '../demo', prompt: '运行' }, signal()), ApiError);
  assert.throws(() => ai.single({ project_id: 'demo', prompt: '  ' }, signal()), ApiError);
  assert.throws(
    () => ai.turn({ project_id: 'demo', prompt: '运行', thread_id: 'not-thread' }, signal()),
    ApiError,
  );
  const single = { project_id: 'demo', prompt: '运行', thread_id: thread };
  assert.throws(() => ai.single(single, signal()), ApiError);
  ai.dispose();
});
test('拒绝部分回答、失败事件和错线程且保留日志', async () => {
  const bad = [
    { ...completed, events: [{ type: 'item.completed' }] },
    { ...completed, events: [{ type: 'turn.completed' }, { type: 'error' }] },
    { ...completed, thread_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  ];
  for (const value of bad) {
    const ai = createAiAssistant(gateway(() => value));
    await assert.rejects(
      ai.turn({ project_id: 'demo', prompt: '继续', thread_id: thread }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'ai-log',
    );
    ai.dispose();
  }
});

test('会话管理保留u64轮数与不确定状态，关闭只消费真实closed', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const ai = createAiAssistant(
    gateway((operation, input) => {
      seen.push({ operation, input });
      return {
        project_id: 'demo',
        thread_id: thread,
        turns: '18446744073709551614',
        closed: operation.endsWith('.close'),
        uncertain: true,
      };
    }),
  );
  const input = { project_id: 'demo', thread_id: thread };
  assert.equal((await ai.getSession(input, signal())).data.uncertain, true);
  assert.equal((await ai.closeSession(input, signal())).data.turns, '18446744073709551614');
  assert.deepEqual(
    seen.map((call) => call.operation),
    ['plugin.ai-assistant.session.get', 'plugin.ai-assistant.session.close'],
  );
  assert.deepEqual(seen[1]?.input, input);
  ai.dispose();
  const invalid = createAiAssistant(
    gateway(() => ({
      project_id: 'demo',
      thread_id: thread,
      turns: '01',
      closed: false,
      uncertain: false,
    })),
  );
  await assert.rejects(invalid.closeSession(input, signal()), ApiError);
  invalid.dispose();
});

test('大写UUID按后端身份归一，不拒正常轮次与会话返回', async () => {
  const seen: JsonData[] = [];
  const ai = createAiAssistant(
    gateway((operation, input) => {
      seen.push(input);
      return operation.endsWith('.turn')
        ? completed
        : {
            project_id: 'demo',
            thread_id: thread,
            turns: '1',
            closed: operation.endsWith('.close'),
            uncertain: false,
          };
    }),
  );
  const uppercase = thread.toUpperCase();
  assert.equal(
    (await ai.turn({ project_id: 'demo', prompt: '继续', thread_id: uppercase }, signal())).data
      .thread_id,
    thread,
  );
  assert.equal(
    (await ai.getSession({ project_id: 'demo', thread_id: uppercase }, signal())).data.thread_id,
    thread,
  );
  await ai.closeSession({ project_id: 'demo', thread_id: uppercase }, signal());
  assert.deepEqual(seen[0], { project_id: 'demo', prompt: '继续', thread_id: thread });
  assert.deepEqual(seen[1], { project_id: 'demo', thread_id: thread });
  ai.dispose();
  const missing = createAiAssistant(gateway(() => ({ ...completed, thread_id: null })));
  await assert.rejects(missing.single({ project_id: 'demo', prompt: '继续' }, signal()), ApiError);
  missing.dispose();
});

test('首次cli.turn不携线程创建持久归属，再按真实线程读取、续轮和关闭', async () => {
  const calls: { operation: string; input: JsonData }[] = [];
  const ai = createAiAssistant(
    gateway((operation, input) => {
      calls.push({ operation, input });
      return operation.endsWith('.turn')
        ? completed
        : {
            project_id: 'demo',
            thread_id: thread,
            turns: calls.length > 2 ? '2' : '1',
            closed: operation.endsWith('.close'),
            uncertain: false,
          };
    }),
  );
  const created = await ai.turn({ project_id: 'demo', prompt: '开始' }, signal());
  const session = { project_id: created.data.project_id, thread_id: created.data.thread_id };
  assert.equal((await ai.getSession(session, signal())).data.turns, '1');
  await ai.turn({ ...session, prompt: '继续' }, signal());
  assert.equal((await ai.closeSession(session, signal())).data.closed, true);
  assert.deepEqual(
    calls.map((call) => call.operation),
    [
      'plugin.ai-assistant.cli.turn',
      'plugin.ai-assistant.session.get',
      'plugin.ai-assistant.cli.turn',
      'plugin.ai-assistant.session.close',
    ],
  );
  assert.deepEqual(calls[0]?.input, { project_id: 'demo', prompt: '开始' });
  assert.deepEqual(calls[2]?.input, { ...session, prompt: '继续' });
  ai.dispose();
});

test('拒绝事件内部串线程和错项目，保留实际日志', async () => {
  for (const value of [
    { ...completed, project_id: 'other' },
    {
      ...completed,
      events: [
        { type: 'thread.started', thread_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        { type: 'turn.completed' },
      ],
    },
  ]) {
    const ai = createAiAssistant(gateway(() => value));
    await assert.rejects(
      ai.turn({ project_id: 'demo', prompt: '继续' }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'ai-log',
    );
    ai.dispose();
  }
});

test('轮次取消等待、忽略信号的晚到响应与恢复不重发提示词', async () => {
  const blocked = deferred<ApiResult<TaskRecord>>();
  const entered = deferred<void>();
  let submits = 0;
  let queries = 0;
  let recovered = false;
  const operation = 'plugin.ai-assistant.cli.turn';
  const terminal: ApiResult<TaskRecord> = {
    data: {
      id: 'ai-job',
      operation,
      status: 'succeeded',
      error: null,
      result: { result: completed, artifacts: [] },
    },
    logId: 'turn-query-log',
  };
  const ai = createAiAssistant(
    {
      ...gateway(() => completed),
      submit: async () => {
        submits++;
        return {
          data: { id: 'ai-job', operation, status: 'running', error: null, result: null },
          logId: 'turn-submit-log',
        };
      },
      getJob: async () => {
        queries++;
        entered.resolve();
        return recovered ? terminal : blocked.promise;
      },
    },
    { pollIntervalMs: 0 },
  );
  const input = { project_id: 'demo', prompt: '继续', thread_id: thread };
  const controller = new AbortController();
  const waiting = ai.turn(input, controller.signal);
  const cancelled = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.job.id === 'ai-job' &&
      error.submitLogId === 'turn-submit-log',
  );
  await entered.promise;
  controller.abort();
  await cancelled;
  recovered = true;
  const ticket = { id: 'ai-job', operation, submitLogId: 'turn-submit-log' };
  assert.equal((await ai.query(ticket, signal())).data.status, 'succeeded');
  const resumed = await ai.resumeTurn(ticket, input, signal());
  assert.equal(resumed.data.thread_id, thread);
  assert.equal(resumed.logId, 'turn-query-log');
  assert.equal(submits, 1);
  assert.equal(queries, 3);
  blocked.resolve(terminal);
  ai.dispose();
});

test('会话关闭恢复读取真实closed，错操作票据不能查询或取消', async () => {
  let submits = 0;
  const operation = 'plugin.ai-assistant.session.close';
  const ai = createAiAssistant({
    ...gateway(() => completed),
    submit: async () => {
      submits++;
      throw new Error('恢复不得提交');
    },
    getJob: async () => ({
      data: {
        id: 'close-job',
        operation,
        status: 'succeeded',
        error: null,
        result: {
          result: {
            project_id: 'demo',
            thread_id: thread,
            turns: '2',
            closed: true,
            uncertain: true,
          },
          artifacts: [],
        },
      },
      logId: 'close-log',
    }),
  });
  const ticket = { id: 'close-job', operation, submitLogId: 'close-submit-log' };
  const result = await ai.resumeCloseSession(
    ticket,
    { project_id: 'demo', thread_id: thread },
    signal(),
  );
  assert.equal(result.data.closed, true);
  assert.equal(result.data.uncertain, true);
  assert.equal(result.logId, 'close-log');
  assert.equal(submits, 0);
  const foreign = { ...ticket, operation: 'plugin.settings.get' };
  assert.throws(() => ai.query(foreign, signal()), ApiError);
  assert.throws(() => ai.cancel(foreign, signal()), ApiError);
  ai.dispose();
});
