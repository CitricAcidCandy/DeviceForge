import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from '../../cli/src/paths.mjs';
import {
  validateDependencies,
  compatibleDependencyVersion,
} from '../plugin-releases/dependencies.mjs';
import { validateRelease } from '../plugin-releases/contract.mjs';
import {
  packRelease,
  verifyReleaseDirectory,
  jsonBytes,
  digestBytes,
} from '../plugin-releases/pack.mjs';
import { planPublication, publishRelease } from '../plugin-releases/publish.mjs';
import { archiveMembers, writeZip, writeTgz } from '../plugin-releases/archive.mjs';
import { loadNativePluginSource, copyNativePluginDependencies } from '../native-plugin-source.mjs';
import { officialSources } from '../plugin-releases/official.mjs';
import { prepareOfficialInputs } from '../plugin-releases/prepare-official-inputs.mjs';
import { officialDependencyManifest } from '../plugin-releases/official-dependencies.mjs';
import { officialTools } from '../plugin-releases/tool-inventory.mjs';

const declaration = () => ({
  format_version: 1,
  dependencies: [
    {
      id: 'runtime',
      name: '第三方运行环境',
      version_requirement: '^1.0.0',
      required: true,
      entries: ['main'],
      requires: [],
      discovery: [{ kind: 'environment', value: 'RUNTIME_PATH', entries: { main: '.' } }],
      probe: {
        entry: 'main',
        args: ['--version'],
        pattern: '([0-9]+\\.[0-9]+\\.[0-9]+)',
        timeout_ms: 3000,
      },
      sources: [],
      bindings: [{ component_id: 'demo', config_pointer: '/tool', entry: 'main' }],
    },
  ],
});
const official = () => ({
  kind: 'official',
  url: 'https://upstream.test/runtime-1.0.0.zip',
  platform: 'win32-x64',
  version: '1.0.0',
  sha256: 'a'.repeat(64),
  size: 123,
  format: 'zip',
  entries: { main: 'bin/run.exe' },
});

async function temporary(run) {
  const parent = resolve(tmpdir()),
    root = await mkdtemp(join(parent, 'deviceforge-dependency-release-'));
  try {
    return await run(root);
  } finally {
    assert.ok(root !== parent && inside(parent, root));
    await rm(root, { recursive: true, force: true });
  }
}
async function fixture(root, dependencies = declaration()) {
  await writeZip(join(root, 'component.zip'), [
    {
      name: 'package/package.json',
      bytes: jsonBytes({
        version: '1.0.0',
        deviceforge: {
          kind: 'server',
          manifest: 'plugin.json',
          entrypoints: { 'win32-x64': { runtime: 'native', path: 'bin/demo.exe' } },
        },
      }),
    },
    { name: 'package/plugin.json', bytes: jsonBytes({ id: 'demo', version: '1.0.0' }) },
    { name: 'package/dependencies.json', bytes: jsonBytes(dependencies) },
    { name: 'package/bin/demo.exe', bytes: Buffer.from('受控组件，不执行') },
  ]);
  const source = {
    format_version: 2,
    host_api_version: 2,
    id: 'demo',
    name: '第二版发布',
    version: '1.0.0',
    description: '依赖与组件独立声明',
    components: [{ id: 'demo', kind: 'server', version: '1.0.0', variants: [] }],
    dependencies,
  };
  const inputs = {
    components: { demo: { file: 'component.zip', platform: 'win32-x64', format: 'zip' } },
  };
  const options = {
    source: join(root, 'source.json'),
    inputs: join(root, 'inputs.json'),
    destination: join(root, 'out'),
    platform: 'win32-x64',
  };
  await writeFile(options.source, jsonBytes(source));
  await writeFile(options.inputs, jsonBytes(inputs));
  await writeFile(
    join(root, 'market.json'),
    jsonBytes({
      metadata_version: 1,
      id: 'demo',
      version: '1.0.0',
      kind: 'plugin',
      name: source.name,
      summary: '测试',
      description: '测试',
      applies_to: ['deviceforge'],
      supports_mcp: 'none',
      supports_agent: false,
      restart_policy: 'plugin_reload',
    }),
  );
  return { source, inputs, options };
}

