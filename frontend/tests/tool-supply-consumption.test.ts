import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolSupply } from '../src/features/tool-supply/index.ts';
import { ApiError } from '../src/shared/api/index.ts';
import { JobFailure, JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import type { ApiResult } from '../src/shared/api/index.ts';
import { deferred, signal } from './fixtures.ts';

const module = { module_id: 'frida', kind: 'tool', required: true, feature_key: null, available_version: '17.1.0', installed_version: null, entry_present: false, action: 'install', size: 40 };
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return { submit: async (operation, input) => ({ data: { id: 'job-tool', operation, status: 'succeeded', error: null, result: { result: respond(operation, input), artifacts: [] } }, logId: 'tool-log' }),
    getJob: async () => { throw new Error('终态不应查询'); }, cancelJob: async () => { throw new Error('未授权取消'); } };
}
test('四工具供应操作消费清单、计划、安装摘要及移除', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const tools = createToolSupply(gateway((operation, input) => {
    seen.push({ operation, input });
    if (operation.endsWith('.catalog')) return { manifest_version: 'v1', source_error: null, modules: [module] };
    if (operation.endsWith('.plan')) return { manifest_version: 'v1', download_bytes: 40, modules: [module] };
    if (operation.endsWith('.install')) return { module_id: 'frida', version: '17.1.0', changed: true, sha256: 'a'.repeat(64) };
    return { module_id: 'frida', removed: true, version: '17.1.0' };
  }));
  assert.equal((await tools.catalog(signal())).data.modules[0]?.action, 'install');
  assert.equal((await tools.plan(['frida'], signal())).data.download_bytes, 40);
  assert.equal((await tools.install('frida', signal())).data.sha256, 'a'.repeat(64));
  assert.equal((await tools.remove('frida', signal())).data.removed, true);
  assert.deepEqual(seen.map((item) => item.operation), ['plugin.tool-supply.catalog', 'plugin.tool-supply.plan', 'plugin.tool-supply.install', 'plugin.tool-supply.remove']);
  assert.deepEqual(seen[1]?.input, { module_ids: ['frida'] }); tools.dispose();
});
test('清单失败仍消费本地项和真实来源错误', async () => {
  const tools = createToolSupply(gateway(() => ({ manifest_version: null, source_error: '来源不可用', modules: [{ module_id: 'frida', kind: 'tool', feature_key: null, available_version: null, installed_version: '17.1', entry_present: true, action: 'local_only' }] })));
  const result = await tools.catalog(signal()); assert.equal(result.data.source_error, '来源不可用'); assert.equal(result.data.modules[0]?.installed_version, '17.1'); tools.dispose();
});
test('拒绝路径模块和重复选择，错误计划或摘要携带日志', async () => {
  const tools = createToolSupply(gateway(() => ({ manifest_version: 'v1', download_bytes: 1, modules: [module] })));
  assert.throws(() => tools.install('../frida', signal()), ApiError); assert.throws(() => tools.install('con', signal()), ApiError); assert.throws(() => tools.plan(['frida', 'frida'], signal()), ApiError);
  await assert.rejects(tools.plan(['frida'], signal()), (error: unknown) => error instanceof ApiError && error.logId === 'tool-log'); tools.dispose();
  const checksum = createToolSupply(gateway(() => ({ module_id: 'frida', version: '17.1', changed: true, sha256: 'bad' })));
  await assert.rejects(checksum.install('frida', signal()), ApiError); checksum.dispose();
});
test('未变化安装和未安装移除保持真实布尔结果', async () => {
  const tools = createToolSupply(gateway((operation) => operation.endsWith('.install') ? { module_id: 'frida', version: '17.1', changed: false, sha256: 'a'.repeat(64) } : { module_id: 'frida', removed: false }));
  assert.equal((await tools.install('frida', signal())).data.changed, false); assert.equal((await tools.remove('frida', signal())).data.removed, false); tools.dispose();
});

test('计划消费全部选择、版本差异与真实下载量，点分版本补零且不丢精度', async () => {
  const planned = [module,
    { ...module, module_id: 'ziptool', installed_version: '17.0', entry_present: true, action: 'update', size: 10 },
    { ...module, module_id: 'repairtool', installed_version: '17.1', available_version: '17.1.0', action: 'repair', size: 20 },
    { ...module, module_id: 'currenttool', installed_version: '17.1.0.0', entry_present: true, action: 'current', size: 30 },
    { ...module, module_id: 'newertool', installed_version: '18446744073709551615', available_version: '18446744073709551614', entry_present: true, action: 'local_newer', size: 50 }];
  const seen: JsonData[] = [];
  const tools = createToolSupply(gateway((_operation, input) => { seen.push(input); return { manifest_version: 'v1', modules: planned, download_bytes: 70 }; }));
  assert.equal((await tools.plan([], signal())).data.download_bytes, 70);
  assert.equal((await tools.plan(planned.map((item) => item.module_id), signal())).data.modules.length, 5);
  assert.deepEqual(seen[0], { module_ids: [] }); tools.dispose();
});

