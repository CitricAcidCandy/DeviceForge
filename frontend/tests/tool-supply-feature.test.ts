import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolSupply } from '../src/features/tool-supply/index.ts';
import { requireRuntimeFeatureKey, runtimeFeatureKey } from '../src/features/tool-supply/feature-rules.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { ApiResult } from '../src/shared/api/index.ts';
import { JobFailure, JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JobTicket, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';

type FeatureAction = 'status' | 'prepare';
const featureActions: readonly FeatureAction[] = ['status', 'prepare'];
const operation = (action: FeatureAction) => `plugin.tool-supply.runtime_feature.${action}`;
function runtimeModule(moduleId = 'node-runtime', featureKey = 'assistant'): { [key: string]: JsonData } {
  return { module_id: moduleId, kind: 'runtime', required: true, feature_key: featureKey, available_version: '1.2.0',
    installed_version: '1.2', entry_present: true, action: 'current', size: 40 };
}
function installation(moduleId = 'node-runtime'): { [key: string]: JsonData } {
  return { module_id: moduleId, version: '1.2.0', sha256: 'a'.repeat(64), changed: true };
}
function statusResult(featureKey = 'assistant', modules: JsonData[] = [runtimeModule()]): { [key: string]: JsonData } {
  return { feature_key: featureKey, manifest_version: 'v1', source_error: null, found: true, ready: true, modules };
}
function prepareResult(featureKey = 'assistant', modules: JsonData[] = [installation()]): { [key: string]: JsonData } {
  return { feature_key: featureKey, manifest_version: 'v1', ready: true, modules };
}
function completed(name: string, result: JsonData, logId = 'feature-log', id = 'feature-job'): ApiResult<TaskRecord> {
  return { data: { id, operation: name, status: 'succeeded', error: null, result: { result, artifacts: [] } }, logId };
}
function gateway(respond: (name: string, input: JsonData) => JsonData): JobGateway {
  return { submit: async (name, input) => completed(name, respond(name, input)),
    getJob: async () => { throw new Error('终态不应查询'); }, cancelJob: async () => { throw new Error('未授权取消'); } };
}

test('运行时功能两贡献仅发送功能标识，按 UTF-8 接受有界 Unicode 和模块规则之外的身份', async () => {
  for (const featureKey of ['a', 'a'.repeat(128), '中'.repeat(42) + 'ab', '😀'.repeat(32), 'e\u0301'.repeat(42) + 'ab', 'con', 'A.b:/功能', ' ', '\u0000']) {
    const seen: { name: string; input: JsonData }[] = [];
    const tools = createToolSupply(gateway((name, input) => {
      seen.push({ name, input });
      return name === operation('status') ? statusResult(featureKey, [runtimeModule('node-runtime', featureKey)]) : prepareResult(featureKey);
    }));
    const status = await tools.runtimeFeatureStatus(featureKey, signal());
    const prepared = await tools.prepareRuntimeFeature(featureKey, signal());
    assert.equal(status.data.feature_key, featureKey); assert.equal(prepared.data.feature_key, featureKey);
    assert.equal(status.submitLogId, 'feature-log'); assert.equal(prepared.logId, 'feature-log');
    assert.deepEqual(seen, [{ name: operation('status'), input: { feature_key: featureKey } },
      { name: operation('prepare'), input: { feature_key: featureKey } }]); tools.dispose();
  }
});

test('非法功能标识和超字节 Unicode 在提交及恢复前拒绝，所有任务端口零调用', () => {
  let calls = 0;
  const unused = async (): Promise<ApiResult<TaskRecord>> => { calls++; throw new Error('非法输入不应访问任务端口'); };
  const tools = createToolSupply({ submit: unused, getJob: unused, cancelJob: unused });
  for (const value of [null, undefined, false, 1, {}, [], ['assistant']]) {
    assert.equal(runtimeFeatureKey(value), false); assert.throws(() => requireRuntimeFeatureKey(value), ApiError);
  }
  for (const featureKey of ['', 'a'.repeat(129), '中'.repeat(43), '中'.repeat(42) + 'abc', '😀'.repeat(32) + 'a',
    'e\u0301'.repeat(42) + 'abc', '\uD800', '\uDC00', 'a\uD800b']) {
    const statusTicket = { id: 'feature-job', operation: operation('status'), submitLogId: null };
    const prepareTicket = { ...statusTicket, operation: operation('prepare') };
    assert.throws(() => tools.runtimeFeatureStatus(featureKey, signal()), ApiError);
    assert.throws(() => tools.prepareRuntimeFeature(featureKey, signal()), ApiError);
    assert.throws(() => tools.resumeRuntimeFeatureStatus(statusTicket, featureKey, signal()), ApiError);
    assert.throws(() => tools.resumePrepareRuntimeFeature(prepareTicket, featureKey, signal()), ApiError);
  }
  assert.equal(calls, 0); tools.dispose();
});

test('未知功能与来源失败成功返回真实差异，均不伪装成安装就绪', async () => {
  for (const result of [
    { feature_key: 'assistant', manifest_version: 'v1', source_error: null, found: false, ready: false, modules: [] },
    { feature_key: 'assistant', manifest_version: null, source_error: '来源不可用（已脱敏）', found: false, ready: false, modules: [] },
  ]) {
    const tools = createToolSupply(gateway(() => result));
    assert.deepEqual((await tools.runtimeFeatureStatus('assistant', signal())).data, result); tools.dispose();
  }
});

test('状态保留多模块清单顺序，全部 current 才就绪，更高版本或需修复均未就绪', async () => {
  for (const state of [
    { action: 'current', installed_version: '1.2', entry_present: true },
    { action: 'local_newer', installed_version: '1.3', entry_present: true },
    { action: 'repair', installed_version: '1.2', entry_present: false },
    { action: 'update', installed_version: '1.1', entry_present: true },
  ]) {
    const modules = [runtimeModule('z-runtime'), { ...runtimeModule('a-runtime'), ...state }];
    const result = { ...statusResult('assistant', modules), ready: state.action === 'current' };
    const tools = createToolSupply(gateway(() => result));
    const status = await tools.runtimeFeatureStatus('assistant', signal());
    assert.deepEqual(status.data.modules.map((module) => module.module_id), ['z-runtime', 'a-runtime']);
    assert.equal(status.data.ready, state.action === 'current'); tools.dispose();
  }
});

test('状态严格拒绝功能错配、来源与 found/ready 矛盾及额外路径字段，保留响应日志', async () => {
  const invalid: JsonData[] = [
    { ...statusResult(), feature_key: 'other' }, { ...statusResult(), feature_key: '中'.repeat(43) },
    { ...statusResult(), found: false }, { ...statusResult(), ready: false },
    { ...statusResult(), found: 'true' }, { ...statusResult(), ready: 1 },
    { ...statusResult(), manifest_version: null }, { ...statusResult(), manifest_version: '' },
    { ...statusResult(), source_error: '来源失败' }, { ...statusResult(), source_error: '' },
    { ...statusResult(), path: '私有路径不得返回' },
    { ...statusResult('assistant', []), found: true, ready: false },
    { ...statusResult('assistant', []), found: false, ready: true },
    { ...statusResult(), manifest_version: null, source_error: '来源失败' },
    statusResult('assistant', [runtimeModule(), runtimeModule()]),
    statusResult('assistant', [{ ...runtimeModule(), kind: 'tool' }]),
    statusResult('assistant', [runtimeModule('node-runtime', 'other')]),
    statusResult('assistant', [{ ...runtimeModule(), feature_key: null }]),
    statusResult('assistant', [{ ...runtimeModule(), path: '私有路径不得返回' }]),
    statusResult('assistant', [{ ...runtimeModule(), entry_present: false }]),
    statusResult('assistant', [{ ...runtimeModule(), installed_version: '1.3' }]),
    statusResult('assistant', [{ ...runtimeModule(), installed_version: '1.3', action: 'local_newer' }]),
    statusResult('assistant', [{ ...runtimeModule(), installed_version: null, entry_present: false, action: 'install' }]),
    { ...statusResult('assistant', [{ ...runtimeModule(), available_version: null, action: 'local_only' }]), ready: false },
    statusResult('assistant', [{ ...runtimeModule(), available_version: '18446744073709551616' }]),
    statusResult('assistant', [{ ...runtimeModule(), module_id: '../runtime' }]),
    statusResult('assistant', Array.from({ length: 129 }, (_unused, index) => runtimeModule('runtime-' + index))),
  ];
  for (const result of invalid) {
    const tools = createToolSupply(gateway(() => result));
    await assert.rejects(tools.runtimeFeatureStatus('assistant', signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_business_result' && error.logId === 'feature-log');
    tools.dispose();
  }
});

test('状态与准备接受 128 个唯一模块，准备只消费顶层归属并保留清单顺序及 changed', async () => {
  const modules = Array.from({ length: 128 }, (_unused, index) => runtimeModule('runtime-' + (127 - index)));
  const installed = Array.from({ length: 128 }, (_unused, index) => ({ ...installation('runtime-' + (127 - index)), changed: index % 2 === 0 }));
  const tools = createToolSupply(gateway((name) => name === operation('status') ? statusResult('assistant', modules) : prepareResult('assistant', installed)));
  assert.equal((await tools.runtimeFeatureStatus('assistant', signal())).data.modules.length, 128);
  const prepared = await tools.prepareRuntimeFeature('assistant', signal());
  assert.deepEqual(prepared.data.modules, installed);
  assert.equal(prepared.data.modules[0]?.module_id, 'runtime-127');
  assert.equal(prepared.data.modules[1]?.changed, false);
  assert.deepEqual(Object.keys(prepared.data.modules[0] ?? {}).sort(), ['changed', 'module_id', 'sha256', 'version']); tools.dispose();
});

test('准备严格拒绝空或重复或超量模块、错功能、版本摘要身份错误和非公开字段', async () => {
  const invalid: JsonData[] = [
    { ...prepareResult(), feature_key: 'other' }, { ...prepareResult(), feature_key: '\uD800' },
    { ...prepareResult(), manifest_version: null }, { ...prepareResult(), manifest_version: '' },
    { ...prepareResult(), ready: false }, { ...prepareResult(), ready: 'true' },
    { ...prepareResult(), source_error: null }, { ...prepareResult(), path: '私有路径不得返回' },
    prepareResult('assistant', []), prepareResult('assistant', [installation(), installation()]),
    prepareResult('assistant', [{ ...installation(), module_id: '../runtime' }]),
    prepareResult('assistant', [{ ...installation(), module_id: 'con' }]),
    prepareResult('assistant', [{ ...installation(), module_id: '' }]),
    prepareResult('assistant', [{ ...installation(), version: 'v1' }]),
    prepareResult('assistant', [{ ...installation(), version: '18446744073709551616' }]),
    prepareResult('assistant', [{ ...installation(), sha256: 'bad' }]),
    prepareResult('assistant', [{ ...installation(), sha256: 'a'.repeat(65) }]),
    prepareResult('assistant', [{ module_id: 'node-runtime', version: '1.2', changed: false }]),
    prepareResult('assistant', [{ module_id: 'node-runtime', version: '1.2', sha256: 'a'.repeat(64) }]),
    prepareResult('assistant', [{ ...installation(), changed: 0 }]),
    prepareResult('assistant', [{ ...installation(), feature_key: 'assistant' }]),
    prepareResult('assistant', [{ ...installation(), path: '私有路径不得返回' }]),
    prepareResult('assistant', Array.from({ length: 129 }, (_unused, index) => installation('runtime-' + index))),
  ];
  for (const result of invalid) {
    const tools = createToolSupply(gateway(() => result));
    await assert.rejects(tools.prepareRuntimeFeature('assistant', signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'feature-log'); tools.dispose();
  }
});

test('两功能操作拒绝缺字段和错误产物包装，不把 Job 或产物误当业务结果', async () => {
  for (const action of ['status', 'prepare']) {
    const business = action === 'status' ? statusResult() : prepareResult();
    const invalid: JsonData[] = [null, {}, business, { result: business }, { result: business, artifacts: [], path: '额外字段' },
      { result: business, artifacts: [{ id: 'artifact', filename: 'runtime.zip', media_type: 'application/zip', size: 1, created_at: 1, sha256: 'a'.repeat(64) }] }];
    for (const result of invalid) {
      const tools = createToolSupply({ ...gateway(() => ({})), submit: async (name) => ({
        data: { id: 'feature-job', operation: name, status: 'succeeded', error: null, result }, logId: 'envelope-log',
      }) });
      await assert.rejects(action === 'status' ? tools.runtimeFeatureStatus('assistant', signal()) : tools.prepareRuntimeFeature('assistant', signal()),
        (error: unknown) => error instanceof ApiError && error.logId === 'envelope-log'); tools.dispose();
    }
  }
});

test('恢复拒绝错操作票据，查询取消只接受精确贡献身份且拒绝前所有端口零调用', () => {
  let calls = 0;
  const unused = async (): Promise<ApiResult<TaskRecord>> => { calls++; throw new Error('错票据不得访问任务端口'); };
  const tools = createToolSupply({ submit: unused, getJob: unused, cancelJob: unused });
  const foreignOperations = ['plugin.settings.get', 'plugin.tool-supply.runtime_feature', 'plugin.tool-supply.runtime_feature.unknown',
    'plugin.tool-supply.runtime_feature.status.extra', 'plugin.tool-supply.runtime_feature.prepare.extra', 'other.tool-supply.runtime_feature.status'];
  for (const name of [...foreignOperations, 'plugin.tool-supply.install', operation('prepare')]) {
    const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: 'submit-log' };
    assert.throws(() => tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_tool_ticket');
  }
  for (const name of [...foreignOperations, 'plugin.tool-supply.remove', operation('status')]) {
    const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: 'submit-log' };
    assert.throws(() => tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()),
      (error: unknown) => error instanceof ApiError && error.code === 'invalid_tool_ticket');
  }
  for (const name of foreignOperations) {
    const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: null };
    assert.throws(() => tools.query(ticket, signal()), ApiError);
    assert.throws(() => tools.cancel(ticket, signal()), ApiError);
  }
  assert.equal(calls, 0); tools.dispose();
});

test('两恢复方法只读取原任务，成功保留提交及查询日志，不重新提交', async () => {
  for (const action of featureActions) {
    const name = operation(action); let submits = 0; let reads = 0; let cancels = 0;
    const business = action === 'status' ? statusResult() : prepareResult();
    const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: 'original-submit-log' };
    const tools = createToolSupply({
      submit: async () => { submits++; throw new Error('恢复不得重新提交'); },
      getJob: async (id) => { reads++; assert.equal(id, ticket.id); return completed(name, business, 'resume-query-log'); },
      cancelJob: async () => { cancels++; throw new Error('恢复不得自动取消'); },
    });
    const restored = await (action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
      : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()));
    assert.deepEqual(restored.data, business); assert.equal(restored.job.id, ticket.id);
    assert.equal(restored.submitLogId, 'original-submit-log'); assert.equal(restored.logId, 'resume-query-log');
    assert.equal(submits, 0); assert.equal(reads, 1); assert.equal(cancels, 0); tools.dispose();
  }
});