test('第二版支持仅本机发现与空依赖，第一版仍拒绝新字段', async () =>
  temporary(async (root) => {
    const { source, options } = await fixture(root);
    await packRelease(options);
    const { manifest } = await verifyReleaseDirectory(options.destination);
    assert.deepEqual(manifest.dependencies, source.dependencies);
    assert.equal(manifest.dependencies.dependencies[0].sources.length, 0);
    assert.throws(
      () => validateRelease({ ...source, format_version: 1 }, { source: true }),
      /第一版/,
    );
    assert.equal(
      validateDependencies({ format_version: 1, dependencies: [] }).dependencies.length,
      0,
    );
  }));

test('官方 HTTPS 元数据完整即可构包发布，不需要原包或对上游发请求', async () =>
  temporary(async (root) => {
    const deps = declaration();
    deps.dependencies[0].sources.push(official());
    const { options } = await fixture(root, deps);
    const packed = await packRelease(options),
      members = await archiveMembers(packed.archive, 'zip');
    assert.equal(packed.resources, 1);
    assert.equal(members.size, 2);
    const plan = await planPublication({
      directory: options.destination,
      market: join(root, 'market.json'),
      server: 'http://market.test:7040',
    });
    assert.equal(plan.entry.details.release_format_version, 2);
    assert.deepEqual(plan.manifest.dependencies, deps);
    const calls = [];
    await publishRelease(plan, {
      transport: async (url, options) => {
        calls.push(url.href);
        assert.equal(url.host, 'market.test:7040');
        if (options.method === 'HEAD') return new Response(null, { status: 404 });
        if (url.pathname === '/api/v1/catalog') return Response.json(plan.entry, { status: 201 });
        const chunks = [];
        if (Buffer.isBuffer(options.body)) chunks.push(options.body);
        else for await (const chunk of options.body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks),
          sha256 = digestBytes(bytes);
        return Response.json({ id: sha256, sha256, size: bytes.length }, { status: 201 });
      },
    });
    assert.ok(calls.at(-1).endsWith('/api/v1/catalog'));
  }));

test('市场依赖验证真实入口并复制到离线闭包，在线转为摘要 URL 且保留官方修订', async () =>
  temporary(async (root) => {
    const deps = declaration();
    deps.dependencies[0].sources.push(official());
    const { inputs, options } = await fixture(root, deps);
    const bytes = Buffer.from('真实受控工具字节');
    await writeFile(join(root, 'tool.bin'), bytes);
    inputs.dependencies = {
      runtime: {
        file: 'tool.bin',
        platform: 'win32-x64',
        version: '1.0.0',
        format: 'file',
        entries: { main: 'payload' },
      },
    };
    await writeFile(options.inputs, jsonBytes(inputs));
    const result = await packRelease(options),
      verified = await verifyReleaseDirectory(options.destination);
    assert.equal(result.resources, 2);
    const sources = verified.manifest.dependencies.dependencies[0].sources;
    assert.equal(sources.length, 2);
    assert.notEqual(sources[0].sha256, sources[1].sha256);
    const plan = await planPublication({
      directory: options.destination,
      market: join(root, 'market.json'),
      server: 'http://market.test:7040',
    });
    assert.equal(
      plan.manifest.dependencies.dependencies[0].sources[1].url,
      `http://market.test:7040/api/v1/resources/${digestBytes(bytes)}`,
    );
    assert.deepEqual(plan.manifest.dependencies.dependencies[0].sources[0], sources[0]);
    assert.equal(sources[1].url, `blobs/${digestBytes(bytes)}`);
    assert.ok(plan.resources.some((resource) => resource.sha256 === digestBytes(bytes)));
    const uploaded = [];
    await publishRelease(plan, {
      transport: async (url, init) => {
        assert.equal(url.origin, 'http://market.test:7040');
        if (init.method === 'HEAD') return new Response(null, { status: 404 });
        if (url.pathname === '/api/v1/catalog') {
          assert.ok(uploaded.includes(digestBytes(bytes)));
          assert.equal(uploaded.at(-1), plan.sha256);
          return Response.json(plan.entry, { status: 201 });
        }
        const chunks = [];
        if (Buffer.isBuffer(init.body)) chunks.push(init.body);
        else for await (const chunk of init.body) chunks.push(chunk);
        const body = Buffer.concat(chunks), sha256 = digestBytes(body);
        uploaded.push(sha256);
        return Response.json({ id: sha256, sha256, size: body.length }, { status: 201 });
      },
    });
    assert.equal(uploaded.length, 3);
    await writeFile(
      join(options.destination, 'blobs', digestBytes(bytes)),
      Buffer.alloc(bytes.length),
    );
    await assert.rejects(verifyReleaseDirectory(options.destination), /摘要或大小/);
  }));

