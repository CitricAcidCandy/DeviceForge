import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserConfigurations, createServerConfigurations } from '../src/features/plugin-configurations/index.ts';
import { createApiClient } from '../src/services/api/index.ts';
import type { PluginConfigurationDto } from '../src/services/api/index.ts';
import type { ConfigurationDefinition, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { success, failure, signal, installedPackage, requestUrl } from './fixtures.ts';
import { dom } from './dom-fixtures.ts';
import { JSDOM } from 'jsdom';

const defaultValues = { count: 2, secret: 'default-secret-value', identity: 'fixed', nested: { password: 'nested-default' } };
const definition: ConfigurationDefinition = {
  version: 1, apply_policy: 'next_invocation',
  schema: { type: 'object', additionalProperties: false, required: ['count', 'secret', 'identity'], properties: {
    count: { type: 'integer', minimum: 1, maximum: 10 },
    secret: { type: 'string', minLength: 12, writeOnly: true, default: 'default-secret-value' },
    identity: { type: 'string', readOnly: true },
    nested: { type: 'object', properties: { password: { type: 'string', format: 'password', default: 'nested-default' } } },
  } }, defaults: defaultValues,
};

function localStorageFixture() {
  const browser = new JSDOM('', { url: 'http://localhost:5173' });
  return { storage: browser.window.localStorage, close: () => browser.window.close() };
}

test('浏览器配置按服务地址和插件隔离，校验失败不保存，CAS 冲突不覆盖', () => {
  const fixture = localStorageFixture();
  const first = createBrowserConfigurations('http://host-a:7031', fixture.storage);
  const otherTab = createBrowserConfigurations('http://host-a:7031', fixture.storage);
  const otherHost = createBrowserConfigurations('http://host-b:7031', fixture.storage);
  for (const model of [first, otherTab, otherHost]) model.define('example', definition);
  try {
    const initial = first.get('example');
    const access = first.prepare('example', definition);
    assert.ok(access);
    const events: unknown[] = [];
    const release = access.subscribe((value) => { events.push(value); });
    const valid = { ...defaultValues, count: 4 };
    const saved = first.save('example', initial.revision, valid);
    assert.equal(saved.compatible, true);
    assert.notEqual(saved.revision, initial.revision);
    assert.equal(saved.pendingReload, false);
    assert.deepEqual(access.get(), valid);
    assert.equal(events.length, 1);
    const rejected = first.save('example', saved.revision, { ...valid, count: 0 });
    assert.equal(rejected.compatible, false);
    assert.ok(rejected.fieldErrors.some((error) => error.path === '/count'));
    assert.equal(first.get('example').revision, saved.revision);
    assert.throws(() => otherTab.save('example', initial.revision, valid), /其他窗口修改/);
    assert.equal(otherHost.get('example').revision, 'defaults');
    first.define('another', definition);
    assert.equal(first.get('another').revision, 'defaults');
    release();
  } finally { first.dispose(); otherTab.dispose(); otherHost.dispose(); fixture.close(); }
});

test('浏览器敏感值及 schema 默认值遮蔽，原占位保留原密钥，高级只读修改被拒绝', () => {
  const fixture = localStorageFixture();
  const model = createBrowserConfigurations('http://localhost:7031', fixture.storage);
  model.define('example', definition);
  try {
    const initial = model.get('example');
    const serialized = JSON.stringify(initial);
    assert.doesNotMatch(serialized, /default-secret-value|nested-default/);
    assert.match(serialized, /\*{8}/);
    const displayed = initial.values;
    assert.ok(displayed && typeof displayed === 'object' && !Array.isArray(displayed));
    const saved = model.save('example', initial.revision, { ...displayed, count: 5 });
    const access = model.prepare('example', definition);
    assert.ok(access);
    const actual = access.get();
    assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual));
    assert.equal(actual['secret'], 'default-secret-value');
    const readonly = model.save('example', saved.revision, { ...displayed, identity: 'changed' });
    assert.equal(readonly.compatible, false);
    assert.ok(readonly.fieldErrors.some((error) => error.path === '/identity'));
    assert.equal(model.get('example').revision, saved.revision);
    const next = model.save('example', saved.revision, { ...displayed, secret: 'new-secret-value' });
    assert.equal(next.compatible, true);
    assert.doesNotMatch(JSON.stringify(next), /new-secret-value/);
  } finally { model.dispose(); fixture.close(); }
});