test('恢复拒绝相同操作的错功能结果并保留查询日志，不靠重提任务纠正', async () => {
  for (const action of featureActions) {
    const name = operation(action); let submits = 0; let reads = 0;
    const business = action === 'status' ? statusResult('other', [runtimeModule('node-runtime', 'other')]) : prepareResult('other');
    const tools = createToolSupply({
      submit: async () => { submits++; throw new Error('不得重提'); },
      getJob: async () => { reads++; return completed(name, business, 'wrong-feature-log'); },
      cancelJob: async () => { throw new Error('不得取消'); },
    });
    const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: 'original-submit-log' };
    await assert.rejects(action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
      : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()),
    (error: unknown) => error instanceof ApiError && error.code === 'invalid_business_result' && error.logId === 'wrong-feature-log');
    assert.equal(submits, 0); assert.equal(reads, 1); tools.dispose();
  }
});

test('共享任务拒绝提交空身份或错操作及恢复查询取消的错 Job 身份，关联各响应日志', async () => {
  for (const action of featureActions) {
    const name = operation(action);
    const business = action === 'status' ? statusResult() : prepareResult();
    for (const mismatch of [{ id: '', operation: name }, { id: 'feature-job', operation: 'plugin.settings.get' }]) {
      let submits = 0;
      const tools = createToolSupply({ ...gateway(() => business), submit: async () => {
        submits++; const result = completed(name, business, 'wrong-submit-log');
        return { ...result, data: { ...result.data, ...mismatch } };
      } });
      await assert.rejects(action === 'status' ? tools.runtimeFeatureStatus('assistant', signal()) : tools.prepareRuntimeFeature('assistant', signal()),
        (error: unknown) => error instanceof ApiError && error.code === 'invalid_job' && error.logId === 'wrong-submit-log');
      assert.equal(submits, 1); tools.dispose();
    }
    for (const mismatch of [{ id: 'other-job', operation: name }, { id: 'feature-job', operation: 'plugin.settings.get' }]) {
      let submits = 0;
      const wrong = completed(name, business, 'wrong-job-log');
      const response: ApiResult<TaskRecord> = { ...wrong, data: { ...wrong.data, ...mismatch } };
      const tools = createToolSupply({
        submit: async () => { submits++; throw new Error('不得重新提交'); },
        getJob: async () => response, cancelJob: async () => response,
      });
      const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: 'original-submit-log' };
      const invalidJob = (error: unknown) => error instanceof ApiError && error.code === 'invalid_job' && error.logId === 'wrong-job-log';
      await assert.rejects(tools.query(ticket, signal()), invalidJob); await assert.rejects(tools.cancel(ticket, signal()), invalidJob);
      await assert.rejects(action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
        : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()), invalidJob);
      assert.equal(submits, 0); tools.dispose();
    }
  }
});