test('依赖拒绝错误版本、循环、未知字段、路径越界和不完整元数据', () => {
  const cases = [
    (d) => {
      d.format_version = 2;
    },
    (d) => {
      d.dependencies[0].requires = ['runtime'];
    },
    (d) => {
      d.dependencies[0].requires = ['missing'];
    },
    (d) => {
      d.dependencies[0].discovery[0].entries.main = '../outside';
    },
    (d) => {
      d.dependencies[0].unknown = true;
    },
    (d) => {
      d.dependencies[0].sources = [{ ...official(), url: 'http://upstream.test/tool.zip' }];
    },
    (d) => {
      d.dependencies[0].sources = [{ ...official(), sha256: 'not-a-hash' }];
    },
    (d) => {
      d.dependencies[0].sources = [{ ...official(), entries: {} }];
    },
    (d) => {
      d.dependencies[0].sources = [{ ...official(), version: '2.0.0' }];
    },
  ];
  for (const mutate of cases) {
    const deps = declaration();
    mutate(deps);
    assert.throws(() => validateDependencies(deps));
  }
  assert.equal(compatibleDependencyVersion('>=1.0.0, <2.0.0', '1.2.0'), true);
  assert.equal(compatibleDependencyVersion('=5.0.0.71', '5.0.0.71'), true);
  assert.equal(compatibleDependencyVersion('=5.0.0.71', '5.0.0.72'), false);
});

test('独立组件在 TGZ 根保留 dependencies.json，不修改 SDK 清单', async () =>
  temporary(async (root) => {
    const deps = declaration();
    delete deps.dependencies[0].bindings[0].component_id;
    await writeFile(join(root, 'manifest.json'), jsonBytes({ id: 'demo', version: '1.0.0' }));
    await writeFile(join(root, 'dependencies.json'), jsonBytes(deps));
    const source = await loadNativePluginSource(root),
      destination = join(root, 'package');
    await mkdir(destination);
    await copyNativePluginDependencies(source, destination);
    assert.deepEqual(JSON.parse(await readFile(join(destination, 'dependencies.json'))), deps);
    await writeTgz(
      join(root, 'component.tgz'),
      new Map([
        ['package/dependencies.json', await readFile(join(destination, 'dependencies.json'))],
      ]),
    );
    assert.deepEqual(
      JSON.parse(
        (await archiveMembers(join(root, 'component.tgz'), 'tgz')).get('package/dependencies.json'),
      ),
      deps,
    );
    assert.equal(Object.hasOwn(source.manifest, 'dependencies'), false);
    const invalid = structuredClone(source);
    invalid.dependencies.dependencies[0].bindings[0].component_id = 'other';
    await mkdir(join(root, 'invalid'));
    await assert.rejects(copyNativePluginDependencies(invalid, join(root, 'invalid')), /绑定组件/);
    await writeFile(join(root, 'dependencies.json'), '{broken');
    await assert.rejects(loadNativePluginSource(root), SyntaxError);
  }));

