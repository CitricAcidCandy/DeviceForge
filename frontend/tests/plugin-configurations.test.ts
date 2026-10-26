import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerConfigurations } from '../src/features/plugin-configurations/index.ts';
import { createApiClient } from '../src/services/api/index.ts';
import type { PluginConfigurationDto } from '../src/services/api/index.ts';
import type { ConfigurationDefinition, HostContext, WebPlugin } from '../src/plugin-sdk/index.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { noBrowserDependencies } from './plugin-dependencies-fixtures.ts';
import { success, failure, signal, installedPackage, requestUrl } from './fixtures.ts';
import { dom } from './dom-fixtures.ts';
import { JSDOM } from 'jsdom';
import { browserConfigurationServer } from './browser-configuration-fixtures.ts';

const defaultValues = {
  count: 2,
  secret: 'default-secret-value',
  identity: 'fixed',
  nested: { password: 'nested-default' },
};
const definition: ConfigurationDefinition = {
  version: 1,
  apply_policy: 'next_invocation',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['count', 'secret', 'identity'],
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 10 },
      secret: { type: 'string', minLength: 12, writeOnly: true, default: 'default-secret-value' },
      identity: { type: 'string', readOnly: true },
      nested: {
        type: 'object',
        properties: { password: { type: 'string', format: 'password', default: 'nested-default' } },
      },
    },
  },
  defaults: defaultValues,
};

function localStorageFixture() {
  const browser = new JSDOM('', { url: 'http://localhost:5173' });
  return { storage: browser.window.localStorage, close: () => browser.window.close() };
}

test('浏览器配置按服务地址和插件隔离，校验失败不保存，CAS 冲突不覆盖', async () => {
  const fixture = localStorageFixture();
  const server = browserConfigurationServer();
  const first = server.model('http://host-a:7031', fixture.storage);
  const otherTab = server.model('http://host-a:7031', fixture.storage);
  const otherHost = server.model('http://host-b:7031', fixture.storage);
  for (const model of [first, otherTab, otherHost]) model.define('example', definition);
  try {
    const initial = await first.get('example', signal());
    const access = await first.prepare('example', definition, signal());
    assert.ok(access);
    const events: unknown[] = [];
    const release = access.subscribe((value) => {
      events.push(value);
    });
    const valid = { ...defaultValues, count: 4 };
    const saved = await first.save('example', initial.revision, valid, signal());
    assert.equal(saved.compatible, true);
    assert.notEqual(saved.revision, initial.revision);
    assert.equal(saved.pendingReload, false);
    assert.deepEqual(access.get(), valid);
    assert.equal(events.length, 1);
    const rejected = await first.save('example', saved.revision, { ...valid, count: 0 }, signal());
    assert.equal(rejected.compatible, false);
    assert.ok(rejected.fieldErrors.some((error) => error.path === '/count'));
    assert.equal((await first.get('example', signal())).revision, saved.revision);
    await assert.rejects(
      otherTab.save('example', initial.revision, valid, signal()),
      /其他窗口修改/,
    );
    assert.equal((await otherHost.get('example', signal())).revision, 'defaults');
    first.define('another', definition);
    assert.equal((await first.get('another', signal())).revision, 'defaults');
    assert.equal(fixture.storage.length, 0, '新配置只保存在服务端');
    release();
  } finally {
    first.dispose();
    otherTab.dispose();
    otherHost.dispose();
    fixture.close();
  }
});

