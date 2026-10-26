import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginInstallations, ownedInstallationComponents, installationForComponent, installationRequiresRecovery, isLegacyCleanupWarning } from '../src/features/plugin-installations/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, signal } from './fixtures.ts';
import { installationFixture, release, releaseSource, result } from './plugin-installations-fixture.ts';
import { formatJobProgress } from '../src/features/tasks/index.ts';

test('安装等待两个服务器任务与目录重读后才启用浏览器，公开快照稳定', async () => {
  const fixture = installationFixture();
  const model = createPluginInstallations(fixture.gateway, fixture.browser);
  try {
    const installed = await model.install(releaseSource, signal());
    assert.equal(installed.enabled, true);
    assert.deepEqual(fixture.events, ['plan', 'install', 'wait:job-0', 'list', 'enable-server', 'wait:job-1', 'list', 'browser:example-browser']);
    assert.equal(model.clientSnapshot()[0]?.phase, 'enabled');
    assert.equal(model.clientSnapshot(), model.clientSnapshot());
    assert.equal(model.snapshot().result?.logId, 'directory-log');
  } finally { model.dispose(); }
});

test('安装轮询增量事件展示阶段资源与字节，保留任务与日志且终态后不再轮询', async () => {
  const fixture = installationFixture();
  let polls = 0;
  const after: number[] = [];
  const stages: string[] = [];
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result([release(true)]),
    getJob: async (id) => {
      const response = await fixture.gateway.getJob(id, signal());
      return { ...response, data: { ...response.data, status: polls++ === 0 ? 'running' : 'succeeded' } };
    }, getEvents: async (id, query) => {
      after.push(query.after ?? 0);
      return result([{ job_id: id, sequence: polls, timestamp: 1, status: polls === 1 ? 'running' : 'succeeded',
        progress: { stage: polls === 1 ? 'downloading' : 'complete', resource_id: polls === 1 ? 'adb' : null,
          completed_bytes: polls === 1 ? 50 : 100, total_bytes: 100 } }], 'progress-log');
    },
  }, fixture.browser, { pollIntervalMs: 0 });
  const unsubscribe = model.subscribeProgress(() => {
    const value = model.progressSnapshot()?.progress;
    if (value) stages.push(formatJobProgress(value));
  });
  try {
    await model.install(releaseSource, signal());
    assert.deepEqual(after, [0, 1]);
    assert.equal(polls, 2);
    assert.ok(stages.some((value) => value.includes('下载资源 · adb · 50 / 100 字节')));
    assert.equal(model.progressSnapshot()?.progress?.stage, 'complete');
    assert.equal(model.progressSnapshot()?.jobId, 'job-0');
    assert.equal(model.progressSnapshot()?.logId, 'terminal-log');
    assert.equal(model.progressSnapshot(), model.progressSnapshot());
  } finally { unsubscribe(); model.dispose(); }
});

test('托管资源先检查再显式清理，保留任务日志与服务器报告，不自动重放', async () => {
  const fixture = installationFixture([release(false)]);
  const calls: boolean[] = [];
  const model = createPluginInstallations({ ...fixture.gateway,
    cleanup: async (dryRun) => {
      calls.push(dryRun);
      return result({ id: 'cleanup-job', operation: 'installation.cleanup', status: 'queued', result: null, error: null }, 'cleanup-submit-log');
    }, getJob: async () => result({ id: 'cleanup-job', operation: 'installation.cleanup', status: 'succeeded',
      result: { dry_run: calls.at(-1), items: [], total_bytes: 0 }, error: null }, 'cleanup-finished-log'),
  }, fixture.browser);
  try {
    assert.deepEqual(await model.cleanup(true, signal()), { data: { dry_run: true, items: [], total_bytes: 0 }, logId: 'cleanup-finished-log' });
    assert.deepEqual(calls, [true]);
    await model.cleanup(false, signal());
    assert.deepEqual(calls, [true, false]);
    assert.equal(fixture.events.some((value) => value.startsWith('browser:')), false);
  } finally { model.dispose(); }
});