test('两功能操作取消等待不取消服务器，显式取消仍在途后查询恢复原 Job，晚到结果不复活等待', async () => {
  for (const action of featureActions) {
    const name = operation(action);
    const blocked = deferred<ApiResult<TaskRecord>>(); const entered = deferred<AbortSignal>();
    const running: ApiResult<TaskRecord> = { data: { id: 'feature-job', operation: name, status: 'running', error: null, result: null }, logId: 'submit-log' };
    const terminal = completed(name, action === 'status' ? statusResult() : prepareResult(), 'query-log');
    let submits = 0; let cancels = 0; let reads = 0; let recover = false;
    const tools = createToolSupply({
      submit: async (requested, input) => { submits++; assert.equal(requested, name); assert.deepEqual(input, { feature_key: 'assistant' }); return running; },
      getJob: async (id, requestSignal) => {
        reads++; assert.equal(id, running.data.id);
        if (recover) return terminal;
        entered.resolve(requestSignal); return blocked.promise;
      },
      cancelJob: async (id) => { cancels++; assert.equal(id, running.data.id); return { ...running, logId: 'cancel-log' }; },
    }, { pollIntervalMs: 0 });
    const controller = new AbortController();
    const waiting = action === 'status' ? tools.runtimeFeatureStatus('assistant', controller.signal) : tools.prepareRuntimeFeature('assistant', controller.signal);
    const stopped = assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure
      && error.job.id === running.data.id && error.job.status === 'running' && error.submitLogId === 'submit-log'
      && error.lastKnownLogId === 'submit-log' && error.logId === null);
    const requestSignal = await entered.promise; controller.abort(); await stopped;
    assert.equal(requestSignal.aborted, true); assert.equal(submits, 1); assert.equal(cancels, 0);
    const ticket: JobTicket = { id: running.data.id, operation: name, submitLogId: running.logId };
    const cancelled = await tools.cancel(ticket, signal());
    assert.equal(cancelled.data.status, 'running'); assert.equal(cancelled.logId, 'cancel-log');
    recover = true;
    assert.equal((await tools.query(ticket, signal())).data.status, 'succeeded');
    const restored = await (action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
      : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()));
    assert.deepEqual(restored.data, action === 'status' ? statusResult() : prepareResult());
    assert.equal(restored.submitLogId, 'submit-log'); assert.equal(restored.logId, 'query-log');
    assert.equal(submits, 1); assert.equal(cancels, 1); assert.equal(reads, 3);
    blocked.resolve(completed(name, {}, 'late-log', 'wrong-late-job')); await blocked.promise;
    await assert.rejects(waiting, JobWaitFailure);
    assert.equal(restored.logId, 'query-log'); assert.equal(submits, 1); tools.dispose();
  }
});