test('需要重载的浏览器配置保存后保留运行中旧值，激活成功才确认应用，版本不兼容禁止激活', () => {
  const fixture = localStorageFixture();
  const model = createBrowserConfigurations('http://localhost:7031', fixture.storage);
  const reloadDefinition = { ...definition, apply_policy: 'plugin_reload' } satisfies ConfigurationDefinition;
  model.define('example', reloadDefinition);
  try {
    const access = model.prepare('example', reloadDefinition);
    assert.ok(access);
    const saved = model.save('example', model.get('example').revision, { ...defaultValues, count: 9 });
    assert.equal(saved.pendingReload, true);
    assert.deepEqual(access.get(), definition.defaults);
    model.prepare('example', reloadDefinition);
    assert.equal(model.get('example').pendingReload, true);
    model.markApplied('example');
    assert.equal(model.get('example').pendingReload, false);
    assert.throws(() => model.prepare('example', { ...reloadDefinition, version: 2 }), /不兼容/);
    const current = model.get('example');
    const reset = model.reset('example', current.revision);
    assert.equal(reset.compatible, true);
    model.define('plain', null);
    assert.equal(model.get('plain').definition, null);
  } finally { model.dispose(); fixture.close(); }
});

test('插件升级删除敏感字段声明后仍遮蔽旧值，保存占位保留原值且不存秘密副本', () => {
  const fixture = localStorageFixture();
  const model = createBrowserConfigurations('http://localhost:7031', fixture.storage);
  model.define('example', definition);
  try {
    const saved = model.save('example', 'defaults', defaultValues);
    model.define('example', { version: 2, apply_policy: 'next_invocation', defaults: { count: 1 },
      schema: { type: 'object', properties: { count: { type: 'integer' } } } });
    const upgraded = model.get('example');
    assert.equal(upgraded.compatible, false);
    assert.doesNotMatch(JSON.stringify(upgraded), /default-secret-value|nested-default/);
    assert.ok(upgraded.values && typeof upgraded.values === 'object' && !Array.isArray(upgraded.values));
    const corrected = model.save('example', saved.revision, { ...upgraded.values, count: 7 });
    assert.equal(corrected.compatible, true);
    assert.doesNotMatch(JSON.stringify(corrected), /default-secret-value|nested-default/);
    const raw = model.prepare('example', { version: 2, apply_policy: 'next_invocation', defaults: {}, schema: { type: 'object' } })?.get();
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
    assert.equal(raw['secret'], defaultValues.secret);
    const persisted: unknown = JSON.parse(fixture.storage.getItem(fixture.storage.key(0) ?? '') ?? '{}');
    assert.ok(persisted && typeof persisted === 'object' && 'sensitivePaths' in persisted);
    assert.deepEqual(persisted.sensitivePaths, ['/secret', '/nested/password']);
    assert.equal(JSON.stringify(persisted).match(/default-secret-value/g)?.length, 1, '敏感路径记录不保存原值副本');
  } finally { model.dispose(); fixture.close(); }
});

