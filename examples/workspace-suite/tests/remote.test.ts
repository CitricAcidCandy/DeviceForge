import test from 'node:test';
import assert from 'node:assert/strict';
import { JobFailure, JobWaitFailure, HostError } from '@deviceforge/plugin-sdk';
import type { HostContext, HostResult, Job, ServiceDirectoryEntry } from '@deviceforge/plugin-sdk';
import { normalizeRemote, NORMALIZE_SERVICE } from '../browser/remote/normalize.ts';
import { MESSAGE_SCHEMA } from '../browser/domain/message.ts';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function fixture() {
  const lifetime = new AbortController();
  let generation = 'server-a', submitted = 0, queried = 0, cancelled = 0, listings = 0;
  let query: HostContext['getJob'] = async () => ({ data: job('succeeded'), logId: 'result-log' });
  let submission: NonNullable<NonNullable<HostContext['services']>['server']>['submit'] =
    async (_ref, _input, _signal, pinned) => {
      assert.equal(pinned, generation);
      return { data: job('running'), logId: 'submit-log' };
    };
  const job = (status: Job['status']): Job => ({
    id: 'original-job', operation: 'plugin.workspace_suite.server.normalize', status,
    result: status === 'succeeded' ? { message: '规范化结果' } : null,
    error: status === 'failed' ? '本次真实失败' : null,
  });
  const entry = (): ServiceDirectoryEntry => ({
    service: NORMALIZE_SERVICE, available: true, reason: null,
    operation: 'plugin.workspace_suite.server.normalize',
    provider: { id: 'workspace_suite.server', generation, version: '1' },
    contract: { inputSchema: MESSAGE_SCHEMA, outputSchema: MESSAGE_SCHEMA },
  });
  const context: HostContext = {
    apiVersion: 2, signal: lifetime.signal,
    async listOperations() { throw new Error('示例不走普通操作目录'); },
    async submit() { throw new Error('必须使用公开服务提交'); },
    async getJob(id, signal) { queried++; assert.equal(id, 'original-job'); return query(id, signal); },
    async cancelJob() { cancelled++; throw new Error('取消等待不能派发后台取消'); },
    subscribeOperations: () => () => {}, onDispose: (release) => release,
    services: {
      server: {
        async list() { listings++; return { data: [entry()], logId: 'directory-log' }; },
        async submit(ref, input, signal, pinned) {
          submitted++;
          assert.deepEqual(ref, NORMALIZE_SERVICE);
          return submission(ref, input, signal, pinned);
        },
      },
      catalog: () => [],
      async call() { throw new Error('不通过浏览器服务转发服务器请求'); },
      async callTyped() { throw new Error('不通过浏览器服务转发服务器请求'); },
      whenAvailable() { throw new Error('本单元不管理功能依赖'); }, diagnostics: () => [],
    },
  };
  return {
    context, job, lifetime,
    get counts() { return { submitted, queried, cancelled, listings }; },
    setQuery(next: HostContext['getJob']) { query = next; },
    setSubmission(next: typeof submission) { submission = next; },
    changeGeneration() { generation = 'server-b'; },
  };
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++)
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.ok(predicate(), '单元请求没有在有界等待内开始');
}

test('服务提交只派发一次，accepted不是成功，查询原Job终态并保留最终日志', async () => {
  const f = fixture();
  const result = await normalizeRemote(f.context, { message: '原输入' }, new AbortController().signal);
  assert.deepEqual(result, { data: { message: '规范化结果' }, logId: 'result-log' });
  assert.deepEqual(f.counts, { submitted: 1, queried: 1, cancelled: 0, listings: 2 });
});

test('服务器服务结果不能误接收操作产物封套，协议失败保留原成功任务和最终日志', async () => {
  const f = fixture();
  const envelope = { result: { message: '规范化结果' }, artifacts: [] };
  f.setQuery(async () => ({ data: { ...f.job('succeeded'), result: envelope }, logId: 'result-log' }));
  await assert.rejects(normalizeRemote(f.context, { message: '原输入' }, new AbortController().signal),
    (error) => error instanceof JobWaitFailure && error.job.id === 'original-job' &&
      error.job.status === 'succeeded' && error.submitLogId === 'submit-log' &&
      error.lastKnownLogId === 'result-log' && error.cause instanceof HostError);
  assert.deepEqual(f.counts, { submitted: 1, queried: 1, cancelled: 0, listings: 2 });
});

test('取消后拒绝忽略signal的旧查询，保留票据与日志，不重发、不取消后台', async () => {
  const f = fixture(), caller = new AbortController(), pending = deferred<HostResult<Job>>();
  f.setQuery(async () => pending.promise);
  const request = normalizeRemote(f.context, { message: '原输入' }, caller.signal);
  await until(() => f.counts.queried === 1);
  caller.abort();
  await assert.rejects(request, (error) => error instanceof JobWaitFailure &&
    error.job.id === 'original-job' && error.submitLogId === 'submit-log' && error.lastKnownLogId === 'submit-log');
  pending.resolve({ data: f.job('succeeded'), logId: 'late-log' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.counts.submitted, 1);
  assert.equal(f.counts.cancelled, 0);
});

test('提供者重载后的旧成功不交付，新调用仍可按新代独立执行', async () => {
  const f = fixture();
  f.setQuery(async () => {
    f.changeGeneration();
    return { data: f.job('succeeded'), logId: 'old-generation-log' };
  });
  await assert.rejects(normalizeRemote(f.context, { message: '原输入' }, new AbortController().signal),
    JobWaitFailure);
  f.setQuery(async () => ({ data: f.job('succeeded'), logId: 'new-generation-log' }));
  const result = await normalizeRemote(f.context, { message: '新调用' }, new AbortController().signal);
  assert.equal(result.logId, 'new-generation-log');
  assert.equal(f.counts.submitted, 2);
});

test('真实失败返回Job失败，未知受理保留原错误且从不自动重放', async () => {
  const f = fixture();
  f.setQuery(async () => ({ data: f.job('failed'), logId: 'failed-log' }));
  await assert.rejects(normalizeRemote(f.context, { message: '原输入' }, new AbortController().signal),
    (error) => error instanceof JobFailure && error.logId === 'failed-log');
  const unknown = new HostError('network', 'submit_unknown', '受理结果未知', 'original-log');
  f.setSubmission(async () => { throw unknown; });
  await assert.rejects(normalizeRemote(f.context, { message: '另一次输入' }, new AbortController().signal),
    (error) => error === unknown);
  assert.equal(f.counts.submitted, 2);
  assert.equal(f.counts.cancelled, 0);
});

test('终态协议异常保留已受理的原任务与日志，不用异常票据继续查询或重发', async () => {
  const f = fixture();
  f.setQuery(async () => ({
    data: { ...f.job('succeeded'), id: 'foreign-job' }, logId: 'foreign-result-log',
  }));
  await assert.rejects(normalizeRemote(f.context, { message: '原输入' }, new AbortController().signal),
    (error) => error instanceof JobWaitFailure && error.job.id === 'original-job' &&
      error.submitLogId === 'submit-log' && error.lastKnownLogId === 'submit-log' &&
      error.cause instanceof HostError && error.cause.code === 'example_normalize_job_mismatch');
  assert.equal(f.counts.submitted, 1);
  assert.equal(f.counts.queried, 1);
});
