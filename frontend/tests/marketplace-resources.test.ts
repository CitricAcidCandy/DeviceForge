import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createMarketplace } from '../src/features/marketplace/index.ts';
import { MAX_MARKETPLACE_DOWNLOAD_BYTES } from '../src/features/marketplace/services/download.ts';
import { decodeCatalog } from '../src/features/marketplace/services/catalog.ts';
import {
  createMarketplacePublishEntry,
  initialMarketplaceUploadDraft,
} from '../src/pages/marketplace/upload.ts';
import {
  configurationTarget,
  installedPackage,
  localPackageEntry,
  localServerEntry,
  localInstallationEntry,
  releaseConfigurationTargets,
  newerVersion,
} from '../src/pages/marketplace/presentation.ts';
import { createFrontendRuntime } from '../src/app/runtime.ts';
import { installedPackage as packageFixture, plugin, success } from './fixtures.ts';
import { release } from './plugin-installations-fixture.ts';

const signal = () => new AbortController().signal;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const entry = () =>
  createMarketplacePublishEntry(
    {
      ...initialMarketplaceUploadDraft,
      id: 'demo',
      name: '演示',
      summary: '分析设备',
      details: '{"plugin_kind":"browser"}',
    },
    digest('zip'),
  );

test('下载固定条目来源并按流验证摘要，不受当前市场地址覆盖影响', async () => {
  let target = '';
  const market = createMarketplace(async (input, init) => {
    target = String(input);
    assert.equal(init?.credentials, 'omit');
    const chunks = ['hello', ' ', 'world'];
    return new Response(
      new ReadableStream({
        pull(controller) {
          const next = chunks.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(next));
        },
      }),
      { headers: { 'x-resource-filename': 'demo.zip', 'content-type': 'application/zip' } },
    );
  });
  market.setUrl('http://new-market.example');
  const resource = await market.download(
    digest('hello world'),
    signal(),
    'http://original.example',
  );
  assert.equal(target, `http://original.example/api/v1/resources/${digest('hello world')}`);
  assert.equal(await resource.blob.text(), 'hello world');
  assert.equal(resource.filename, 'demo.zip');
  assert.equal(resource.size, 11);
});

test('摘要错配、超限和取消均停止交付资源', async () => {
  await assert.rejects(
    createMarketplace(async () => new Response('wrong')).download(digest('expected'), signal()),
    /SHA-256/,
  );
  await assert.rejects(
    createMarketplace(
      async () =>
        new Response('small', {
          headers: { 'content-length': String(MAX_MARKETPLACE_DOWNLOAD_BYTES + 1) },
        }),
    ).download(digest('small'), signal()),
    /256 MiB/,
  );
  const controller = new AbortController();
  const market = createMarketplace(
    async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            stream.enqueue(new TextEncoder().encode('a'));
            controller.abort();
          },
        }),
      ),
  );
  await assert.rejects(market.download(digest('a'), controller.signal), { name: 'AbortError' });
});

test('上传和下载保留中文文件名，百分号只按显式编码标记解码', async () => {
  const filename = '设备截图 100%.png';
  const record = {
    id: digest('png'),
    sha256: digest('png'),
    filename,
    media_type: 'image/png',
    kind: 'resource',
    size: 3,
    created_at: 1,
  };
  const market = createMarketplace(async (input, init) => {
    if (init?.method === 'POST') {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('x-resource-filename-encoding'), 'percent');
      assert.equal(decodeURIComponent(headers.get('x-resource-filename')!), filename);
      return Response.json(record, { status: 201 });
    }
    return new Response('png', {
      headers: {
        'x-resource-filename': encodeURIComponent(filename),
        'x-resource-filename-encoding': 'percent',
      },
    });
  });
  const uploaded = await market.upload(
    Object.assign(new Blob(['png']), { name: filename }),
    'resource',
    signal(),
  );
  assert.equal(uploaded.filename, filename);
  assert.equal((await market.download(record.sha256, signal())).filename, filename);
});

test('缺失元数据与未知枚举保留为不完整条目，内部资源不展示', () => {
  const snapshot = decodeCatalog(
    {
      total: 3,
      entries: [
        entry(),
        {
          id: 'legacy',
          name: '旧插件',
          version: '1.0.0',
          kind: 'plugin',
          supports_mcp: 'unknown',
          restart_policy: 'unknown',
        },
        { ...entry(), id: 'internal', kind: 'resource', visibility: 'internal' },
      ],
    },
    'http://market.example',
  );
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0]?.metadataIssues?.length, 0);
  assert.ok(snapshot.entries[1]?.metadataIssues?.some((issue) => issue.includes('MCP')));
  assert.ok(snapshot.entries[1]?.metadataIssues?.some((issue) => issue.includes('重启策略')));
});

