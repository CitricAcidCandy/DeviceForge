import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolSupply } from '../src/features/tool-supply/index.ts';
import type { ToolSupplyAction } from '../src/features/tool-supply/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import type { ApiResult } from '../src/services/api/index.ts';
import { JobFailure, JobWaitFailure } from '../src/shared/jobs/index.ts';
import type { JobGateway, JobTicket, JsonData, TaskRecord } from '../src/shared/jobs/index.ts';
import { deferred, signal } from './fixtures.ts';

type SourceAction = Exclude<ToolSupplyAction, 'remove'>;
const sourceActions: readonly SourceAction[] = [
  'catalog',
  'plan',
  'install',
  'runtime_feature.status',
  'runtime_feature.prepare',
];
const queryActions: readonly ('catalog' | 'runtime_feature.status')[] = [
  'catalog',
  'runtime_feature.status',
];
const featureActions: readonly ('runtime_feature.status' | 'runtime_feature.prepare')[] = [
  'runtime_feature.status',
  'runtime_feature.prepare',
];
const moduleActions: readonly ('catalog' | 'plan' | 'install')[] = ['catalog', 'plan', 'install'];
const manifestSources: readonly ('live' | 'cache')[] = ['live', 'cache'];
const operation = (action: SourceAction) => `plugin.tool-supply.${action}`;
const manifestSha256 = 'B'.repeat(64);
const sourceError = '远端清单不可用（已脱敏）';
function runtimeModule(): { [key: string]: JsonData } {
  return {
    module_id: 'node-runtime',
    kind: 'runtime',
    required: true,
    feature_key: 'assistant',
    available_version: '1.2.0',
    installed_version: '1.2',
    entry_present: true,
    action: 'current',
    size: 40,
  };
}
function installation(): { [key: string]: JsonData } {
  return { module_id: 'node-runtime', version: '1.2.0', changed: false, sha256: 'a'.repeat(64) };
}
function legacyResult(action: SourceAction): { [key: string]: JsonData } {
  switch (action) {
    case 'catalog':
      return { manifest_version: 'v1', source_error: null, modules: [runtimeModule()] };
    case 'plan':
      return { manifest_version: 'v1', download_bytes: 0, modules: [runtimeModule()] };
    case 'install':
      return installation();
    case 'runtime_feature.status':
      return {
        feature_key: 'assistant',
        manifest_version: 'v1',
        source_error: null,
        found: true,
        ready: true,
        modules: [runtimeModule()],
      };
    case 'runtime_feature.prepare':
      return {
        feature_key: 'assistant',
        manifest_version: 'v1',
        ready: true,
        modules: [installation()],
      };
  }
}
function sourceResult(action: SourceAction, source: 'live' | 'cache'): { [key: string]: JsonData } {
  return {
    ...legacyResult(action),
    manifest_version: 'v1',
    manifest_source: source,
    manifest_sha256: manifestSha256,
    source_error: source === 'live' ? null : sourceError,
  };
}
function unavailableResult(action: 'catalog' | 'runtime_feature.status'): {
  [key: string]: JsonData;
} {
  return {
    ...legacyResult(action),
    manifest_version: null,
    manifest_source: null,
    manifest_sha256: null,
    source_error: sourceError,
    ...(action === 'catalog'
      ? {
          modules: [
            {
              module_id: 'node-runtime',
              kind: 'runtime',
              feature_key: 'assistant',
              available_version: null,
              installed_version: '1.2',
              entry_present: true,
              action: 'local_only',
            },
          ],
        }
      : { modules: [], found: false, ready: false }),
  };
}
function completed(
  action: SourceAction,
  result: JsonData,
  logId = 'source-submit-log',
): ApiResult<TaskRecord> {
  return {
    data: {
      id: 'source-job',
      operation: operation(action),
      status: 'succeeded',
      error: null,
      result: { result, artifacts: [] },
    },
    logId,
  };
}
function gateway(action: SourceAction, result: JsonData): JobGateway {
  return {
    submit: async (name) => {
      assert.equal(name, operation(action));
      return completed(action, result);
    },
    getJob: async () => {
      throw new Error('终态不应继续查询');
    },
    cancelJob: async () => {
      throw new Error('未授权取消');
    },
  };
}
function execute(
  tools: ReturnType<typeof createToolSupply>,
  action: SourceAction,
  abortSignal: AbortSignal,
) {
  switch (action) {
    case 'catalog':
      return tools.catalog(abortSignal);
    case 'plan':
      return tools.plan(['node-runtime'], abortSignal);
    case 'install':
      return tools.install('node-runtime', abortSignal);
    case 'runtime_feature.status':
      return tools.runtimeFeatureStatus('assistant', abortSignal);
    case 'runtime_feature.prepare':
      return tools.prepareRuntimeFeature('assistant', abortSignal);
  }
}
function resume(
  tools: ReturnType<typeof createToolSupply>,
  action: SourceAction,
  ticket: JobTicket,
  abortSignal: AbortSignal,
) {
  switch (action) {
    case 'catalog':
      return tools.resumeCatalog(ticket, abortSignal);
    case 'plan':
      return tools.resumePlan(ticket, ['node-runtime'], abortSignal);
    case 'install':
      return tools.resumeInstall(ticket, 'node-runtime', abortSignal);
    case 'runtime_feature.status':
      return tools.resumeRuntimeFeatureStatus(ticket, 'assistant', abortSignal);
    case 'runtime_feature.prepare':
      return tools.resumePrepareRuntimeFeature(ticket, 'assistant', abortSignal);
  }
}
async function rejectResult(action: SourceAction, result: JsonData): Promise<void> {
  const tools = createToolSupply(gateway(action, result));
  await assert.rejects(
    execute(tools, action, signal()),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === 'invalid_business_result' &&
      error.logId === 'source-submit-log',
  );
  tools.dispose();
}