test('状态恢复仍消费真实来源错误和查询日志，不把来源失败转为重试提交', async () => {
  let submits = 0; let reads = 0;
  const result: JsonData = { feature_key: 'assistant', manifest_version: null, source_error: '来源不可用（已脱敏）',
    found: false, ready: false, modules: [] };
  const ticket: JobTicket = { id: 'feature-job', operation: operation('status'), submitLogId: 'source-submit-log' };
  const tools = createToolSupply({
    submit: async () => { submits++; throw new Error('来源失败不得重提'); },
    getJob: async () => { reads++; return completed(ticket.operation, result, 'source-query-log'); },
    cancelJob: async () => { throw new Error('不得自动取消'); },
  });
  const restored = await tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal());
  assert.deepEqual(restored.data, result); assert.equal(restored.submitLogId, 'source-submit-log'); assert.equal(restored.logId, 'source-query-log');
  assert.equal(submits, 0); assert.equal(reads, 1); tools.dispose();
});

test('来源、安装损坏、部分提交、未确认清理、到期和取消均保持真实失败及日志，不降级为状态成功', async () => {
  const terminalStates: readonly { status: 'failed' | 'cancelled'; error: string }[] = [
    { status: 'failed', error: '来源读取失败' }, { status: 'failed', error: '本地安装状态损坏' },
    { status: 'failed', error: '第二模块失败，首模块保留，第三模块未执行' },
    { status: 'failed', error: '安装清理未确认，保留备份等待核对' },
    { status: 'failed', error: '原执行截止时间已到期' }, { status: 'cancelled', error: '任务已取消' },
  ];
  for (const action of featureActions) {
    for (const terminal of terminalStates) {
      const name = operation(action); let submits = 0; let reads = 0; let cancels = 0;
      const running: ApiResult<TaskRecord> = { data: { id: 'feature-job', operation: name, status: 'running', error: null, result: null }, logId: 'failure-submit-log' };
      const failed: ApiResult<TaskRecord> = { data: { ...running.data, ...terminal }, logId: 'failure-query-log' };
      const tools = createToolSupply({
        submit: async () => { submits++; return running; },
        getJob: async () => { reads++; return failed; },
        cancelJob: async () => { cancels++; throw new Error('不得自动取消'); },
      }, { pollIntervalMs: 0 });
      const failure = (error: unknown) => error instanceof JobFailure && error.job.status === terminal.status
        && error.message === terminal.error && error.submitLogId === 'failure-submit-log' && error.logId === 'failure-query-log';
      await assert.rejects(action === 'status' ? tools.runtimeFeatureStatus('assistant', signal()) : tools.prepareRuntimeFeature('assistant', signal()), failure);
      const ticket: JobTicket = { id: running.data.id, operation: name, submitLogId: running.logId };
      await assert.rejects(action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
        : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()), failure);
      assert.equal(submits, 1); assert.equal(reads, 2); assert.equal(cancels, 0); tools.dispose();
    }
  }
});

