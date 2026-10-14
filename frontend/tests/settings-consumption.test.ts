import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettings } from '../src/features/settings/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import {
  createJobRunner,
  downloadPublishedArtifact,
  JobFailure,
  JobWaitFailure,
  requireJson,
} from '../src/shared/jobs/index.ts';
import type { JobGateway, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import type { HostResult } from '../src/plugin-sdk/index.ts';
import { deferred, signal } from './fixtures.ts';

const owner = { scope: 'user', owner_id: 'lemon' };
function complete(operation: string, result: JsonData): HostResult<TaskRecord> {
  return {
    data: {
      id: 'job-1',
      operation,
      status: 'succeeded',
      result: { result, artifacts: [] },
      error: null,
    },
    logId: 'result-log',
  };
}
function gateway(respond: (operation: string, input: JsonData) => JsonData): JobGateway {
  return {
    submit: async (operation, input) => complete(operation, respond(operation, input)),
    getJob: async () => {
      throw new Error('终态不应轮询');
    },
    cancelJob: async () => {
      throw new Error('未授权取消');
    },
  };
}
function user(): { scope: 'user'; owner_id: string } {
  return { scope: 'user', owner_id: owner.owner_id };
}

test('五配置操作提交真实命名空间、JSON null和修订原值', async () => {
  const calls: { operation: string; input: JsonData }[] = [];
  const settings = createSettings(
    gateway((operation, input) => {
      calls.push({ operation, input });
      return operation.endsWith('.get')
        ? { format_version: 1, revision: '18446744073709551614', section: 'theme', value: null }
        : { format_version: 1, revision: '18446744073709551614', sections: { theme: null } };
    }),
  );
  await settings.list(user(), signal());
  assert.equal((await settings.get({ ...user(), section: 'theme' }, signal())).data.value, null);
  await settings.set(
    { ...user(), section: 'theme', value: null, expected_revision: '18446744073709551613' },
    signal(),
  );
  await settings.delete({ ...user(), section: 'theme', expected_revision: '3' }, signal());
  await settings.import(
    { ...user(), sections: { deviceInfo: [], dynamicSnalysisHooks: {} }, expected_revision: '4' },
    signal(),
  );
  assert.deepEqual(
    calls.map((call) => call.operation),
    [
      'plugin.settings.list',
      'plugin.settings.get',
      'plugin.settings.set',
      'plugin.settings.delete',
      'plugin.settings.import',
    ],
  );
  assert.deepEqual(calls[2]?.input, {
    ...user(),
    section: 'theme',
    value: null,
    expected_revision: '18446744073709551613',
  });
  assert.equal(calls.length, 5);
  settings.dispose();
});

test('拒绝路径身份、非规范修订、空导入和未知输入字段且不提交', () => {
  let submits = 0;
  const settings = createSettings(
    gateway(() => {
      submits++;
      return {};
    }),
  );
  assert.throws(() => settings.list({ ...user(), owner_id: '../escape' }, signal()), ApiError);
  for (const revision of ['01', '-1', '18446744073709551616', '1.0']) {
    assert.throws(
      () => settings.delete({ ...user(), section: 'theme', expected_revision: revision }, signal()),
      ApiError,
    );
  }
  assert.throws(
    () => settings.import({ ...user(), sections: {}, expected_revision: '0' }, signal()),
    ApiError,
  );
  const extra = { ...user(), path: 'C:/secrets' };
  assert.throws(() => settings.list(extra, signal()), ApiError);
  assert.equal(submits, 0);
  settings.dispose();
});

test('不兼容结果、错配置区及错任务身份保留日志', async () => {
  const wrapped = createSettings(
    gateway(() => ({ result: { format_version: 1, revision: '1', sections: {} }, artifacts: [] })),
  );
  await assert.rejects(
    wrapped.list(user(), signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'invalid_business_result' &&
      error.logId === 'result-log',
  );
  wrapped.dispose();
  const wrong = createSettings(
    gateway(() => ({ format_version: 1, revision: '1', section: 'different', value: {} })),
  );
  await assert.rejects(wrong.get({ ...user(), section: 'theme' }, signal()), ApiError);
  wrong.dispose();
  const identity = createSettings({
    ...gateway(() => ({})),
    submit: async () => complete('plugin.settings.delete', {}),
  });
  await assert.rejects(
    identity.list(user(), signal()),
    (error: unknown) =>
      error instanceof ApiError && error.code === 'invalid_job' && error.logId === 'result-log',
  );
  identity.dispose();
});

test('失败保留原文；轮询保留提交与查询日志且仅提交一次', async () => {
  const failing = createSettings({
    ...gateway(() => ({})),
    submit: async (operation) => ({
      data: {
        id: 'job-1',
        operation,
        status: 'failed',
        result: null,
        error: '配置修订冲突，请重查后修改',
      },
      logId: 'failure-log',
    }),
  });
  await assert.rejects(
    failing.set({ ...user(), section: 'theme', value: {}, expected_revision: '0' }, signal()),
    (error: unknown) =>
      error instanceof JobFailure &&
      error.message === '配置修订冲突，请重查后修改' &&
      error.logId === 'failure-log',
  );
  failing.dispose();
  let submitted = 0;
  const settings = createSettings(
    {
      ...gateway(() => ({})),
      submit: async (operation) => {
        submitted++;
        return {
          data: { id: 'job-1', operation, status: 'queued', result: null, error: null },
          logId: 'submit-log',
        };
      },
      getJob: async () =>
        complete('plugin.settings.list', { format_version: 1, revision: '0', sections: {} }),
    },
    { pollIntervalMs: 0 },
  );
  const outcome = await settings.list(user(), signal());
  assert.equal(submitted, 1);
  assert.equal(outcome.submitLogId, 'submit-log');
  assert.equal(outcome.logId, 'result-log');
  settings.dispose();
});

test('取消等待不取消服务器，已知任务可恢复且不重复提交', async () => {
  const entered = deferred<void>();
  const blocked = deferred<HostResult<TaskRecord>>();
  let submits = 0;
  let cancels = 0;
  let restore = false;
  const settings = createSettings(
    {
      submit: async (operation) => {
        submits++;
        return {
          data: { id: 'job-1', operation, status: 'running', result: null, error: null },
          logId: 'submit-log',
        };
      },
      getJob: async () => {
        entered.resolve();
        return restore
          ? complete('plugin.settings.list', { format_version: 1, revision: '0', sections: {} })
          : blocked.promise;
      },
      cancelJob: async () => {
        cancels++;
        return {
          data: {
            id: 'job-1',
            operation: 'plugin.settings.list',
            status: 'running',
            result: null,
            error: null,
          },
          logId: 'cancel-log',
        };
      },
    },
    { pollIntervalMs: 0 },
  );
  const controller = new AbortController();
  const waiting = settings.list(user(), controller.signal);
  const failed = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.job.id === 'job-1' &&
      error.submitLogId === 'submit-log',
  );
  await entered.promise;
  controller.abort();
  await failed;
  assert.equal(cancels, 0);
  restore = true;
  const ticket = { id: 'job-1', operation: 'plugin.settings.list', submitLogId: 'submit-log' };
  assert.equal((await settings.resume('list', ticket, signal())).data.revision, '0');
  assert.equal((await settings.cancel(ticket, signal())).data.status, 'running');
  assert.equal(cancels, 1);
  assert.equal(submits, 1);
  settings.dispose();
  blocked.resolve(
    complete('plugin.settings.list', { format_version: 1, revision: '9', sections: {} }),
  );
});

test('销毁结束忽略取消的等待，并拒绝新增提交', async () => {
  const pending = deferred<HostResult<TaskRecord>>();
  let submits = 0;
  const settings = createSettings({
    ...gateway(() => ({})),
    submit: async () => {
      submits++;
      return pending.promise;
    },
  });
  const waiting = settings.list(user(), signal());
  const rejected = assert.rejects(waiting, ApiError);
  settings.dispose();
  await rejected;
  await assert.rejects(settings.list(user(), signal()), ApiError);
  assert.equal(submits, 1);
  pending.resolve(
    complete('plugin.settings.list', { format_version: 1, revision: '0', sections: {} }),
  );
});

test('JSON边界拒绝序列化会变值或丢字段的输入', () => {
  const cycle: { value?: unknown } = {};
  cycle.value = cycle;
  const sparse: unknown[] = [];
  sparse.length = 1;
  for (const value of [
    cycle,
    sparse,
    { value: Infinity },
    { value: undefined },
    new Date(0),
    {
      get value() {
        throw new Error('不得触发访问器');
      },
    },
  ])
    assert.throws(() => requireJson(value), ApiError);
});

test('远端读取消费本地备份回退，远端保存保留提交与备份CAS分别结果', async () => {
  const seen: { operation: string; input: JsonData }[] = [];
  const settings = createSettings(
    gateway((operation, input) => {
      seen.push({ operation, input });
      return operation.endsWith('.load')
        ? {
            format_version: 1,
            section: 'permissions',
            value: [],
            source: 'local',
            backup_updated: false,
            revision: '3',
            remote_committed: false,
          }
        : {
            format_version: 1,
            section: 'permissions',
            value: null,
            source: 'remote',
            backup_updated: false,
            revision: null,
            remote_committed: true,
          };
    }),
  );
  const input = { ...user(), section: 'permissions', expected_revision: '3' };
  assert.equal((await settings.loadRemote(input, signal())).data.source, 'local');
  const saved = await settings.saveRemote({ ...input, value: null }, signal());
  assert.equal(saved.data.remote_committed, true);
  assert.equal(saved.data.backup_updated, false);
  assert.equal(saved.data.revision, null);
  assert.deepEqual(
    seen.map((call) => call.operation),
    ['plugin.settings.remote.load', 'plugin.settings.remote.save'],
  );
  assert.deepEqual(seen[1]?.input, { ...input, value: null });
  settings.dispose();
});

test('远端区限定旧清单，不能将保存失败伪装本地成功或重试', async () => {
  const local = createSettings(
    gateway(() => ({
      format_version: 1,
      section: 'permissions',
      value: {},
      source: 'local',
      backup_updated: false,
      revision: '1',
      remote_committed: false,
    })),
  );
  assert.throws(
    () => local.loadRemote({ ...user(), section: 'other', expected_revision: '0' }, signal()),
    ApiError,
  );
  await assert.rejects(
    local.saveRemote(
      { ...user(), section: 'permissions', value: {}, expected_revision: '0' },
      signal(),
    ),
    ApiError,
  );
  local.dispose();
  let submits = 0;
  const failing = createSettings({
    ...gateway(() => ({})),
    submit: async (operation) => {
      submits++;
      return {
        data: {
          id: 'remote-failed',
          operation,
          status: 'failed',
          result: null,
          error: '远端配置请求失败',
        },
        logId: 'remote-log',
      };
    },
  });
  await assert.rejects(
    failing.saveRemote(
      { ...user(), section: 'permissions', value: {}, expected_revision: '0' },
      signal(),
    ),
    (error: unknown) => error instanceof JobFailure && error.message === '远端配置请求失败',
  );
  assert.equal(submits, 1);
  failing.dispose();
});

test('远端读取与保存分别消费备份成功和备份失败，显式null不丢失', async () => {
  for (const save of [false, true]) {
    for (const backup of [false, true]) {
      const settings = createSettings(
        gateway(() => ({
          format_version: 1,
          section: 'permissions',
          value: null,
          source: 'remote',
          backup_updated: backup,
          revision: backup ? '8' : null,
          remote_committed: save,
        })),
      );
      const input = { ...user(), section: 'permissions', expected_revision: '7', value: null };
      const result = await (save
        ? settings.saveRemote(input, signal())
        : settings.loadRemote(
            { ...user(), section: 'permissions', expected_revision: '7' },
            signal(),
          ));
      assert.equal(result.data.value, null);
      assert.equal(result.data.backup_updated, backup);
      assert.equal(result.data.remote_committed, save);
      assert.equal(result.logId, 'result-log');
      settings.dispose();
    }
  }
});

test('拒绝远端状态自相矛盾，缺失提交标志和错备份修订保留日志', async () => {
  const valid = {
    format_version: 1,
    section: 'permissions',
    value: null,
    source: 'remote',
    backup_updated: true,
    revision: '8',
    remote_committed: false,
  };
  for (const value of [
    { ...valid, revision: null },
    { ...valid, backup_updated: false },
    { ...valid, remote_committed: true },
    { ...valid, source: 'local', backup_updated: false, remote_committed: true },
    {
      format_version: 1,
      section: 'permissions',
      value: null,
      source: 'local',
      backup_updated: false,
      revision: '8',
    },
  ]) {
    const settings = createSettings(gateway(() => value));
    await assert.rejects(
      settings.loadRemote({ ...user(), section: 'permissions', expected_revision: '7' }, signal()),
      (error: unknown) => error instanceof ApiError && error.logId === 'result-log',
    );
    settings.dispose();
  }
});

test('远端保存取消等待后仅查询原Job并恢复，不重新提交，晚到旧结果不成功', async () => {
  const blocked = deferred<HostResult<TaskRecord>>();
  const entered = deferred<void>();
  let submits = 0;
  let restored = false;
  const result = {
    format_version: 1,
    section: 'permissions',
    value: null,
    source: 'remote',
    backup_updated: false,
    revision: null,
    remote_committed: true,
  };
  const settings = createSettings(
    {
      ...gateway(() => result),
      submit: async (operation) => {
        submits++;
        return {
          data: { id: 'job-1', operation, status: 'running', error: null, result: null },
          logId: 'submit-log',
        };
      },
      getJob: async () => {
        entered.resolve();
        return restored ? complete('plugin.settings.remote.save', result) : blocked.promise;
      },
    },
    { pollIntervalMs: 0 },
  );
  const input = { ...user(), section: 'permissions', expected_revision: '7', value: null };
  const controller = new AbortController();
  const waiting = settings.saveRemote(input, controller.signal);
  const cancelled = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.logId === null &&
      error.lastKnownLogId === 'submit-log',
  );
  await entered.promise;
  controller.abort();
  await cancelled;
  restored = true;
  const ticket = {
    id: 'job-1',
    operation: 'plugin.settings.remote.save',
    submitLogId: 'submit-log',
  };
  assert.equal((await settings.query(ticket, signal())).data.status, 'succeeded');
  assert.equal(
    (await settings.resumeRemoteSave(ticket, input, signal())).data.remote_committed,
    true,
  );
  assert.equal(submits, 1);
  blocked.resolve(complete(ticket.operation, result));
  settings.dispose();
});