test('五操作完整消费 live/cache 快照、真实摘要和来源错误，保留日志而不继续查询', async () => {
  for (const action of sourceActions) {
    for (const source of manifestSources) {
      const result = sourceResult(action, source);
      const tools = createToolSupply(gateway(action, result));
      const outcome = await execute(tools, action, signal());
      assert.deepEqual(outcome.data, result);
      assert.equal(outcome.data.manifest_source, source);
      assert.equal(outcome.data.manifest_sha256, manifestSha256);
      assert.equal(outcome.submitLogId, 'source-submit-log');
      assert.equal(outcome.logId, 'source-submit-log');
      tools.dispose();
    }
  }
});

test('目录和功能状态消费无来源查询，其他三操作不能将无快照结果判成功', async () => {
  for (const action of queryActions) {
    const result = unavailableResult(action);
    const tools = createToolSupply(gateway(action, result));
    assert.deepEqual((await execute(tools, action, signal())).data, result);
    tools.dispose();
  }
  for (const action of sourceActions.filter(
    (value) => value !== 'catalog' && value !== 'runtime_feature.status',
  )) {
    await rejectResult(action, {
      ...legacyResult(action),
      manifest_version: null,
      manifest_source: null,
      manifest_sha256: null,
      source_error: sourceError,
    });
  }
});

test('五操作元数据全缺时保留旧返回形状，不补来源、摘要或安装清单版本', async () => {
  for (const action of sourceActions) {
    const result = legacyResult(action);
    const tools = createToolSupply(gateway(action, result));
    const outcome = await execute(tools, action, signal());
    assert.deepEqual(outcome.data, result);
    assert.equal(Object.hasOwn(outcome.data, 'manifest_source'), false);
    assert.equal(Object.hasOwn(outcome.data, 'manifest_sha256'), false);
    if (action === 'install') assert.equal(Object.hasOwn(outcome.data, 'manifest_version'), false);
    if (action === 'plan' || action === 'install' || action === 'runtime_feature.prepare')
      assert.equal(Object.hasOwn(outcome.data, 'source_error'), false);
    tools.dispose();
  }
  for (const action of queryActions) {
    const result = unavailableResult(action);
    delete result.manifest_source;
    delete result.manifest_sha256;
    const tools = createToolSupply(gateway(action, result));
    assert.deepEqual((await execute(tools, action, signal())).data, result);
    tools.dispose();
  }
});