test('十八份官方第二版输入不强制下载库存，所有独立声明与完整发布一致', async () =>
  temporary(async (root) => {
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const declarations = (await officialSources(repository)).reports,
      native = [];
    for (const { directory, id } of declarations) {
      const release = JSON.parse(
        await readFile(join(repository, 'backend/plugins', directory, 'release.json')),
      );
      const deps = JSON.parse(
        await readFile(join(repository, 'backend/plugins', directory, 'dependencies.json')),
      );
      assert.equal(release.format_version, 2);
      assert.deepEqual(deps, release.dependencies);
      assert.ok(deps.dependencies.every((item) => item.discovery.length > 0));
      for (const item of deps.dependencies) {
        assert.ok(
          item.sources.every(
            (source) => source.kind === 'official' && source.url.startsWith('https://'),
          ),
        );
        if (item.id === 'scrcpy-server')
          assert.equal(
            item.version_requirement,
            directory === 'android-device' ? '=3.3.1' : '=3.3.4',
          );
      }
      const archive = join(root, `${id}.tgz`);
      await writeTgz(
        archive,
        new Map([
          [
            'package/package.json',
            jsonBytes({
              version: release.version,
              deviceforge: {
                kind: 'server',
                manifest: 'plugin.json',
                entrypoints: { 'win32-x64': { runtime: 'native', path: 'bin/plugin.exe' } },
              },
            }),
          ],
          ['package/plugin.json', jsonBytes({ id, version: release.version })],
          ['package/dependencies.json', jsonBytes(deps)],
          ['package/bin/plugin.exe', Buffer.from('不执行组件')],
        ]),
      );
      native.push({
        id,
        version: release.version,
        archive,
        size: (await readFile(archive)).length,
      });
    }
    const components = join(root, 'components.json'),
      inventory = join(root, 'inventory.json');
    await writeFile(components, jsonBytes(native));
    await writeFile(inventory, jsonBytes({ format_version: 1, platform: 'win32-x64', tools: {} }));
    const result = await prepareOfficialInputs({
      components,
      inventory,
      destination: join(root, 'inputs'),
    });
    assert.equal(result.components, 18);
    assert.equal(result.required_tools_verified, false);
    assert.equal(result.dependency_metadata_valid, true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'inputs/ai-sdk.json'))).dependencies, {});
    const stockFile = join(root, 'adb.zip');
    await writeZip(stockFile, ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'].map((name) => ({
      name: 'platform-tools/' + name, bytes: Buffer.from(name),
    })));
    const stockBytes = await readFile(stockFile);
    await writeFile(join(root, 'server.bin'), 'server');
    const tools = {
      adb: { file: 'adb.zip', version: '36.0.0', platform: 'win32-x64', format: 'zip',
        entries: { adb: 'platform-tools/adb.exe' }, sha256: digestBytes(stockBytes), size: stockBytes.length },
      'scrcpy-server': { file: 'server.bin', version: '3.3.4', platform: 'any', format: 'file',
        entries: { server: 'payload' }, sha256: digestBytes(Buffer.from('server')), size: 6 },
    };
    await writeFile(inventory, jsonBytes({ format_version: 1, platform: 'win32-x64', tools }));
    await prepareOfficialInputs({ components, inventory, destination: join(root, 'stock-inputs') });
    const stockInputs = JSON.parse(await readFile(join(root, 'stock-inputs/android-device.json')));
    assert.deepEqual(stockInputs.dependencies.adb.entries, {
      adb: 'platform-tools/adb.exe', adb_win_api: 'platform-tools/AdbWinApi.dll',
      adb_win_usb_api: 'platform-tools/AdbWinUsbApi.dll',
    });
    assert.ok(!Object.hasOwn(stockInputs.dependencies, 'scrcpy-server'));
    const mirroring = JSON.parse(await readFile(join(root, 'stock-inputs/mirroring.json')));
    assert.equal(mirroring.dependencies['scrcpy-server'].version, '3.3.4');
    tools.adb.entries.adb_win_api = 'missing.dll';
    await writeFile(inventory, jsonBytes({ format_version: 1, platform: 'win32-x64', tools }));
    await assert.rejects(prepareOfficialInputs({
      components, inventory, destination: join(root, 'bad-inputs'),
    }), /配套入口|入口不存在/);
    await assert.rejects(access(join(root, 'bad-inputs')));
  }));

