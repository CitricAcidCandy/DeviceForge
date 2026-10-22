import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginInstallations, ownedInstallationComponents, installationForComponent } from '../src/features/plugin-installations/index.ts';
import { ApiError } from '../src/services/api/index.ts';
import { deferred, signal } from './fixtures.ts';
import { installationFixture, release, releaseSource, result } from './plugin-installations-fixture.ts';

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

test('启用被配置要求阻断时不运行浏览器并显示明确客户端错误', async () => {
  const fixture = installationFixture();
  const model = createPluginInstallations({ ...fixture.gateway, list: async () => result([{ ...release(true), status: 'configuration_required' }]) }, fixture.browser);
  try {
    await assert.rejects(model.install(releaseSource, signal()), /完成配置/);
    assert.equal(fixture.events.some((item) => item.startsWith('browser:')), false);
    assert.equal(model.clientSnapshot()[0]?.phase, 'failed');
    assert.match(model.clientSnapshot()[0]?.message ?? '', /完成配置/);
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