test('拒绝计划版本与动作矛盾、重复模块、错选择和超范围下载量', async () => {
  for (const planned of [[{ ...module, action: 'update' }], [{ ...module, installed_version: '18', action: 'update' }],
    [{ ...module, installed_version: '17.1', action: 'current', entry_present: false }], [module, module], [{ ...module, module_id: 'other' }]]) {
    const tools = createToolSupply(gateway(() => ({ manifest_version: 'v1', download_bytes: 40, modules: planned })));
    await assert.rejects(tools.plan(['frida'], signal()), (error: unknown) => error instanceof ApiError && error.logId === 'tool-log'); tools.dispose();
  }
  const overflow = createToolSupply(gateway(() => ({ manifest_version: 'v1', download_bytes: Number.MAX_SAFE_INTEGER + 1, modules: [module] })));
  await assert.rejects(overflow.plan([], signal()), ApiError); overflow.dispose();
});

test('事务查询、显式取消与恢复沿用真实Job，不重复安装或假定回滚', async () => {
  const blocked = deferred<ApiResult<TaskRecord>>(); const entered = deferred<void>();
  const operation = 'plugin.tool-supply.install';
  let submits = 0; let cancels = 0; let recovered = false;
  const running: ApiResult<TaskRecord> = { data: { id: 'transaction-job', operation, status: 'running', error: null, result: null }, logId: 'transaction-submit-log' };
  const terminal: ApiResult<TaskRecord> = { data: { id: running.data.id, operation, status: 'succeeded', error: null,
    result: { result: { module_id: 'frida', version: '17.1', changed: true, sha256: 'a'.repeat(64) }, artifacts: [] } }, logId: 'transaction-query-log' };
  const tools = createToolSupply({ submit: async () => { submits++; return running; },
    getJob: async () => { entered.resolve(); return recovered ? terminal : blocked.promise; },
    cancelJob: async () => { cancels++; return { ...running, logId: 'transaction-cancel-log' }; },
  }, { pollIntervalMs: 0 });
  const controller = new AbortController(); const waiting = tools.install('frida', controller.signal);
  const cancelled = assert.rejects(waiting, (error: unknown) => error instanceof JobWaitFailure && error.job.id === 'transaction-job');
  await entered.promise; controller.abort(); await cancelled;
  const ticket = { id: running.data.id, operation, submitLogId: running.logId };
  const cancel = await tools.cancel(ticket, signal());
  assert.equal(cancel.data.status, 'running'); assert.equal(cancel.logId, 'transaction-cancel-log'); recovered = true;
  assert.equal((await tools.query(ticket, signal())).data.status, 'succeeded');
  const installed = await tools.resumeInstall(ticket, 'frida', signal());
  assert.equal(installed.data.changed, true); assert.equal(installed.logId, 'transaction-query-log'); assert.equal(installed.submitLogId, 'transaction-submit-log');
  assert.equal(submits, 1); assert.equal(cancels, 1); blocked.resolve(terminal); tools.dispose();
});

test('事务业务失败原文保留，错误摘要和错操作票据受控拒绝', async () => {
  const tools = createToolSupply({ ...gateway(() => ({})), submit: async (operation) => ({ data: { id: 'failed-job', operation, status: 'failed', error: '事务收尾失败，保留备份等待核对', result: null }, logId: 'transaction-failed-log' }) });
  await assert.rejects(tools.install('frida', signal()), (error: unknown) => error instanceof JobFailure && error.logId === 'transaction-failed-log' && error.message.includes('保留备份'));
  const foreign = { id: 'foreign', operation: 'plugin.settings.get', submitLogId: null };
  assert.throws(() => tools.query(foreign, signal()), ApiError); assert.throws(() => tools.cancel(foreign, signal()), ApiError); tools.dispose();
  for (const sha256 of [undefined, 'bad']) {
    const invalid = createToolSupply(gateway(() => ({ module_id: 'frida', version: '17.1', changed: false, ...(sha256 !== undefined ? { sha256 } : {}) })));
    await assert.rejects(invalid.install('frida', signal()), ApiError); invalid.dispose();
  }
});
