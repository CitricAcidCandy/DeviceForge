import './public-imports.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HostError } from '@deviceforge/plugin-sdk';
import type { HostResult, Job, JsonValue } from '@deviceforge/plugin-sdk';
import {
  createSettings, SettingsJobFailure, SettingsWaitFailure, convertLegacyFiles, isJsonData,
} from '../src/model/index.ts';
import type { SettingsGateway, SettingsOwner, SettingsTicket } from '../src/model/index.ts';

function result(operation: string, status: Job['status'], value: JsonValue = null): HostResult<Job> {
  return { data: { id: 'settings-job', operation, status, result: value, error: status === 'failed' ? 'revision_conflict' : null }, logId: 'log-current' };
}
function gateway(overrides: Partial<SettingsGateway> = {}): SettingsGateway {
  return {
    submit: async (operation) => result(operation, 'succeeded', { result: { format_version: 1, revision: '1', sections: {} }, artifacts: [] }),
    getJob: async () => { throw new Error('不应读取任务'); },
    cancelJob: async () => { throw new Error('不应取消任务'); },
    ...overrides,
  };
}
const owner: SettingsOwner = { scope: 'user', owner_id: 'local' };
const signal = () => new AbortController().signal;

test('修订写入只提交一次，冲突保留调用方草稿与日志，不自动重试', async () => {
  let submissions = 0;
  const input = { ...owner, section: 'general', expected_revision: '7', value: { prefix: '工作-' } };
  const settings = createSettings(gateway({
    submit: async (operation, actual) => {
      submissions++; assert.deepEqual(actual, input);
      return result(operation, 'failed');
    },
  }));
  await assert.rejects(settings.set(input, signal()), (error: unknown) => {
    assert.ok(error instanceof SettingsJobFailure);
    assert.equal(error.logId, 'log-current');
    assert.equal(error.job.error, 'revision_conflict');
    return true;
  });
  assert.deepEqual(input.value, { prefix: '工作-' });
  assert.equal(input.expected_revision, '7');
  assert.equal(submissions, 1);
  settings.dispose();
});

test('接受后的等待取消保留原任务，恢复只查询，不重提写入', async () => {
  let submissions = 0, reads = 0, cancellations = 0;
  const controller = new AbortController();
  const settings = createSettings(gateway({
    submit: async (operation) => { submissions++; return result(operation, 'queued'); },
    getJob: async () => {
      reads++;
      if (reads === 1) { controller.abort(); return new Promise(() => undefined); }
      return result('plugin.settings.set', 'succeeded', { result: { format_version: 1, revision: '8', sections: { general: { prefix: '工作-' } } }, artifacts: [] });
    },
    cancelJob: async () => { cancellations++; return result('plugin.settings.set', 'cancelled'); },
  }), { pollIntervalMs: 0 });
  let ticket: SettingsTicket | null = null;
  await assert.rejects(settings.set({
    ...owner, section: 'general', expected_revision: '7', value: { prefix: '工作-' },
  }, controller.signal), (error: unknown) => {
    assert.ok(error instanceof SettingsWaitFailure);
    assert.equal(error.job.id, 'settings-job');
    ticket = { id: error.job.id, operation: error.job.operation, submitLogId: error.submitLogId };
    return true;
  });
  assert.ok(ticket);
  const resumed = await settings.resume('set', ticket, signal());
  assert.equal(resumed.data.revision, '8');
  assert.equal(submissions, 1); assert.equal(reads, 2); assert.equal(cancellations, 0);
  settings.dispose();
});

test('卸载撤销读取等待，忽略取消的旧结果不能成为成功结果', async () => {
  let complete: ((value: HostResult<Job>) => void) | undefined;
  const settings = createSettings(gateway({
    submit: async (operation) => result(operation, 'running'),
    getJob: () => new Promise((resolve) => { complete = resolve; }),
  }), { pollIntervalMs: 0 });
  const pending = settings.list(owner, signal());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(complete);
  settings.dispose();
  await assert.rejects(pending, SettingsWaitFailure);
  complete(result('plugin.settings.list', 'succeeded', { result: { format_version: 1, revision: '9', sections: {} }, artifacts: [] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('任务身份、原配置区和额外产物均严格核对', async () => {
  const settings = createSettings(gateway({
    submit: async (operation) => result(operation, 'succeeded', { result: { format_version: 1, revision: '1', section: 'other', value: {} }, artifacts: [] }),
  }));
  await assert.rejects(settings.get({ ...owner, section: 'general' }, signal()), (error: unknown) =>
    error instanceof HostError && error.kind === 'protocol');
  assert.throws(() => settings.resume('set', {
    id: 'settings-job', operation: 'plugin.settings.delete', submitLogId: null,
  }, signal()), (error: unknown) => error instanceof HostError && error.code === 'invalid_settings_ticket');
  settings.dispose();
});

test('旧备份名称和远端提交回执保留原兼容规则', async () => {
  const legacy = convertLegacyFiles([
    { name: 'dynamicSnalysisHooks.json', text: '[]' },
    { name: 'packageSdk.json', text: '{}' },
  ]);
  assert.ok('dynamicSnalysisHooks' in legacy);
  assert.ok('packageSDK' in legacy);
  assert.throws(() => convertLegacyFiles([{ name: 'unknown.json', text: '{}' }]));
  const settings = createSettings(gateway({
    submit: async (operation) => result(operation, 'succeeded', { result: {
      format_version: 1, section: 'deviceInfo', value: {}, source: 'remote',
      backup_updated: true, revision: '5', remote_committed: true,
    }, artifacts: [] }),
  }));
  await assert.rejects(settings.saveRemote({
    ...owner, section: 'deviceInfo', expected_revision: '4', value: {}, write_local_backup: false,
  }, signal()), (error: unknown) => error instanceof HostError && error.kind === 'protocol');
  settings.dispose();
});

test('配置输入拒绝 getter、循环及过深结构，不触发宿主调用', async () => {
  let calls = 0, getters = 0;
  const settings = createSettings(gateway({ submit: async () => { calls++; throw new Error('不应提交'); } }));
  const value: unknown = Object.defineProperty({}, 'hidden', { enumerable: true, get() { getters++; return 1; } });
  assert.equal(isJsonData(value), false); assert.equal(getters, 0);
  let nested: JsonValue = null;
  for (let i = 0; i < 66; i++) nested = { child: nested };
  await assert.rejects(async () => settings.set({ ...owner, section: 'general', expected_revision: '1', value: nested }, signal()));
  assert.equal(calls, 0);
  settings.dispose();
});