test('浏览器敏感值及 schema 默认值遮蔽，原占位保留原密钥，高级只读修改被拒绝', async () => {
  const fixture = localStorageFixture();
  const model = browserConfigurationServer().model('http://localhost:7031', fixture.storage);
  model.define('example', definition);
  try {
    const initial = await model.get('example', signal());
    const serialized = JSON.stringify(initial);
    assert.doesNotMatch(serialized, /default-secret-value|nested-default/);
    assert.match(serialized, /\*{8}/);
    const displayed = initial.values;
    assert.ok(displayed && typeof displayed === 'object' && !Array.isArray(displayed));
    const saved = await model.save(
      'example',
      initial.revision,
      { ...displayed, count: 5 },
      signal(),
    );
    const access = await model.prepare('example', definition, signal());
    assert.ok(access);
    const actual = access.get();
    assert.ok(actual && typeof actual === 'object' && !Array.isArray(actual));
    assert.equal(actual['secret'], 'default-secret-value');
    const readonly = await model.save(
      'example',
      saved.revision,
      { ...displayed, identity: 'changed' },
      signal(),
    );
    assert.equal(readonly.compatible, false);
    assert.ok(readonly.fieldErrors.some((error) => error.path === '/identity'));
    assert.equal((await model.get('example', signal())).revision, saved.revision);
    const next = await model.save(
      'example',
      saved.revision,
      { ...displayed, secret: 'new-secret-value' },
      signal(),
    );
    assert.equal(next.compatible, true);
    assert.doesNotMatch(JSON.stringify(next), /new-secret-value/);
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('需要重载的浏览器配置保存后保留运行中旧值，激活成功才确认应用，版本不兼容禁止激活', async () => {
  const fixture = localStorageFixture();
  const model = browserConfigurationServer().model('http://localhost:7031', fixture.storage);
  const reloadDefinition = {
    ...definition,
    apply_policy: 'plugin_reload',
  } satisfies ConfigurationDefinition;
  model.define('example', reloadDefinition);
  try {
    const access = await model.prepare('example', reloadDefinition, signal());
    assert.ok(access);
    const saved = await model.save(
      'example',
      (await model.get('example', signal())).revision,
      { ...defaultValues, count: 9 },
      signal(),
    );
    assert.equal(saved.pendingReload, true);
    assert.deepEqual(access.get(), definition.defaults);
    await model.prepare('example', reloadDefinition, signal());
    assert.equal((await model.get('example', signal())).pendingReload, true);
    await model.markApplied('example', signal());
    assert.equal((await model.get('example', signal())).pendingReload, false);
    await assert.rejects(
      model.prepare('example', { ...reloadDefinition, version: 2 }, signal()),
      /不兼容/,
    );
    const current = await model.get('example', signal());
    const reset = await model.reset('example', current.revision, signal());
    assert.equal(reset.compatible, true);
    model.define('plain', null);
    assert.equal((await model.get('plain', signal())).definition, null);
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('插件升级删除敏感字段声明后仍遮蔽旧值，保存占位保留原值且不存秘密副本', async () => {
  const fixture = localStorageFixture();
  const server = browserConfigurationServer();
  const model = server.model('http://localhost:7031', fixture.storage);
  model.define('example', definition);
  try {
    const saved = await model.save('example', 'defaults', defaultValues, signal());
    model.define('example', {
      version: 2,
      apply_policy: 'next_invocation',
      defaults: { count: 1 },
      schema: { type: 'object', properties: { count: { type: 'integer' } } },
    });
    const upgraded = await model.get('example', signal());
    assert.equal(upgraded.compatible, false);
    assert.doesNotMatch(JSON.stringify(upgraded), /default-secret-value|nested-default/);
    assert.ok(
      upgraded.values && typeof upgraded.values === 'object' && !Array.isArray(upgraded.values),
    );
    const corrected = await model.save(
      'example',
      saved.revision,
      { ...upgraded.values, count: 7 },
      signal(),
    );
    assert.equal(corrected.compatible, true);
    assert.doesNotMatch(JSON.stringify(corrected), /default-secret-value|nested-default/);
    const raw = (
      await model.prepare(
        'example',
        { version: 2, apply_policy: 'next_invocation', defaults: {}, schema: { type: 'object' } },
        signal(),
      )
    )?.get();
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
    assert.equal(raw['secret'], defaultValues.secret);
    const persisted = server.records.get('http://localhost:7031:example');
    assert.ok(persisted);
    assert.deepEqual(persisted.sensitivePaths, ['/secret', '/nested/password']);
    assert.equal(
      JSON.stringify(persisted).match(/default-secret-value/g)?.length,
      1,
      '敏感路径记录不保存原值副本',
    );
  } finally {
    model.dispose();
    fixture.close();
  }
});

test('服务器配置走公开 PATCH/reset/apply，字段校验错误保留修订，409 冲突保留错误语义', async () => {
  const dto: PluginConfigurationDto = {
    kind: 'server',
    id: 'example',
    definition,
    values: definition.defaults,
    revision: 3,
    applied_revision: 2,
    pending_reload: true,
    compatible: true,
    field_errors: [],
    source: 'managed',
  };
  const calls: { path: string; method: string; body: unknown }[] = [];
  let conflict = false;
  const client = createApiClient({
    baseUrl: 'http://localhost:7031',
    transport: async (input, init) => {
      const path = requestUrl(input).pathname;
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (conflict) return failure('configuration_conflict', 409);
      if (init?.method === 'PATCH')
        return success({
          ...dto,
          compatible: false,
          field_errors: [{ path: '/count', message: '超出允许范围' }],
        });
      return success(dto);
    },
  });
  const configurations = createServerConfigurations(client);
  const target = { kind: 'server', id: 'example' } as const;
  const initial = await configurations.get(target, signal());
  assert.equal(initial.revision, '3');
  assert.doesNotMatch(JSON.stringify(initial), /default-secret-value|nested-default/);
  const rejected = await configurations.save(target, initial.revision, { count: 99 }, signal());
  assert.equal(rejected.compatible, false);
  assert.equal(rejected.revision, '3');
  assert.deepEqual(calls.at(-1), {
    path: '/api/v2/plugin-configurations/server/example',
    method: 'PATCH',
    body: { expected_revision: 3, patch: { count: 99 } },
  });
  await configurations.reset(target, '3', signal());
  assert.equal(calls.at(-1)?.path, '/api/v2/plugin-configurations/server/example/reset');
  await configurations.apply(target, '3', signal());
  assert.equal(calls.at(-1)?.path, '/api/v2/plugin-configurations/server/example/apply');
  conflict = true;
  await assert.rejects(configurations.save(target, '3', {}, signal()), {
    code: 'configuration_conflict',
    status: 409,
  });
});

test('旧宿主缺少配置路由时提示升级并保留真实错误码、状态及日志 ID，插件缺失不误报宿主过旧', async () => {
  let message = '接口不存在';
  const client = createApiClient({
    baseUrl: 'http://localhost:7031',
    transport: async () =>
      Response.json(
        {
          log_id: 'configuration-route-missing',
          error: { code: 'not_found', message },
        },
        { status: 404, headers: { 'x-deviceforge-log-id': 'configuration-route-missing' } },
      ),
  });
  const model = createServerConfigurations(client);
  const target = { kind: 'server', id: 'example' } as const;
  await assert.rejects(model.get(target, signal()), {
    message: /当前服务器不支持插件配置.*接口不存在/,
    status: 404,
    code: 'not_found',
    logId: 'configuration-route-missing',
  });
  message = '插件尚未部署';
  await assert.rejects(model.get(target, signal()), {
    message,
    status: 404,
    code: 'not_found',
    logId: 'configuration-route-missing',
  });
});

test('已支持配置的宿主返回无声明时保持无需配置，不能当作接口缺失', async () => {
  const dto: PluginConfigurationDto = {
    kind: 'server',
    id: 'plain',
    definition: null,
    values: {},
    revision: 0,
    applied_revision: 0,
    pending_reload: false,
    compatible: true,
    field_errors: [],
    source: 'defaults',
  };
  const model = createServerConfigurations(
    createApiClient({ baseUrl: 'http://localhost:7031', transport: async () => success(dto) }),
  );
  const result = await model.get({ kind: 'server', id: 'plain' }, signal());
  assert.equal(result.definition, null);
  assert.equal(result.compatible, true);
});

test('真实运行实例激活前拒绝非法配置，保存并重载消费新值并恢复有效的插件主题', async () => {
  const browser = new JSDOM('', { url: 'http://localhost:5173' });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser.window });
  const contexts: HostContext[] = [];
  const plugin: WebPlugin = {
    id: 'example',
    version: '1.0',
    apiVersion: 2,
    panels: [],
    configuration: {
      version: 1,
      apply_policy: 'plugin_reload',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['accent'],
        properties: { accent: { type: 'string', minLength: 1 } },
      },
      defaults: { accent: '#112233' },
    },
    async activate(context) {
      contexts.push(context);
      const values = context.configuration?.get();
      assert.ok(values && typeof values === 'object' && !Array.isArray(values));
      const accent = values['accent'];
      assert.equal(typeof accent, 'string');
      if (typeof accent !== 'string') throw new Error('主题颜色配置无效');
      context.extensions?.register?.({
        themes: [
          { id: 'example.palette', title: '可配置主题', variables: { '--primary': accent } },
        ],
      });
    },
  };
  const target = dom();
  const configurationServer = browserConfigurationServer();
  const instance = createFrontendRuntime({
    baseUrl: 'http://localhost:7031',
    panelTarget: () => null,
    themeTarget: target,
    transport: async (input, init) =>
      requestUrl(input).pathname === '/api/v2/plugin-dependencies/browser/example'
        ? success(noBrowserDependencies())
        : requestUrl(input).pathname.startsWith('/api/v2/browser-plugin-configurations/')
        ? configurationServer.transport(input, init)
        : success(
            requestUrl(input).pathname.endsWith('/plugin-packages/browser')
              ? [installedPackage()]
              : [],
          ),
    esmImporter: async () => ({ default: plugin }),
  });
  try {
    await instance.pluginPackages.refresh('browser', signal());
    await instance.pluginPackages.enable('browser', 'example', signal());
    instance.themes.select('example.palette');
    assert.equal(target.style.getPropertyValue('--primary'), '#112233');
    const selection = { kind: 'browser', id: 'example' } as const;
    const initial = await instance.pluginConfigurations.get(selection, signal());
    const saved = await instance.pluginConfigurations.save(
      selection,
      initial.revision,
      { accent: '#445566' },
      signal(),
    );
    assert.equal(saved.pendingReload, true);
    assert.equal(target.style.getPropertyValue('--primary'), '#112233');
    const applied = await instance.pluginConfigurations.apply(selection, saved.revision, signal());
    assert.equal(applied.pendingReload, false);
    assert.equal(target.style.getPropertyValue('--primary'), '#445566');
    assert.equal(instance.themes.snapshot().selected?.id, 'example.palette');
    assert.equal(contexts.length, 2);
    assert.throws(() => contexts[0]?.configuration?.get(), /代际已撤销/);
    let activated = false;
    instance.webPlugins.register({
      id: 'invalid-config',
      trusted: true,
      plugin: {
        id: 'invalid-config',
        version: '1.0',
        apiVersion: 2,
        panels: [],
        configuration: { ...definition, defaults: { ...defaultValues, count: 0 } },
        async activate() {
          activated = true;
        },
      },
    });
    await assert.rejects(instance.webPlugins.load('invalid-config'), /配置无效/);
    assert.equal(activated, false);
  } finally {
    await instance.dispose();
    browser.window.close();
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