test('取消事件读取后忽略晚到进度，不重放已提交安装或启动浏览器', async () => {
  const fixture = installationFixture();
  const waiting = deferred<Awaited<ReturnType<NonNullable<typeof fixture.gateway.getEvents>>>>();
  const started = deferred<void>();
  const controller = new AbortController();
  const model = createPluginInstallations({ ...fixture.gateway,
    getEvents: async () => { started.resolve(); return waiting.promise; },
  }, fixture.browser);
  try {
    const pending = model.install(releaseSource, controller.signal);
    await started.promise;
    const snapshot = model.progressSnapshot();
    controller.abort();
    await assert.rejects(pending);
    waiting.resolve(result([{ job_id: 'job-0', sequence: 1, timestamp: 1, status: 'succeeded',
      progress: { stage: 'complete', completed_bytes: 100, total_bytes: 100 } }]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(model.progressSnapshot(), snapshot);
    assert.equal(fixture.events.filter((event) => event === 'install').length, 1);
    assert.equal(fixture.events.some((event) => event.startsWith('browser:')), false);
  } finally { model.dispose(); }
});

test('安装缺少业务配置时保留已安装需配置状态，不运行浏览器或误报安装失败', async () => {
  const fixture = installationFixture();
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result([{ ...release(true), status: 'configuration_required' }]) }, fixture.browser);
  try {
    const installed = await model.install(releaseSource, signal());
    assert.equal(installed.status, 'configuration_required');
    assert.equal(fixture.events.some((item) => item.startsWith('browser:')), false);
    assert.equal(model.clientSnapshot()[0]?.phase, 'disabled');
    assert.match(model.clientSnapshot()[0]?.message ?? '', /完成配置/);
  } finally { model.dispose(); }
});

test('配置保存后的显式启用提交服务器重评，仍需配置时才提示且不启动浏览器', async () => {
  const fixture = installationFixture();
  let complete = false;
  const submitted: boolean[] = [];
  const model = createPluginInstallations({ ...fixture.gateway,
    list: async () => result([{ ...release(complete), status: complete ? 'enabled' : 'configuration_required' }]),
    setEnabled: async (id, revision, enabled, active) => { submitted.push(enabled); return fixture.gateway.setEnabled(id, revision, enabled, active); },
  }, fixture.browser);
  try {
    await assert.rejects(model.setEnabled('example-release', release().revision, true, signal()), /完成配置/);
    assert.deepEqual(submitted, [true]);
    assert.equal(fixture.events.some((event) => event.startsWith('browser:')), false);
    complete = true;
    await model.setEnabled('example-release', release().revision, true, signal());
    assert.deepEqual(submitted, [true, true]);
    assert.equal(model.clientSnapshot()[0]?.phase, 'enabled');
  } finally { model.dispose(); }
});

test('更新只清理旧浏览器且保留原服务器启停选择，停用发布不会被自动启用', async () => {
  for (const enabled of [false, true]) {
    const fixture = installationFixture([release(enabled)]);
    let current = release(enabled);
    const next = release(enabled, '2.0.0', 'b'.repeat(64));
    const model = createPluginInstallations({ ...fixture.gateway,
      list: async () => { fixture.events.push('list'); return result([current]); },
      plan: async () => result({ ...next, issues: [] }),
      update: async (id, revision, source, active) => {
        assert.equal(current.enabled, enabled, '更新提交前不得PATCH停用服务器');
        current = next; return fixture.gateway.update(id, revision, source, active);
      },
      setEnabled: async () => { throw new Error('更新不能额外修改服务器启停意图'); },
    }, fixture.browser);
    try {
      const value = await model.update(current.id, current.revision, releaseSource, signal());
      assert.equal(value.enabled, enabled);
      assert.equal(fixture.events.filter((event) => event.startsWith('browser:')).length, enabled ? 1 : 0);
      assert.equal(fixture.events.filter((event) => event.startsWith('cleanup:')).length, 1);
      assert.equal(model.clientSnapshot()[0]?.phase, enabled ? 'enabled' : 'disabled');
      assert.equal(model.clientSnapshot()[0]?.revision, next.revision);
    } finally { model.dispose(); }
  }
});