test('显式取消返回 cancelled 仍以原任务恢复失败，保留取消及恢复各自日志', async () => {
  for (const action of featureActions) {
    const name = operation(action); let submits = 0; let cancels = 0; let reads = 0;
    const ticket: JobTicket = { id: 'feature-job', operation: name, submitLogId: 'original-submit-log' };
    const cancelled: TaskRecord = { id: ticket.id, operation: name, status: 'cancelled', error: '原任务已取消', result: null };
    const tools = createToolSupply({
      submit: async () => { submits++; throw new Error('不得重新提交'); },
      getJob: async () => { reads++; return { data: cancelled, logId: 'cancel-query-log' }; },
      cancelJob: async () => { cancels++; return { data: cancelled, logId: 'cancel-response-log' }; },
    });
    const response = await tools.cancel(ticket, signal());
    assert.equal(response.data.status, 'cancelled'); assert.equal(response.logId, 'cancel-response-log');
    await assert.rejects(action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
      : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()),
    (error: unknown) => error instanceof JobFailure && error.job.id === ticket.id && error.job.status === 'cancelled'
      && error.submitLogId === 'original-submit-log' && error.logId === 'cancel-query-log');
    assert.equal(submits, 0); assert.equal(cancels, 1); assert.equal(reads, 1); tools.dispose();
  }
});