test('服务器配置走公开 PATCH/reset/apply，字段校验错误保留修订，409 冲突保留错误语义', async () => {
  const dto: PluginConfigurationDto = { kind: 'server', id: 'example', definition, values: definition.defaults, revision: 3, applied_revision: 2,
    pending_reload: true, compatible: true, field_errors: [], source: 'managed' };
  const calls: { path: string; method: string; body: unknown }[] = [];
  let conflict = false;
  const client = createApiClient({ baseUrl: 'http://localhost:7031', transport: async (input, init) => {
    const path = requestUrl(input).pathname;
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (conflict) return failure('configuration_conflict', 409);
    if (init?.method === 'PATCH') return success({ ...dto, compatible: false, field_errors: [{ path: '/count', message: '超出允许范围' }] });
    return success(dto);
  } });
  const configurations = createServerConfigurations(client);
  const target = { kind: 'server', id: 'example' } as const;
  const initial = await configurations.get(target, signal());
  assert.equal(initial.revision, '3');
  assert.doesNotMatch(JSON.stringify(initial), /default-secret-value|nested-default/);
  const rejected = await configurations.save(target, initial.revision, { count: 99 }, signal());
  assert.equal(rejected.compatible, false);
  assert.equal(rejected.revision, '3');
  assert.deepEqual(calls.at(-1), { path: '/api/v2/plugin-configurations/server/example', method: 'PATCH', body: { expected_revision: 3, patch: { count: 99 } } });
  await configurations.reset(target, '3', signal());
  assert.equal(calls.at(-1)?.path, '/api/v2/plugin-configurations/server/example/reset');
  await configurations.apply(target, '3', signal());
  assert.equal(calls.at(-1)?.path, '/api/v2/plugin-configurations/server/example/apply');
  conflict = true;
  await assert.rejects(configurations.save(target, '3', {}, signal()), { code: 'configuration_conflict', status: 409 });
});

test('真实运行实例激活前拒绝非法配置，保存并重载消费新值并恢复有效的插件主题', async () => {
  const browser = new JSDOM('', { url: 'http://localhost:5173' });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser.window });
  const contexts: HostContext[] = [];
  const plugin: WebPlugin = {
    id: 'example', version: '1.0', apiVersion: 2, panels: [],
    configuration: { version: 1, apply_policy: 'plugin_reload', schema: { type: 'object', additionalProperties: false, required: ['accent'], properties: { accent: { type: 'string', minLength: 1 } } }, defaults: { accent: '#112233' } },
    async activate(context) {
      contexts.push(context);
      const values = context.configuration?.get();
      assert.ok(values && typeof values === 'object' && !Array.isArray(values));
      const accent = values['accent'];
      assert.equal(typeof accent, 'string');
      if (typeof accent !== 'string') throw new Error('主题颜色配置无效');
      context.extensions?.register?.({ themes: [{ id: 'example.palette', title: '可配置主题', variables: { '--primary': accent } }] });
    },
  };
  const target = dom();
  const instance = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, themeTarget: target,
    transport: async (input) => success(requestUrl(input).pathname.endsWith('/plugin-packages/browser') ? [installedPackage()] : []),
    esmImporter: async () => ({ default: plugin }),
  });
  try {
    await instance.pluginPackages.refresh('browser', signal());
    await instance.pluginPackages.enable('browser', 'example', signal());
    instance.themes.select('example.palette');
    assert.equal(target.style.getPropertyValue('--primary'), '#112233');
    const selection = { kind: 'browser', id: 'example' } as const;
    const initial = await instance.pluginConfigurations.get(selection, signal());
    const saved = await instance.pluginConfigurations.save(selection, initial.revision, { accent: '#445566' }, signal());
    assert.equal(saved.pendingReload, true);
    assert.equal(target.style.getPropertyValue('--primary'), '#112233');
    const applied = await instance.pluginConfigurations.apply(selection, saved.revision, signal());
    assert.equal(applied.pendingReload, false);
    assert.equal(target.style.getPropertyValue('--primary'), '#445566');
    assert.equal(instance.themes.snapshot().selected?.id, 'example.palette');
    assert.equal(contexts.length, 2);
    assert.throws(() => contexts[0]?.configuration?.get(), /代际已撤销/);
    let activated = false;
    instance.webPlugins.register({ id: 'invalid-config', trusted: true, plugin: { id: 'invalid-config', version: '1.0', apiVersion: 2, panels: [],
      configuration: { ...definition, defaults: { ...defaultValues, count: 0 } }, async activate() { activated = true; } } });
    await assert.rejects(instance.webPlugins.load('invalid-config'), /配置无效/);
    assert.equal(activated, false);
  } finally {
    await instance.dispose(); browser.window.close();
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