test('用户配置提示允许先安装，服务器已经启用时不重复提交启用任务', async () => {
  const fixture = installationFixture();
  const model = createPluginInstallations({ ...fixture.gateway,
    plan: async () => result({ ...release(), issues: [{ code: 'user_configuration', message: '请配置工作目录', required: true }] }),
    list: async () => result([release(true)]),
  }, fixture.browser);
  try {
    await model.install(releaseSource, signal());
    assert.deepEqual(fixture.events, ['install', 'wait:job-0', 'browser:example-browser']);
    assert.equal(model.clientSnapshot()[0]?.phase, 'enabled');
  } finally { model.dispose(); }
});

test('计划存在必需依赖错误时保留安装前状态，不提交安装任务', async () => {
  const fixture = installationFixture();
  const model = createPluginInstallations({ ...fixture.gateway,
    plan: async () => result({ ...release(), issues: [{ code: 'unsupported_platform', message: '当前平台没有资源', required: true }] }, 'plan-error-log'),
  }, fixture.browser);
  try {
    await assert.rejects(model.install(releaseSource, signal()), (reason: unknown) => reason instanceof ApiError &&
      reason.code === 'unsupported_platform' && reason.logId === 'plan-error-log');
    assert.equal(fixture.events.includes('install'), false);
    assert.deepEqual(fixture.records(), []);
  } finally { model.dispose(); }
});

test('后续浏览器组件失败会清理已启动组件，保留错误日志', async () => {
  const fixture = installationFixture();
  const value = release(true);
  const component = value.components.find((item) => item.kind === 'browser');
  assert.ok(component);
  const failure = new ApiError('http', 'activation_failed', '第二个面板无法启动', 500, 'activation-log');
  const model = createPluginInstallations({ ...fixture.gateway,
    list: async () => result([{ ...value, components: [...value.components, { ...component, id: 'second-browser' }] }]),
  }, { ...fixture.browser, enable: async (installation, item, active) => {
    if (item.id === 'second-browser') throw failure;
    await fixture.browser.enable(installation, item, active);
  } });
  try {
    await assert.rejects(model.restore(signal()), (error: unknown) => error instanceof AggregateError && error.errors[0] === failure);
    assert.deepEqual(fixture.events.filter((item) => item.startsWith('browser:') || item.startsWith('cleanup:')),
      ['browser:example-browser', 'cleanup:example-browser']);
    assert.equal(model.clientSnapshot()[0]?.logId, 'activation-log');
  } finally { model.dispose(); }
});

test('更新旧修订拒绝在清理之前生效，避免覆盖新安装', async () => {
  const fixture = installationFixture([release(true)]);
  const model = createPluginInstallations(fixture.gateway, fixture.browser);
  try {
    await assert.rejects(model.update('example-release', 'b'.repeat(64), releaseSource, signal()), /已更新/);
    assert.deepEqual(fixture.events, ['list', 'list']);
  } finally { model.dispose(); }
});

test('卸载先清理本地浏览器并等待服务器停用，删除完成才撤回客户端状态', async () => {
  const fixture = installationFixture([release(true)]);
  const model = createPluginInstallations(fixture.gateway, fixture.browser);
  let notifications = 0;
  const unsubscribe = model.subscribeClient(() => { ++notifications; });
  try {
    await model.restore(signal());
    fixture.events.length = 0;
    await model.uninstall('example-release', release().revision, signal());
    assert.deepEqual(fixture.events, ['list', 'cleanup:example-browser', 'disable-server', 'wait:job-0', 'list', 'uninstall', 'wait:job-1', 'list']);
    assert.deepEqual(model.clientSnapshot(), []);
    assert.equal(notifications, 4);
  } finally { unsubscribe(); model.dispose(); }
});