test('每个操作拒绝新增标记触发的不完整组合及完整组缺任一字段', async () => {
  for (const action of sourceActions) {
    const keys =
      action === 'catalog' || action === 'runtime_feature.status'
        ? ['manifest_source', 'manifest_sha256']
        : action === 'install'
          ? ['manifest_source', 'manifest_sha256', 'source_error', 'manifest_version']
          : ['manifest_source', 'manifest_sha256', 'source_error'];
    const complete = sourceResult(action, 'live');
    for (let mask = 1; mask < 2 ** keys.length - 1; mask++) {
      const partial = legacyResult(action);
      keys.forEach((key, index) => {
        const field = complete[key];
        if ((mask & (2 ** index)) !== 0 && field !== undefined) partial[key] = field;
      });
      if (Object.hasOwn(partial, 'manifest_source') || Object.hasOwn(partial, 'manifest_sha256'))
        await rejectResult(action, partial);
    }
    for (const key of ['manifest_source', 'manifest_sha256', 'source_error', 'manifest_version']) {
      const missing = { ...complete };
      delete missing[key];
      await rejectResult(action, missing);
    }
  }
});

test('旧版本和错误字段不能单独触发新组，旧安装和计划仍返回原形状且准备沿用严格字段', async () => {
  const legacyExtras: { [key: string]: JsonData }[] = [
    { manifest_version: 'v1' },
    { source_error: null },
    { source_error: sourceError },
    { manifest_version: 'v1', source_error: sourceError },
  ];
  for (const extra of legacyExtras) {
    const result = legacyResult('install');
    const tools = createToolSupply(gateway('install', { ...result, ...extra }));
    assert.deepEqual((await tools.install('node-runtime', signal())).data, result);
    tools.dispose();
  }
  const plan = legacyResult('plan');
  const tools = createToolSupply(gateway('plan', { ...plan, source_error: sourceError }));
  assert.deepEqual((await tools.plan(['node-runtime'], signal())).data, plan);
  tools.dispose();
  await rejectResult('runtime_feature.prepare', {
    ...legacyResult('runtime_feature.prepare'),
    source_error: null,
  });
});

test('五操作拒绝错误摘要、来源枚举、错误类型及非法三态关系', async () => {
  const patches: { [key: string]: JsonData }[] = [
    { manifest_sha256: '' },
    { manifest_sha256: 'a'.repeat(63) },
    { manifest_sha256: 'a'.repeat(65) },
    { manifest_sha256: 'g'.repeat(64) },
    { manifest_sha256: 'a'.repeat(64) + '\n' },
    { manifest_sha256: null },
    { manifest_sha256: 1 },
    { manifest_sha256: [] },
    { manifest_source: '' },
    { manifest_source: 'remote' },
    { manifest_source: 'LIVE' },
    { manifest_source: false },
    { source_error: '' },
    { source_error: 1 },
    { source_error: [] },
    { source_error: sourceError },
    { manifest_version: '' },
    { manifest_version: null },
    { manifest_version: 1 },
    { manifest_source: 'cache', source_error: null },
    { manifest_source: 'cache', source_error: '' },
    { manifest_source: 'cache', source_error: sourceError, manifest_sha256: null },
    { manifest_source: 'cache', source_error: sourceError, manifest_version: null },
    { manifest_source: null, source_error: sourceError },
    { manifest_source: null, manifest_sha256: null, source_error: sourceError },
    { manifest_source: null, manifest_version: null, source_error: sourceError },
    { manifest_source: null, manifest_version: null, manifest_sha256: null, source_error: null },
    { manifest_source: null, manifest_version: null, manifest_sha256: null, source_error: '' },
  ];
  for (const action of sourceActions) {
    for (const patch of patches)
      await rejectResult(action, { ...sourceResult(action, 'live'), ...patch });
  }
});