test('同版本不同归档的市场修订均保留，第二份入口错误不能被摘要去重掩盖', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    await writeFile(join(root, 'first.bin'), '第一份工具');
    await writeFile(join(root, 'second.bin'), '另一份工具');
    inputs.dependencies = {
      runtime: ['first.bin', 'second.bin'].map((file) => ({
        file,
        platform: 'win32-x64',
        version: '1.0.0',
        format: 'file',
        entries: { main: 'payload' },
      })),
    };
    await writeFile(options.inputs, jsonBytes(inputs));
    await packRelease(options);
    const { manifest } = await verifyReleaseDirectory(options.destination);
    assert.equal(manifest.dependencies.dependencies[0].sources.length, 2);
    assert.notEqual(
      ...manifest.dependencies.dependencies[0].sources.map((source) => source.sha256),
    );
    inputs.dependencies.runtime[1] = {
      ...inputs.dependencies.runtime[0],
      entries: { main: 'missing' },
    };
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(
      packRelease({ ...options, destination: join(root, 'invalid') }),
      /单文件依赖入口/,
    );
    await assert.rejects(access(join(root, 'invalid')));
  }));

test('离线闭包拒绝依赖 URL 与本地 blob 摘要不一致，不能靠线上重写掩盖', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    await writeFile(join(root, 'runtime.bin'), 'runtime');
    inputs.dependencies = {
      runtime: { file: 'runtime.bin', platform: 'win32-x64', version: '1.0.0',
        format: 'file', entries: { main: 'payload' } },
    };
    await writeFile(options.inputs, jsonBytes(inputs));
    await packRelease(options);
    const file = join(options.destination, 'release.json');
    const manifest = JSON.parse(await readFile(file));
    for (const url of ['blobs/' + 'f'.repeat(64), 'https://other.test/tool.bin']) {
      manifest.dependencies.dependencies[0].sources[0].url = url;
      await writeFile(file, jsonBytes(manifest));
      await assert.rejects(verifyReleaseDirectory(options.destination), /离线.*摘要/);
    }
  }));

test('官方元数据独立于本地库存，重包摘要不能冒充上游原包', () => {
  const before = structuredClone(officialTools.node);
  try {
    Object.assign(officialTools.node, { sha256: 'f'.repeat(64), size: 1, platform: 'any' });
    const deps = officialDependencyManifest([
      { id: 'node', required: true, version: '24.14.0', bindings: [] },
    ], 'demo', 'ai-sdk');
    const source = deps.dependencies[0].sources[0];
    assert.equal(source.sha256, before.sha256);
    assert.equal(source.size, before.size);
    assert.equal(source.platform, 'win32-x64');
  } finally {
    Object.assign(officialTools.node, before);
  }
  const values = officialDependencyManifest(
    ['adb', 'hdc', 'frida', 'scrcpy-server'].map((id) => ({
      id, version: 'unresolved', required: true, bindings: [],
    })), 'demo', 'demo',
  ).dependencies;
  assert.ok(values.every((dependency) => dependency.sources.length === 0));
});

