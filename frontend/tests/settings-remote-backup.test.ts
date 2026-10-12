import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettings } from '../src/features/settings/index.ts';
import type { RemoteSettingsWrite } from '../src/features/settings/remote.ts';
import type { SettingsWrite } from '../src/features/settings/types.ts';
import { ApiError } from '../src/shared/api/index.ts';
import type { ApiResult } from '../src/shared/api/index.ts';
import { JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JobTicket, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';

const operation = 'plugin.settings.remote.save';
const ticket: JobTicket = { id: 'remote-save-job', operation, submitLogId: 'save-submit-log' };

function writeInput(): SettingsWrite {
  return { scope: 'user', owner_id: 'lemon', section: 'permissions', expected_revision: '7', value: '{"keep":"字符串"}' };
}
function savedResult(backup: boolean, value: JsonData = writeInput().value): JsonData {
  return { format_version: 1, section: 'permissions', value, source: 'remote',
    remote_committed: true, backup_updated: backup, revision: backup ? '8' : null };
}
function completed(result: JsonData, logId = 'save-result-log'): ApiResult<TaskRecord> {
  return { data: { id: ticket.id, operation, status: 'succeeded', error: null, result: { result, artifacts: [] } }, logId };
}
function gateway(result: JsonData, seen: { operation: string; input: JsonData }[]): JobGateway {
  return {
    submit: async (name, input) => { seen.push({ operation: name, input }); return completed(result); },
    getJob: async () => { throw new Error('终态提交不应查询'); },
    cancelJob: async () => { throw new Error('未请求服务器取消'); },
  };
}

test('远端保存省略开关不补字段，显式true和false原样提交一次', async () => {
  for (const choice of [undefined, true, false]) {
    const seen: { operation: string; input: JsonData }[] = [];
    const input: RemoteSettingsWrite = { ...writeInput(), ...(choice === undefined ? {} : { write_local_backup: choice }) };
    const settings = createSettings(gateway(savedResult(choice !== false), seen));
    const result = await settings.saveRemote(input, signal());
    assert.equal(seen.length, 1); assert.equal(seen[0]?.operation, operation);
    assert.deepEqual(seen[0]?.input, input);
    assert.equal(Object.hasOwn(input, 'write_local_backup'), choice !== undefined);
    assert.equal(result.data.value, writeInput().value);
    assert.equal(result.data.backup_updated, choice !== false);
    assert.equal(result.data.revision, choice === false ? null : '8');
    assert.equal(result.data.remote_committed, true); assert.equal(result.logId, 'save-result-log');
    settings.dispose();
  }
});

test('备份开关拒绝显式undefined和所有非布尔值，保存及恢复均零提交零查询', () => {
  const seen: { operation: string; input: JsonData }[] = [];
  let queries = 0;
  const settings = createSettings({ ...gateway(savedResult(false), seen),
    getJob: async () => { queries++; return completed(savedResult(false)); },
  });
  for (const value of [undefined, null, 'false', 'true', 0, 1, NaN, Infinity, [], {}, () => false]) {
    // 模拟未经类型检查的运行时输入，不用断言绕过业务类型。
    const input = writeInput();
    Object.defineProperty(input, 'write_local_backup', { value, enumerable: true });
    assert.throws(() => settings.saveRemote(input, signal()), ApiError);
    assert.throws(() => settings.resumeRemoteSave(ticket, input, signal()), ApiError);
  }
  const invalidContent = { ...writeInput(), value: Infinity, write_local_backup: false };
  assert.throws(() => settings.saveRemote(invalidContent, signal()), ApiError);
  assert.equal(seen.length, 0); assert.equal(queries, 0); settings.dispose();
});

test('只移除保存开关后按原规则校验其他字段，普通set和远端load拒绝该开关', () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const settings = createSettings(gateway(savedResult(false), seen));
  for (const choice of [true, false]) {
    const input = { ...writeInput(), write_local_backup: choice };
    assert.throws(() => settings.set(input, signal()), ApiError);
    const load = { scope: input.scope, owner_id: input.owner_id, section: input.section, expected_revision: input.expected_revision, write_local_backup: choice };
    assert.throws(() => settings.loadRemote(load, signal()), ApiError);
    assert.throws(() => settings.resumeRemoteLoad({ ...ticket, operation: 'plugin.settings.remote.load' }, load, signal()), ApiError);
  }
  for (const input of [{ ...writeInput(), write_local_backup: false, extra: true },
    { ...writeInput(), write_local_backup: true, expected_revision: '01' }]) {
    assert.throws(() => settings.saveRemote(input, signal()), ApiError);
  }
  assert.equal(seen.length, 0); settings.dispose();
});