test('新来源组不放宽旧目录、计划、安装及功能归属和就绪不变量', async () => {
  for (const source of manifestSources) {
    await rejectResult('catalog', {
      ...sourceResult('catalog', source),
      modules: [runtimeModule(), runtimeModule()],
    });
    await rejectResult('plan', { ...sourceResult('plan', source), download_bytes: 40 });
    await rejectResult('plan', {
      ...sourceResult('plan', source),
      modules: [{ ...runtimeModule(), module_id: 'other' }],
    });
    await rejectResult('install', { ...sourceResult('install', source), module_id: 'other' });
    await rejectResult('install', { ...sourceResult('install', source), version: 'v1' });
    await rejectResult('install', { ...sourceResult('install', source), sha256: 'bad' });
    await rejectResult('runtime_feature.status', {
      ...sourceResult('runtime_feature.status', source),
      found: false,
    });
    await rejectResult('runtime_feature.status', {
      ...sourceResult('runtime_feature.status', source),
      ready: false,
    });
    await rejectResult('runtime_feature.status', {
      ...sourceResult('runtime_feature.status', source),
      feature_key: 'other',
    });
    await rejectResult('runtime_feature.status', {
      ...sourceResult('runtime_feature.status', source),
      modules: [{ ...runtimeModule(), feature_key: 'other' }],
    });
    await rejectResult('runtime_feature.prepare', {
      ...sourceResult('runtime_feature.prepare', source),
      feature_key: 'other',
    });
    await rejectResult('runtime_feature.prepare', {
      ...sourceResult('runtime_feature.prepare', source),
      ready: false,
    });
    await rejectResult('runtime_feature.prepare', {
      ...sourceResult('runtime_feature.prepare', source),
      modules: [],
    });
    await rejectResult('runtime_feature.prepare', {
      ...sourceResult('runtime_feature.prepare', source),
      modules: [installation(), installation()],
    });
    for (const field of [
      'manifest_source',
      'manifest_sha256',
      'source_error',
      'manifest_version',
      'feature_key',
      'path',
    ]) {
      const value = sourceResult('runtime_feature.prepare', source)[field] ?? '不属于安装子项';
      await rejectResult('runtime_feature.prepare', {
        ...sourceResult('runtime_feature.prepare', source),
        modules: [{ ...installation(), [field]: value }],
      });
    }
  }
  await rejectResult('catalog', { ...unavailableResult('catalog'), modules: [runtimeModule()] });
  await rejectResult('runtime_feature.status', {
    ...unavailableResult('runtime_feature.status'),
    modules: [runtimeModule()],
    found: true,
    ready: true,
  });
  await rejectResult('runtime_feature.status', {
    ...unavailableResult('runtime_feature.status'),
    found: true,
  });
  await rejectResult('runtime_feature.status', {
    ...unavailableResult('runtime_feature.status'),
    ready: true,
  });
});

test('新来源组不伪造模块信息，准备子项保持旧四字段且功能结果拒绝路径', async () => {
  for (const source of manifestSources) {
    const result = sourceResult('runtime_feature.prepare', source);
    const tools = createToolSupply(gateway('runtime_feature.prepare', result));
    const prepared = await tools.prepareRuntimeFeature('assistant', signal());
    assert.deepEqual(prepared.data.modules, [installation()]);
    assert.deepEqual(Object.keys(prepared.data.modules[0] ?? {}).sort(), [
      'changed',
      'module_id',
      'sha256',
      'version',
    ]);
    tools.dispose();
    for (const action of featureActions) {
      await rejectResult(action, { ...sourceResult(action, source), path: '不得消费的服务器路径' });
    }
    for (const action of moduleActions) {
      const business = sourceResult(action, source);
      const unused = createToolSupply(
        gateway(action, { ...business, path: '不得返回的服务器路径' }),
      );
      assert.deepEqual((await execute(unused, action, signal())).data, business);
      unused.dispose();
    }
  }
});

