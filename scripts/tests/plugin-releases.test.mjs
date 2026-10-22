import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease, selectRelease, relativePath } from '../plugin-releases/contract.mjs';
import { writeZip, archiveMembers } from '../plugin-releases/archive.mjs';
import {
  packRelease,
  jsonBytes,
  digestBytes,
  verifyReleaseDirectory,
} from '../plugin-releases/pack.mjs';
import { planPublication, publishRelease } from '../plugin-releases/publish.mjs';
import { officialSources } from '../plugin-releases/official.mjs';
import { portableOfficialMembers, mirroringDefaults } from '../plugin-releases/templates.mjs';

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-release-test-'));
  try {
    return await run(root);
  } finally {
    const actual = await realpath(root),
      parent = await realpath(tmpdir()),
      delta = relative(parent, actual);
    assert.ok(
      delta &&
        !isAbsolute(delta) &&
        delta !== '..' &&
        !delta.startsWith('..' + sep) &&
        basename(actual).startsWith('deviceforge-release-test-'),
    );
    await rm(actual, { recursive: true, force: true });
  }
}
async function fixture(root) {
  const component = join(root, 'component.zip'),
    tool = join(root, 'tool.bin');
  await writeZip(component, [
    {
      name: 'package/package.json',
      bytes: jsonBytes({
        name: '@test/demo',
        version: '0.1.0',
        deviceforge: {
          kind: 'server',
          manifest: 'plugin.json',
          entrypoints: { 'win32-x64': { runtime: 'native', path: 'bin/demo.exe' } },
        },
      }),
    },
    { name: 'package/plugin.json', bytes: jsonBytes({ id: 'demo', version: '0.1.0' }) },
    { name: 'package/bin/demo.exe', bytes: Buffer.from('受控归档夹具，不执行') },
  ]);
  await writeFile(tool, '受控工具归档，不执行');
  const source = {
    format_version: 1,
    host_api_version: 2,
    id: 'demo',
    version: '0.1.0',
    name: '功能示例',
    description: '测试发布闭包',
    components: [{ id: 'demo', kind: 'server', version: '0.1.0', variants: [] }],
    tools: [
      {
        id: 'tool',
        version: '1.0.0',
        required: true,
        variants: [],
        bindings: [{ component_id: 'demo', config_pointer: '/tool', entry: 'tool' }],
      },
      { id: 'optional', version: 'unresolved', required: false, variants: [], bindings: [] },
    ],
    requirements: [],
  };
  const inputs = {
    components: { demo: { file: 'component.zip', platform: 'win32-x64', format: 'zip' } },
    tools: {
      tool: { file: 'tool.bin', platform: 'any', format: 'file', entries: { tool: 'payload' } },
    },
  };
  await writeFile(join(root, 'source.json'), jsonBytes(source));
  await writeFile(join(root, 'inputs.json'), jsonBytes(inputs));
  const options = {
    source: join(root, 'source.json'),
    inputs: join(root, 'inputs.json'),
    destination: join(root, 'out'),
    platform: 'win32-x64',
  };
  return { source, inputs, options };
}
test('十八份官方发布声明均有明确依赖分类，源码空变体不会当作成品', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url)),
    report = await officialSources(root);
  assert.equal(report.official_count, 18);
  assert.equal(report.declarations_valid, 18);
  assert.ok(report.reports.every((item) => !item.complete));
  const source = JSON.parse(await readFile(join(root, 'backend/plugins/mirroring/release.json')));
  assert.throws(() => validateRelease(source), /归档变体/);
});
test('发布路径拒绝越界、绝对地址和 Windows 设备名称', () => {
  for (const path of [
    '../outside',
    'https://host/blob',
    'C:/tool',
    '/root',
    'blobs/%2e',
    'blobs/CON',
    'blobs/a.',
  ])
    assert.throws(() => relativePath(path));
});
test('缺必需工具在创建输出目录前失败', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    inputs.tools = {};
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /必需工具缺实际归档/);
    await assert.rejects(access(options.destination));
  }));
test('摘要错误和固定版本不一致均拒绝', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    inputs.tools.tool.sha256 = '1'.repeat(64);
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /摘要/);
    delete inputs.tools.tool.sha256;
    inputs.tools.tool.version = '2.0.0';
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /固定声明/);
  }));
test('工具入口不存在时拒绝，不能只验压缩包摘要', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    await writeZip(join(root, 'tool.zip'), [{ name: 'actual.bin', bytes: Buffer.from('tool') }]);
    inputs.tools.tool = {
      file: 'tool.zip',
      platform: 'any',
      format: 'zip',
      entries: { tool: 'missing.bin' },
    };
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /入口不存在/);
  }));
test('离线包包含严格闭包，组件与工具字节均可重新核验', async () =>
  temporary(async (root) => {
    const { options } = await fixture(root),
      report = await packRelease(options);
    const result = await verifyReleaseDirectory(options.destination),
      members = await archiveMembers(report.archive, 'zip');
    assert.equal(report.resources, 2);
    assert.equal(result.manifest.tools.length, 1);
    assert.equal(members.size, 3);
    assert.equal(digestBytes(members.get('release.json')), report.revision);
    for (const descriptor of [
      ...result.manifest.components[0].variants,
      ...result.manifest.tools[0].variants,
    ])
      assert.equal(digestBytes(members.get(descriptor.path)), descriptor.sha256);
    await assert.rejects(packRelease(options), /EEXIST/);
  }));