test('查询网络失败保留等待错误日志及原票据，后续恢复不重提也不自动取消', async () => {
  for (const action of featureActions) {
    const name = operation(action); let submits = 0; let reads = 0; let cancels = 0; let restored = false;
    const running: ApiResult<TaskRecord> = { data: { id: 'feature-job', operation: name, status: 'running', error: null, result: null }, logId: 'network-submit-log' };
    const tools = createToolSupply({
      submit: async () => { submits++; return running; },
      getJob: async () => {
        reads++;
        if (!restored) throw new ApiError('network', 'query_unavailable', '查询连接中断，任务状态未确认', null, 'network-query-log');
        return completed(name, action === 'status' ? statusResult() : prepareResult(), 'network-resume-log');
      },
      cancelJob: async () => { cancels++; throw new Error('等待失败不得自动取消'); },
    }, { pollIntervalMs: 0 });
    await assert.rejects(action === 'status' ? tools.runtimeFeatureStatus('assistant', signal()) : tools.prepareRuntimeFeature('assistant', signal()),
      (error: unknown) => error instanceof JobWaitFailure && error.job.id === running.data.id && error.job.status === 'running'
        && error.submitLogId === 'network-submit-log' && error.logId === 'network-query-log' && error.lastKnownLogId === 'network-submit-log');
    restored = true;
    const ticket: JobTicket = { id: running.data.id, operation: name, submitLogId: running.logId };
    const outcome = await (action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', signal())
      : tools.resumePrepareRuntimeFeature(ticket, 'assistant', signal()));
    assert.equal(outcome.submitLogId, 'network-submit-log'); assert.equal(outcome.logId, 'network-resume-log');
    assert.equal(submits, 1); assert.equal(reads, 2); assert.equal(cancels, 0); tools.dispose();
  }
});

