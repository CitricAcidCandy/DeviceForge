import './official-business-imports.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { Job } from '../src/plugin-sdk/index.ts';
import { ApiError } from '../src/services/api/errors.ts';
import { JobFailure, JobWaitFailure } from '../src/shared/jobs/errors.ts';

const businessApi = await import('../plugins/business-kit/src/api/index.ts');
const businessJobs = await import('../plugins/business-kit/src/jobs/errors.ts');
const job: Job = {
  id: 'owned-job', operation: 'sample.execute', status: 'failed',
  result: null, error: '本次任务失败',
};

test('宿主与独立业务使用同一个 API 错误构造器并保留原构造顺序', () => {
  assert.equal(ApiError, businessApi.ApiError);
  const error = new ApiError('http', 'snapshot_conflict', '数据已变化', 409, 'write-log', '2');
  assert.ok(error instanceof HostError);
  assert.ok(error instanceof businessApi.ApiError);
  assert.deepEqual({
    name: error.name, kind: error.kind, code: error.code, message: error.message,
    status: error.status, logId: error.logId, retryAfter: error.retryAfter,
  }, {
    name: 'ApiError', kind: 'http', code: 'snapshot_conflict', message: '数据已变化',
    status: 409, logId: 'write-log', retryAfter: '2',
  });
});

test('任务失败的兼容出口共享身份，原任务和提交日志不被重建', () => {
  assert.equal(JobFailure, businessJobs.JobFailure);
  const error = new JobFailure(job, 'submit-log', 'result-log');
  assert.ok(error instanceof businessJobs.JobFailure);
  assert.equal(error.job, job);
  assert.equal(error.message, '本次任务失败');
  assert.equal(error.name, 'JobFailure');
  assert.equal(error.submitLogId, 'submit-log');
  assert.equal(error.logId, 'result-log');
});

test('任务等待未知的兼容出口保留原因、当前日志及最后已知日志', () => {
  assert.equal(JobWaitFailure, businessJobs.JobWaitFailure);
  const cause = new ApiError('network', 'read_failed', '等待中断', null, 'read-log');
  const error = new JobWaitFailure(job, 'submit-log', null, cause, 'previous-read-log');
  assert.ok(error instanceof businessJobs.JobWaitFailure);
  assert.equal(error.job, job);
  assert.equal(error.cause, cause);
  assert.equal(error.logId, null);
  assert.equal(error.lastKnownLogId, 'previous-read-log');
  assert.equal(error.message, cause.message);
});

test('跨 SDK 副本或窗口的公开错误按字段归一，不能依赖 instanceof 丢日志', () => {
  const foreign: unknown = runInNewContext(`Object.assign(new Error('远端调用失败'), {
    kind: 'http', code: 'provider_stopped', status: 503, logId: 'foreign-log', retryAfter: '1'
  })`);
  assert.equal(foreign instanceof HostError, false);
  const error = businessApi.apiError(foreign);
  assert.ok(error instanceof ApiError);
  assert.equal(error.message, '远端调用失败');
  assert.equal(error.code, 'provider_stopped');
  assert.equal(error.status, 503);
  assert.equal(error.logId, 'foreign-log');
  assert.equal(error.retryAfter, '1');
});

test('已归一错误保持本体，普通 HostError 只转换一次且元数据完整', () => {
  const failure = new ApiError('network', 'disconnected', '连接断开', null, 'owned-log');
  assert.equal(businessApi.apiError(failure), failure);
  const normalized = businessApi.apiError(new HostError('http', 'busy', '资源忙', 'busy-log', 429, '3'));
  assert.ok(normalized instanceof ApiError);
  assert.equal(businessApi.apiError(normalized), normalized);
  assert.equal(normalized.status, 429);
  assert.equal(normalized.logId, 'busy-log');
  assert.equal(normalized.retryAfter, '3');
});

test('无效或抛错的错误元数据保持原异常，不猜日志也不触发替代失败', () => {
  const invalid = { kind: 'http', code: 'bad', message: '不是公开错误',
    status: null, logId: 123, retryAfter: null };
  assert.equal(businessApi.apiError(invalid), invalid);
  const unreadable = Object.defineProperty({ ...invalid }, 'logId', {
    get() { throw new Error('属性读取失败'); },
  });
  assert.equal(businessApi.apiError(unreadable), unreadable);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.equal(businessApi.apiError(proxy), proxy);
});