test('保存恢复省略或保留原开关，只查询原Job不提交且保留提交和查询日志', async () => {
  for (const choice of [undefined, true, false]) {
    const seen: { operation: string; input: JsonData }[] = []; const queries: string[] = [];
    const settings = createSettings({ ...gateway(savedResult(choice !== false), seen),
      getJob: async (id) => { queries.push(id); return completed(savedResult(choice !== false), 'resume-query-log'); },
    });
    const input: RemoteSettingsWrite = { ...writeInput(), ...(choice === undefined ? {} : { write_local_backup: choice }) };
    const result = await settings.resumeRemoteSave(ticket, input, signal());
    assert.deepEqual(queries, [ticket.id]); assert.equal(seen.length, 0);
    assert.equal(result.data.backup_updated, choice !== false);
    assert.equal(result.submitLogId, ticket.submitLogId); assert.equal(result.logId, 'resume-query-log');
    settings.dispose();
  }
});

test('关闭备份却返回备份成功时保存和恢复都拒绝，并保留各自真实日志', async () => {
  const input: RemoteSettingsWrite = { ...writeInput(), write_local_backup: false };
  const seen: { operation: string; input: JsonData }[] = [];
  const settings = createSettings({ ...gateway(savedResult(true), seen),
    getJob: async () => completed(savedResult(true), 'bad-backup-query-log'),
  });
  await assert.rejects(settings.saveRemote(input, signal()), (error: unknown) => error instanceof ApiError
    && error.code === 'invalid_business_result' && error.logId === 'save-result-log');
  await assert.rejects(settings.resumeRemoteSave(ticket, input, signal()), (error: unknown) => error instanceof ApiError
    && error.code === 'invalid_business_result' && error.logId === 'bad-backup-query-log');
  assert.equal(seen.length, 1); settings.dispose();
});

test('启用或省略备份仍接受远端已提交但本地备份失败的旧结果', async () => {
  for (const choice of [undefined, true]) {
    const seen: { operation: string; input: JsonData }[] = [];
    const settings = createSettings(gateway(savedResult(false, null), seen));
    const input: RemoteSettingsWrite = { ...writeInput(), value: null, ...(choice === undefined ? {} : { write_local_backup: choice }) };
    const result = await settings.saveRemote(input, signal());
    assert.equal(result.data.backup_updated, false); assert.equal(result.data.revision, null);
    assert.equal(result.data.value, null);
    assert.equal(result.data.remote_committed, true); assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.input, input); settings.dispose();
  }
});

test('远端保存提交结果未知时保留原失败，不重试也不查询或重放', async () => {
  let submits = 0; let queries = 0;
  const failure = new ApiError('network', 'network_failure', '远端保存任务提交响应未知');
  const settings = createSettings({
    submit: async () => { submits++; throw failure; },
    getJob: async () => { queries++; return completed(savedResult(false)); },
    cancelJob: async () => { throw new Error('不得自动取消未知任务'); },
  });
  await assert.rejects(settings.saveRemote({ ...writeInput(), write_local_backup: false }, signal()), (error: unknown) => error === failure);
  assert.equal(submits, 1); assert.equal(queries, 0); settings.dispose();
});

test('关闭备份保存取消等待后拒绝晚到成功，不自动取消服务器或再次提交', async () => {
  const blocked = deferred<ApiResult<TaskRecord>>(); const entered = deferred<void>();
  let submits = 0; let cancels = 0;
  const settings = createSettings({
    submit: async () => { submits++; return { data: { id: ticket.id, operation, status: 'running', result: null, error: null }, logId: ticket.submitLogId }; },
    getJob: async () => { entered.resolve(); return blocked.promise; },
    cancelJob: async () => { cancels++; return completed(savedResult(false)); },
  }, { pollIntervalMs: 0 });
  const controller = new AbortController();
  const waiting = settings.saveRemote({ ...writeInput(), write_local_backup: false }, controller.signal);
  const cancelled = assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure
    && error.job.id === ticket.id && error.submitLogId === ticket.submitLogId
    && error.cause instanceof ApiError && error.cause.kind === 'cancelled');
  await entered.promise; controller.abort(); await cancelled;
  blocked.resolve(completed(savedResult(false), 'late-save-log'));
  assert.equal(submits, 1); assert.equal(cancels, 0); settings.dispose();
});