test('相同工具归档按摘要去重，保留每个工具的绑定', async () =>
  temporary(async (root) => {
    const { source, inputs, options } = await fixture(root);
    source.tools.push({
      ...source.tools[0],
      id: 'second',
      bindings: [{ component_id: 'demo', config_pointer: '/second', entry: 'tool' }],
    });
    inputs.tools.second = { ...inputs.tools.tool };
    await writeFile(options.source, jsonBytes(source));
    await writeFile(options.inputs, jsonBytes(inputs));
    const report = await packRelease(options),
      result = await verifyReleaseDirectory(options.destination);
    assert.equal(report.resources, 2);
    assert.equal(result.manifest.tools.length, 2);
  }));
test('不支持目标平台和未知输入身份均拒绝', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    await assert.rejects(packRelease({ ...options, platform: 'linux-x64' }), /目标平台/);
    inputs.tools.typo = inputs.tools.tool;
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /未知tools/);
  }));
test('投屏发布默认值补齐版本并移除模板机器路径，源成员保持原字节', () => {
  const original = new Map([
    ['package/package.json', jsonBytes({ deviceforge: { manifest: 'plugin.json' } })],
    [
      'package/plugin.json',
      jsonBytes({ configuration: { defaults: { adb: 'C:/machine/adb.exe' } } }),
    ],
    [
      'package/bin/mirroring.live.config.example.json',
      jsonBytes({ live: { scrcpy_server: 'C:/machine/server' } }),
    ],
  ]);
  const changed = portableOfficialMembers({ id: 'mirroring' }, original);
  assert.deepEqual(
    JSON.parse(changed.get('package/plugin.json')).configuration.defaults,
    mirroringDefaults,
  );
  assert.match(original.get('package/plugin.json').toString(), /C:\/machine/);
  assert.throws(() => portableOfficialMembers({ id: 'other' }, original), /机器路径/);
});

async function publication(root) {
  const { options } = await fixture(root);
  await packRelease(options);
  const market = {
    metadata_version: 1,
    id: 'demo',
    version: '0.1.0',
    kind: 'plugin',
    name: '功能示例',
    summary: '测试发布',
    description: '测试目录最后写入',
    categories: ['device'],
    applies_to: ['deviceforge'],
    supports_mcp: 'server',
    supports_agent: true,
    restart_policy: 'plugin_reload',
  };
  await writeFile(join(root, 'market.json'), jsonBytes(market));
  return planPublication({
    directory: options.destination,
    market: join(root, 'market.json'),
    server: 'http://resource.test:7040',
  });
}
test('在线计划转换相对路径与分类，原离线修订保持独立', async () =>
  temporary(async (root) => {
    const plan = await publication(root);
    assert.ok(
      plan.manifest.components.every((item) =>
        item.variants.every((value) => value.path === value.sha256),
      ),
    );
    assert.deepEqual(plan.entry.categories, ['function']);
    assert.equal(plan.entry.resource_id, plan.sha256);
    assert.equal(plan.summary.remote_written, false);
    const original = await readFile(join(root, 'out/release.json'));
    assert.notEqual(digestBytes(original), plan.sha256);
  }));
test('发布先去重全部资源，最后才提交目录', async () =>
  temporary(async (root) => {
    const plan = await publication(root),
      calls = [],
      existing = plan.resources[0];
    const transport = async (url, options) => {
      calls.push(`${options.method} ${url.pathname}`);
      if (options.method === 'HEAD')
        return new Response(null, {
          status: url.pathname.endsWith(existing.sha256) ? 200 : 404,
          headers: { etag: `"${existing.sha256}"`, 'content-length': String(existing.size) },
        });
      if (url.pathname === '/api/v1/catalog') return Response.json(plan.entry, { status: 201 });
      const chunks = [];
      if (Buffer.isBuffer(options.body)) chunks.push(options.body);
      else for await (const chunk of options.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks),
        sha256 = digestBytes(bytes);
      return Response.json({ id: sha256, sha256, size: bytes.length }, { status: 201 });
    };
    const report = await publishRelease(plan, { transport });
    assert.equal(calls.at(-1), 'POST /api/v1/catalog');
    assert.equal(report.resources.filter((item) => item.reused).length, 1);
    assert.equal(report.remote_written, true);
  }));
test('资源上传结果损坏时不得发布目录', async () =>
  temporary(async (root) => {
    const plan = await publication(root),
      calls = [];
    await assert.rejects(
      publishRelease(plan, {
        transport: async (url, options) => {
          calls.push(url.pathname);
          if (options.method === 'HEAD') return new Response(null, { status: 404 });
          if (options.body && !Buffer.isBuffer(options.body))
            for await (const chunk of options.body) void chunk;
          return Response.json({ id: 'wrong', sha256: 'wrong', size: 1 });
        },
      }),
      /实际字节不一致/,
    );
    assert.ok(!calls.includes('/api/v1/catalog'));
  }));