test('预先取消及实例销毁后所有运行时功能任务入口零调用', async () => {
  let calls = 0;
  const unused = async (): Promise<ApiResult<TaskRecord>> => { calls++; throw new Error('已撤销入口不得访问任务端口'); };
  const tools = createToolSupply({ submit: unused, getJob: unused, cancelJob: unused });
  const controller = new AbortController(); controller.abort();
  for (const requestSignal of [controller.signal, signal()]) {
    if (!requestSignal.aborted) tools.dispose();
    for (const action of featureActions) {
      const ticket: JobTicket = { id: 'feature-job', operation: operation(action), submitLogId: null };
      const cancelled = (error: unknown) => error instanceof ApiError && error.kind === 'cancelled';
      await assert.rejects(action === 'status' ? tools.runtimeFeatureStatus('assistant', requestSignal)
        : tools.prepareRuntimeFeature('assistant', requestSignal), cancelled);
      await assert.rejects(action === 'status' ? tools.resumeRuntimeFeatureStatus(ticket, 'assistant', requestSignal)
        : tools.resumePrepareRuntimeFeature(ticket, 'assistant', requestSignal), cancelled);
      await assert.rejects(tools.query(ticket, requestSignal), cancelled);
      await assert.rejects(tools.cancel(ticket, requestSignal), cancelled);
    }
  }
  assert.equal(calls, 0); tools.dispose();
});

test('实例销毁终止忽略信号的在途查询，晚到失败被消费且不自动取消服务器', async () => {
  for (const action of featureActions) {
    const name = operation(action);
    const blocked = deferred<ApiResult<TaskRecord>>(); const entered = deferred<AbortSignal>();
    let submits = 0; let cancels = 0;
    const running: ApiResult<TaskRecord> = { data: { id: 'feature-job', operation: name, status: 'running', error: null, result: null }, logId: 'dispose-submit-log' };
    const tools = createToolSupply({
      submit: async () => { submits++; return running; },
      getJob: async (_id, requestSignal) => { entered.resolve(requestSignal); return blocked.promise; },
      cancelJob: async () => { cancels++; throw new Error('销毁等待不得取消服务器'); },
    }, { pollIntervalMs: 0 });
    const waiting = action === 'status' ? tools.runtimeFeatureStatus('assistant', signal()) : tools.prepareRuntimeFeature('assistant', signal());
    const stopped = assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure
      && error.job.id === running.data.id && error.submitLogId === 'dispose-submit-log' && error.lastKnownLogId === 'dispose-submit-log');
    const requestSignal = await entered.promise; tools.dispose(); await stopped;
    assert.equal(requestSignal.aborted, true);
    blocked.reject(new Error('销毁后的晚到查询失败'));
    await assert.rejects(blocked.promise, /晚到查询失败/); await assert.rejects(waiting, JobWaitFailure);
    assert.equal(submits, 1); assert.equal(cancels, 0);
  }
});