test('浏览器清理失败不提交停用或删除', async () => {
  const fixture = installationFixture([release(true)]);
  const model = createPluginInstallations(fixture.gateway, { ...fixture.browser, disable: async () => { throw new Error('清理失败'); } });
  try {
    await assert.rejects(model.uninstall('example-release', release().revision, signal()), /清理失败/);
    assert.deepEqual(fixture.events, ['list', 'list']);
    assert.equal(fixture.records()[0]?.enabled, true);
  } finally { model.dispose(); }
});

test('计划取消后晚到结果不提交安装，清理后没有客户端状态', async () => {
  const fixture = installationFixture();
  const started = deferred<void>();
  const planned = deferred<ReturnType<typeof result<ReturnType<typeof release> & { issues: [] }>>>();
  const model = createPluginInstallations({ ...fixture.gateway, plan: async () => { started.resolve(); return planned.promise; } }, fixture.browser);
  const cancellation = new AbortController();
  try {
    const pending = model.install(releaseSource, cancellation.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof ApiError && error.kind === 'cancelled');
    await started.promise;
    cancellation.abort();
    await rejected;
    planned.resolve(result({ ...release(), issues: [] }));
    await model.refresh(signal());
    assert.equal(fixture.events.includes('install'), false);
    assert.deepEqual(model.clientSnapshot(), []);
  } finally { model.dispose(); }
});

test('功能拥有多个组件时目录聚合按类型和标识过滤，不重复生成安装项', () => {
  const value = release();
  assert.deepEqual([...ownedInstallationComponents([value])], ['server:example-server', 'browser:example-browser']);
  assert.equal(installationForComponent([value], 'browser', 'example-browser'), value);
  assert.equal(installationForComponent([value], 'server', 'example-browser'), undefined);
});

test('单客户端失败重试不重放安装或服务器启用任务', async () => {
  const fixture = installationFixture([release(true)]);
  let attempts = 0;
  const model = createPluginInstallations(fixture.gateway, { ...fixture.browser, enable: async (installation, component, active) => {
    if (++attempts === 1) throw new Error('临时模块错误');
    await fixture.browser.enable(installation, component, active);
  } });
  try {
    await assert.rejects(model.retryBrowser('example-release', release().revision, signal()), /临时模块错误/);
    assert.equal(model.clientSnapshot()[0]?.phase, 'failed');
    await model.retryBrowser('example-release', release().revision, signal());
    assert.equal(model.clientSnapshot()[0]?.phase, 'enabled');
    assert.deepEqual(fixture.events, ['list', 'list', 'list', 'browser:example-browser']);
  } finally { model.dispose(); }
});

test('恢复一个功能失败仍继续其他已启用功能，不自动启用已停用目录', async () => {
  const fixture = installationFixture();
  const first = release(true), second = { ...release(true), id: 'second-release' }, disabled = { ...release(), id: 'disabled-release' };
  const observed: string[] = [];
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result([first, second, disabled]) },
    { ...fixture.browser, enable: async (installation) => {
      observed.push(installation.id);
      if (installation.id === first.id) throw new Error('第一个功能模块错误');
    } });
  try {
    await assert.rejects(model.restore(signal()), /部分功能/);
    assert.deepEqual(observed, ['example-release', 'second-release']);
    assert.equal(model.clientSnapshot().find((item) => item.id === second.id)?.phase, 'enabled');
  } finally { model.dispose(); }
});

test('恢复受阻的安装即使保留启用意图也不恢复浏览器', async () => {
  const fixture = installationFixture([{ ...release(true), status: 'recovery_blocked' }]);
  const model = createPluginInstallations(fixture.gateway, fixture.browser);
  try {
    await model.restore(signal());
    assert.deepEqual(fixture.events, ['list']);
    assert.deepEqual(model.clientSnapshot(), []);
    assert.equal(model.snapshot().result?.data[0]?.status, 'recovery_blocked');
  } finally { model.dispose(); }
});