test('未知功能可带有效 live/cache 快照但不虚构匹配项，缓存多模块仍逐项决定就绪', async () => {
  for (const source of manifestSources) {
    const result = {
      ...sourceResult('runtime_feature.status', source),
      found: false,
      ready: false,
      modules: [],
    };
    const tools = createToolSupply(gateway('runtime_feature.status', result));
    assert.deepEqual((await tools.runtimeFeatureStatus('assistant', signal())).data, result);
    tools.dispose();
  }
  const result = {
    ...sourceResult('runtime_feature.status', 'cache'),
    ready: false,
    modules: [
      runtimeModule(),
      {
        ...runtimeModule(),
        module_id: 'newer-runtime',
        installed_version: '1.3',
        action: 'local_newer',
      },
    ],
  };
  const tools = createToolSupply(gateway('runtime_feature.status', result));
  assert.deepEqual((await tools.runtimeFeatureStatus('assistant', signal())).data, result);
  tools.dispose();
});

test('来源组全部缺失的旧查询仍拒绝版本与来源错误同时存在', async () => {
  for (const action of queryActions)
    await rejectResult(action, { ...legacyResult(action), source_error: sourceError });
});

test('五操作恢复原缓存任务保留提交及查询日志，来源错误不触发重提或自动取消', async () => {
  for (const action of sourceActions) {
    const result = sourceResult(action, 'cache');
    let submits = 0;
    let reads = 0;
    let cancels = 0;
    const ticket: JobTicket = {
      id: 'source-job',
      operation: operation(action),
      submitLogId: 'original-submit-log',
    };
    const tools = createToolSupply({
      submit: async () => {
        submits++;
        throw new Error('来源错误不得重新提交');
      },
      getJob: async (id) => {
        reads++;
        assert.equal(id, ticket.id);
        return completed(action, result, 'source-query-log');
      },
      cancelJob: async () => {
        cancels++;
        throw new Error('来源错误不得自动取消');
      },
    });
    const outcome = await resume(tools, action, ticket, signal());
    assert.deepEqual(outcome.data, result);
    assert.equal(outcome.job.id, ticket.id);
    assert.equal(outcome.submitLogId, ticket.submitLogId);
    assert.equal(outcome.logId, 'source-query-log');
    assert.equal(submits, 0);
    assert.equal(reads, 1);
    assert.equal(cancels, 0);
    tools.dispose();
  }
});

test('无缓存查询恢复保留真实来源错误且零重提，安装类失败保持共享 Job 失败与日志', async () => {
  for (const action of queryActions) {
    const result = unavailableResult(action);
    let submits = 0;
    const tools = createToolSupply({
      ...gateway(action, result),
      submit: async () => {
        submits++;
        throw new Error('恢复不得提交');
      },
      getJob: async () => completed(action, result, 'unavailable-query-log'),
    });
    const ticket: JobTicket = {
      id: 'source-job',
      operation: operation(action),
      submitLogId: 'original-submit-log',
    };
    const outcome = await resume(tools, action, ticket, signal());
    assert.deepEqual(outcome.data, result);
    assert.equal(outcome.logId, 'unavailable-query-log');
    assert.equal(submits, 0);
    tools.dispose();
  }
  for (const action of sourceActions.filter(
    (value) => value !== 'catalog' && value !== 'runtime_feature.status',
  )) {
    let submits = 0;
    let reads = 0;
    const tools = createToolSupply({
      ...gateway(action, {}),
      submit: async () => {
        submits++;
        return {
          data: {
            id: 'source-job',
            operation: operation(action),
            status: 'failed',
            error: sourceError,
            result: null,
          },
          logId: 'source-failure-log',
        };
      },
      getJob: async () => {
        reads++;
        throw new Error('失败任务不得继续查询');
      },
    });
    await assert.rejects(
      execute(tools, action, signal()),
      (error: unknown) =>
        error instanceof JobFailure &&
        error.logId === 'source-failure-log' &&
        error.message.includes(sourceError),
    );
    assert.equal(submits, 1);
    assert.equal(reads, 0);
    tools.dispose();
  }
});