test('查询HTTP失败使用当次失败日志，最后已确认Job日志独立保留', async () => {
  const failure = new ApiError('http', 'unavailable', '查询服务不可用', 503, 'failed-query-log');
  const settings = createSettings(
    {
      ...gateway(() => ({})),
      submit: async (operation) => ({
        data: { id: 'job-1', operation, status: 'running', result: null, error: null },
        logId: 'submit-log',
      }),
      getJob: async () => {
        throw failure;
      },
    },
    { pollIntervalMs: 0 },
  );
  await assert.rejects(
    settings.list(user(), signal()),
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.logId === 'failed-query-log' &&
      error.lastKnownLogId === 'submit-log' &&
      error.submitLogId === 'submit-log' &&
      error.cause === failure,
  );
  settings.dispose();
});

test('解码期间销毁拒绝终态晚到成功，并保留已收到的日志', async () => {
  const jobs = createJobRunner(gateway(() => ({})));
  await assert.rejects(
    jobs.execute('plugin.settings.list', {}, signal(), () => {
      jobs.dispose();
      return {};
    }),
    (error: unknown) =>
      error instanceof JobWaitFailure &&
      error.logId === 'result-log' &&
      error.lastKnownLogId === 'result-log',
  );
});

test('产物原字节处理取消保留真实下载日志，忽略信号的晚到字节被拒绝', async () => {
  const bytes = deferred<ArrayBuffer>();
  const entered = deferred<void>();
  class DelayedBlob extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> {
      entered.resolve();
      return bytes.promise;
    }
  }
  const blob = new DelayedBlob(['abc']);
  const controller = new AbortController();
  const published = {
    result: null,
    artifacts: [
      {
        id: 'artifact-1',
        filename: 'result.json',
        media_type: 'application/json',
        size: 3,
        created_at: 0,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
    ],
  };
  const download = downloadPublishedArtifact(
    { download: async () => ({ data: blob, logId: 'download-log' }) },
    published,
    'result.json',
    controller.signal,
  );
  const cancelled = assert.rejects(
    download,
    (error: unknown) =>
      error instanceof ApiError && error.kind === 'cancelled' && error.logId === 'download-log',
  );
  await entered.promise;
  controller.abort();
  await cancelled;
  bytes.resolve(new ArrayBuffer(3));
});