test('安装任务完成但恢复受阻时不提交启用任务或启动浏览器', async () => {
  const fixture = installationFixture();
  const model = createPluginInstallations({ ...fixture.gateway,
    list: async () => { fixture.events.push('list'); return result([{ ...release(), status: 'recovery_blocked' }]); },
  }, fixture.browser);
  try {
    await assert.rejects(model.install(releaseSource, signal()), /安装恢复受阻/);
    assert.deepEqual(fixture.events, ['plan', 'install', 'wait:job-0', 'list', 'list']);
    assert.equal(model.snapshot().result?.data[0]?.status, 'recovery_blocked');
    assert.deepEqual(model.clientSnapshot(), []);
  } finally { model.dispose(); }
});

test('恢复受阻时拒绝更新和启用，保留浏览器与服务器当前状态', async () => {
  const fixture = installationFixture([{ ...release(true), status: 'recovery_blocked' }]);
  const model = createPluginInstallations(fixture.gateway, fixture.browser);
  try {
    await assert.rejects(model.update('example-release', release().revision, releaseSource, signal()), /安装恢复受阻/);
    await assert.rejects(model.setEnabled('example-release', release().revision, true, signal()), /安装恢复受阻/);
    assert.deepEqual(fixture.events, ['list', 'list', 'list', 'list']);
    assert.equal(fixture.records()[0]?.status, 'recovery_blocked');
    assert.equal(fixture.records()[0]?.enabled, true);
    assert.deepEqual(model.clientSnapshot(), []);
  } finally { model.dispose(); }
});

test('八项纯组件阶段是历史告警，文件事务和未知故障仍要求恢复', () => {
  const allowed = ['component_cleanup', 'activation_cleanup', 'enable_cleanup', 'activation_reload',
    'startup_activation', 'unload_rollback', 'configuration_rollback', 'disable_rollback'];
  for (const phase of [...allowed, 'activation_rollback', 'commit_rollback', 'transaction_commit', 'transaction_cleanup', 'unknown']) {
    const value = { ...release(true), status: 'recovery_blocked' as const, failure: { phase, reason: '原始失败记录' } };
    assert.equal(isLegacyCleanupWarning(value), allowed.includes(phase));
    assert.equal(installationRequiresRecovery(value), !allowed.includes(phase));
  }
  assert.equal(installationRequiresRecovery({ ...release(), status: 'recovery_blocked' }), true);
});

test('历史组件清理失败保留原状态和原因，但不阻断恢复、启停、更新、卸载和显式安装', async () => {
  for (const phase of ['component_cleanup', 'activation_cleanup']) {
    const warning = { ...release(true), status: 'recovery_blocked' as const,
      failure: { phase, reason: '上次组件操作失败' } };
    for (const action of ['restore', 'retry', 'enable', 'disable', 'update', 'uninstall', 'install']) {
    const fixture = installationFixture([warning]);
    const gateway = action === 'install' ? { ...fixture.gateway, list: async () => result([warning]) }
      : action === 'update' ? { ...fixture.gateway, plan: async () => result({ ...release(false, '2.0.0', 'b'.repeat(64)), issues: [] }) }
      : fixture.gateway;
    const model = createPluginInstallations(gateway, fixture.browser);
    try {
      if (action === 'restore') await model.restore(signal());
      else if (action === 'retry') await model.retryBrowser(warning.id, warning.revision, signal());
      else if (action === 'enable' || action === 'disable') await model.setEnabled(warning.id, warning.revision, action === 'enable', signal());
      else if (action === 'update') await model.update(warning.id, warning.revision, releaseSource, signal());
      else if (action === 'uninstall') await model.uninstall(warning.id, warning.revision, signal());
      else await model.install(releaseSource, signal());
      if (['restore', 'retry', 'install'].includes(action)) {
        assert.equal(model.clientSnapshot()[0]?.phase, 'enabled');
        assert.equal(model.snapshot().result?.data[0]?.status, 'recovery_blocked');
        assert.deepEqual(model.snapshot().result?.data[0]?.failure, warning.failure);
      }
      assert.equal(fixture.events.filter((event) => event === 'install').length, action === 'install' ? 1 : 0);
    } finally { model.dispose(); }
    }
  }
});