test('Windows 官方工具发现映射包含配套 DLL，PATH 使用实际命中的文件', () => {
  const deps = officialDependencyManifest(
    ['adb', 'hdc', 'scrcpy', 'node'].map((id) => ({
      id, version: 'unresolved', required: true, bindings: [],
    })), 'demo', 'demo',
  );
  const expected = {
    adb: ['AdbWinApi.dll', 'AdbWinUsbApi.dll'],
    hdc: ['libusb_shared.dll'],
    scrcpy: ['avcodec-61.dll', 'avformat-61.dll', 'avutil-59.dll',
      'swresample-5.dll', 'SDL2.dll', 'libusb-1.0.dll', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'],
  };
  for (const item of deps.dependencies) {
    for (const rule of item.discovery) {
      assert.deepEqual(Object.keys(rule.entries).sort(), [...item.entries].sort());
      const main = rule.entries[item.id];
      const prefix = main.includes('/') ? main.slice(0, main.lastIndexOf('/') + 1) : '';
      for (const name of expected[item.id] ?? [])
        assert.ok(Object.values(rule.entries).includes(prefix + name), `${item.id}/${name}`);
      if (rule.kind === 'path') assert.equal(rule.entries[item.id], '.');
    }
    for (const source of item.sources) {
      assert.equal(source.platform, 'win32-x64');
      assert.deepEqual(Object.keys(source.entries).sort(), [...item.entries].sort());
      for (const name of expected[item.id] ?? [])
        assert.ok(Object.values(source.entries).some((path) => path.endsWith('/' + name)));
    }
  }
});

test('官方探测捕获完整厂商版本且满足对应范围', () => {
  const values = officialDependencyManifest(
    ['adb', 'hdc', 'scrcpy', 'node', 'codex-cli', 'java', 'ffmpeg', 'ffprobe'].map((id) => ({
      id, version: 'unresolved', required: true, bindings: [],
    })), 'demo', 'demo',
  ).dependencies;
  const outputs = {
    adb: ['Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524', '36.0.0'],
    hdc: ['Ver: 5.0.0.71', '5.0.0.71'], scrcpy: ['scrcpy 3.3.4', '3.3.4'],
    node: ['v24.14.0', '24.14.0'], 'codex-cli': ['codex-cli 0.162.1', '0.162.1'],
    java: ['openjdk version "21.0.8"', '21.0.8'],
    ffmpeg: ['ffmpeg version 7.1.1', '7.1.1'], ffprobe: ['ffprobe version 7.1.1', '7.1.1'],
  };
  for (const item of values) {
    assert.equal(new RegExp(item.probe.pattern).exec(outputs[item.id][0])?.[1], outputs[item.id][1]);
    assert.ok(compatibleDependencyVersion(item.version_requirement, outputs[item.id][1]));
  }
});

test('主 npm 包白名单不携带迁移工具、官方库存或插件构包脚本', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const descriptor = JSON.parse(await readFile(join(repository, 'package.json')));
  assert.deepEqual(descriptor.files, ['cli/bin', 'cli/src', 'cli/README.md', 'runtime', 'README.md']);
  const source = await readFile(join(repository, 'scripts/prepare-runtime.mjs'), 'utf8');
  assert.ok(!/cp\(join\(root, ['"](?:tools|backend\/plugins|artifacts)['"]\)/.test(source));
});

test('官方 SDK 根发现规则包含完整 ADB 配套文件及 JAVA_HOME 入口', () => {
  const manifest = officialDependencyManifest(
    ['adb', 'java'].map((id) => ({ id, version: 'unresolved', required: true, bindings: [] })),
    'demo', 'demo',
  );
  validateDependencies(manifest);
  const adb = manifest.dependencies.find((item) => item.id === 'adb');
  for (const variable of ['ANDROID_SDK_ROOT', 'ANDROID_HOME']) {
    assert.deepEqual(adb.discovery.find((rule) => rule.value === variable)?.entries, {
      adb: 'platform-tools/adb.exe', adb_win_api: 'platform-tools/AdbWinApi.dll',
      adb_win_usb_api: 'platform-tools/AdbWinUsbApi.dll',
    });
  }
  const java = manifest.dependencies.find((item) => item.id === 'java');
  assert.deepEqual(java.discovery.find((rule) => rule.value === 'JAVA_HOME')?.entries, {
    java: 'bin/java.exe',
  });
});

test('依赖身份与公开补装 API 一致，接受数字开头及99位，拒绝大写和 builtin 前缀', () => {
  for (const id of ['0tool', 'a'.repeat(99)]) {
    const deps = declaration();
    deps.dependencies[0].id = id;
    assert.equal(validateDependencies(deps).dependencies[0].id, id);
  }
  const setters = [
    (item, id) => { item.id = id; },
    (item, id) => { item.requires = [id]; },
    (item, id) => { item.entries = [id]; item.discovery = []; item.bindings = []; delete item.probe; },
    (item, id) => { item.bindings[0].component_id = id; },
  ];
  for (const id of ['', 'Upper', 'a'.repeat(100), 'builtin.demo', '_tool', 'tool/name']) {
    for (const set of setters) {
      const deps = declaration();
      set(deps.dependencies[0], id);
      // 独立组件的空 component_id 沿用所属组件，其他位置均不可为空。
      if (!id && deps.dependencies[0].bindings[0]?.component_id === '') continue;
      assert.throws(() => validateDependencies(deps), `${id} 应被拒绝`);
    }
  }
});