test('工具、配置和分发包填写各自专属字段，非法分类提前拒绝', () => {
  const draft = { ...initialMarketplaceUploadDraft, id: 'tool', name: '工具', summary: '用途' };
  assert.throws(
    () =>
      createMarketplacePublishEntry(
        { ...draft, kind: 'tool', categories: 'device', details: '{}' },
        'sha',
      ),
    /工具类型/,
  );
  assert.throws(
    () =>
      createMarketplacePublishEntry(
        { ...draft, kind: 'config', categories: 'preset', details: '{}' },
        'sha',
      ),
    /schema/,
  );
  assert.throws(
    () =>
      createMarketplacePublishEntry(
        { ...draft, kind: 'distribution', categories: 'general', details: '{}' },
        'sha',
      ),
    /包名/,
  );
  assert.throws(
    () => createMarketplacePublishEntry({ ...draft, categories: 'runtime' }, 'sha'),
    /分类/,
  );
  assert.equal(
    createMarketplacePublishEntry(
      { ...draft, kind: 'tool', categories: 'device', details: '{"tool_type":"device"}' },
      'sha',
    ).kind,
    'tool',
  );
  assert.equal(
    createMarketplacePublishEntry(
      {
        ...draft,
        kind: 'config',
        categories: 'preset',
        details: '{"config_type":"preset","schema_version":1}',
      },
      'sha',
    ).kind,
    'config',
  );
  assert.equal(
    createMarketplacePublishEntry(
      {
        ...draft,
        kind: 'distribution',
        categories: 'general',
        details: '{"package_name":"demo","entrypoint":"bin"}',
      },
      'sha',
    ).kind,
    'distribution',
  );
});

test('实际安装状态同时匹配 ID 与插件位置，更新遵循语义版本，配置需显式声明', () => {
  const item = { ...entry(), source: 'http://market', sourceName: '本地市场' };
  const pkg = {
    id: item.id,
    kind: 'server' as const,
    version: '1.0.0',
    installed_at: 1,
    runtime: 'process',
    entry_path: 'demo',
  };
  assert.equal(installedPackage(item, [pkg]), undefined);
  assert.equal(installedPackage(item, [{ ...pkg, kind: 'browser' }])?.id, item.id);
  assert.equal(newerVersion('1.10.0', '1.9.0'), true);
  assert.equal(newerVersion('1.0.0-beta.2', '1.0.0-beta.11'), false);
  assert.equal(newerVersion('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(newerVersion('0.9.0', '1.0.0'), false);
  assert.equal(configurationTarget(item), null);
  assert.deepEqual(
    configurationTarget({
      ...item,
      details: {
        ...item.details,
        configuration: { scope: 'user', owner_id: 'demo', section: 'options' },
      },
    }),
    { scope: 'user', owner_id: 'demo', section: 'options' },
  );
});

test('生产插件目录保留本地展示元数据，已安装回退按 ID 和版本匹配且兼容旧宿主', async () => {
  const named = plugin({ id: 'android-device', version: '0.1.0', metadata: {
    name: '安卓设备', summary: '连接和管理安卓设备', description: '提供发现、应用管理和设备输入等能力。',
  } });
  const instance = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null,
    transport: async () => success([named, plugin({ id: 'legacy' })]) });
  try {
    await instance.serverPlugins.refresh(signal());
    const loaded = instance.serverPlugins.snapshot().result?.data.find((value) => value.id === named.id);
    assert.ok(loaded);
    const standalone = localServerEntry(loaded);
    assert.equal(standalone.name, named.metadata?.name);
    assert.equal(standalone.description, named.metadata?.description);
    assert.equal(standalone.metadataIssues, undefined);
    const pkg = packageFixture('server', { id: named.id, version: named.version });
    assert.equal(localPackageEntry(pkg, loaded).summary, named.metadata?.summary);
    assert.equal(localPackageEntry({ ...pkg, version: '0.0.1' }, loaded).name, named.id);
    assert.equal(localPackageEntry({ ...pkg, kind: 'browser' }, loaded).name, named.id);
    const old = localServerEntry(plugin({ id: 'legacy' }));
    assert.equal(old.name, 'legacy');
    assert.ok(old.metadataIssues?.length);
  } finally { await instance.dispose(); }
});

test('完整功能安装项保留外显名称、状态和真实组件配置目标', () => {
  const value = release(true);
  const entry = localInstallationEntry(value);
  assert.equal(entry.name, '示例功能');
  assert.equal(entry.summary, '完整功能');
  assert.equal(entry.details['release_status'], 'enabled');
  assert.deepEqual(releaseConfigurationTargets(value), [
    { kind: 'server', id: 'example-server' },
    { kind: 'browser', id: 'example-browser' },
  ]);
});