test('五操作恢复错元数据保持查询日志并拒绝，不能通过重复提交修补来源身份', async () => {
  for (const action of sourceActions) {
    let submits = 0;
    let reads = 0;
    const tools = createToolSupply({
      ...gateway(action, {}),
      submit: async () => {
        submits++;
        throw new Error('非法结果不得重新提交');
      },
      getJob: async () => {
        reads++;
        return completed(
          action,
          { ...sourceResult(action, 'cache'), manifest_sha256: 'bad' },
          'invalid-query-log',
        );
      },
    });
    const ticket: JobTicket = {
      id: 'source-job',
      operation: operation(action),
      submitLogId: 'original-submit-log',
    };
    await assert.rejects(
      resume(tools, action, ticket, signal()),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === 'invalid_business_result' &&
        error.logId === 'invalid-query-log',
    );
    assert.equal(submits, 0);
    assert.equal(reads, 1);
    tools.dispose();
  }
});

test('五操作取消等待和显式取消后恢复同一缓存任务，晚到结果不复活等待且只提交一次', async () => {
  for (const action of sourceActions) {
    const blocked = deferred<ApiResult<TaskRecord>>();
    const entered = deferred<void>();
    const result = sourceResult(action, 'cache');
    let submits = 0;
    let reads = 0;
    let cancels = 0;
    let recovered = false;
    const running: ApiResult<TaskRecord> = {
      data: {
        id: 'source-job',
        operation: operation(action),
        status: 'running',
        error: null,
        result: null,
      },
      logId: 'source-running-log',
    };
    const tools = createToolSupply(
      {
        submit: async () => {
          submits++;
          return running;
        },
        getJob: async (id) => {
          reads++;
          assert.equal(id, running.data.id);
          entered.resolve();
          return recovered ? completed(action, result, 'source-restored-log') : blocked.promise;
        },
        cancelJob: async (id) => {
          cancels++;
          assert.equal(id, running.data.id);
          return { ...running, logId: 'source-cancel-log' };
        },
      },
      { pollIntervalMs: 0 },
    );
    const controller = new AbortController();
    const waiting = execute(tools, action, controller.signal);
    const cancelled = assert.rejects(
      waiting,
      (error: unknown) =>
        error instanceof JobWaitFailure &&
        error.job.id === running.data.id &&
        error.submitLogId === running.logId &&
        error.lastKnownLogId === running.logId &&
        error.logId === null,
    );
    await entered.promise;
    controller.abort();
    await cancelled;
    const ticket: JobTicket = {
      id: running.data.id,
      operation: operation(action),
      submitLogId: running.logId,
    };
    const cancellation = await tools.cancel(ticket, signal());
    assert.equal(cancellation.data.status, 'running');
    assert.equal(cancellation.logId, 'source-cancel-log');
    recovered = true;
    assert.equal((await tools.query(ticket, signal())).data.status, 'succeeded');
    const restored = await resume(tools, action, ticket, signal());
    assert.deepEqual(restored.data, result);
    assert.equal(restored.submitLogId, running.logId);
    assert.equal(restored.logId, 'source-restored-log');
    assert.equal(submits, 1);
    assert.equal(reads, 3);
    assert.equal(cancels, 1);
    blocked.resolve(
      completed(action, { ...result, manifest_sha256: 'c'.repeat(64) }, 'late-source-log'),
    );
    await blocked.promise;
    assert.equal(restored.data.manifest_sha256, manifestSha256);
    assert.equal(restored.logId, 'source-restored-log');
    tools.dispose();
  }
});
