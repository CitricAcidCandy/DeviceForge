import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, access, open } from 'node:fs/promises';
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
  prepareRelease,
} from '../plugin-releases/pack.mjs';
import { planPublication, publishRelease } from '../plugin-releases/publish.mjs';
import { officialSources, officialDependencies } from '../plugin-releases/official.mjs';
import { portableOfficialMembers, mirroringDefaults } from '../plugin-releases/templates.mjs';
import { prepareOfficialInputs } from '../plugin-releases/prepare-official-inputs.mjs';
import { officialTools } from '../plugin-releases/tool-inventory.mjs';
import { writeTgz } from '../plugin-releases/archive.mjs';
import { fixedVersion, sourceVersion, versionSatisfied } from '../plugin-releases/versions.mjs';

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
      tool: {
        file: 'tool.bin',
        version: '1.0.0',
        platform: 'any',
        format: 'file',
        entries: { tool: 'payload' },
      },
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
test('统一发布文案来源明确工具自动绑定和可选缺项，生成器保留独立包原文', async () =>
  temporary(async (root) => {
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const originals = new Map();
    for (const directory of Object.keys(officialDependencies)) {
      const metadata = await readFile(
        join(repository, 'backend/plugins', directory, 'market.json'),
      );
      const output = join(root, 'backend/plugins', directory);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'market.json'), metadata);
      originals.set(directory, metadata);
    }
    await officialSources(root, { write: true });
    for (const [directory, dependency] of Object.entries(officialDependencies)) {
      const generated = JSON.parse(
        await readFile(join(root, 'backend/plugins', directory, 'release.json')),
      );
      assert.deepEqual(
        await readFile(join(root, 'backend/plugins', directory, 'market.json')),
        originals.get(directory),
      );
      if (!dependency.description) continue;
      const checked = JSON.parse(
        await readFile(join(repository, 'backend/plugins', directory, 'release.json')),
      );
      assert.equal(generated.description, dependency.description);
      assert.equal(checked.description, dependency.description);
      assert.match(generated.description, /自动.*绑定/);
      assert.doesNotMatch(generated.description, /工具文件需要单独准备|指定 Node、CLI、worker/);
      if (dependency.tools.some((tool) => !tool.required))
        assert.match(generated.description, /可选工具.*缺失/);
    }
    assert.match(JSON.parse(originals.get('mirroring')).description, /工具文件需要单独准备/);
    assert.match(JSON.parse(originals.get('ai-sdk')).description, /指定 Node、CLI、worker/);
  }));
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
  assert.equal(relativePath('package/.npmrc'), 'package/.npmrc');
  assert.throws(() => relativePath('package/./npmrc'));
});
test('用户输入替代指针接受省略、空数组和转义路径，完整发布保留来源二选一', async () =>
  temporary(async (root) => {
    const { source, options } = await fixture(root);
    const requirement = {
      component_id: 'demo',
      config_pointer: '/local_manifest',
      title: '供应清单',
      description: '本地或远端任一来源配置即可。',
      required: true,
    };
    source.requirements = [requirement];
    assert.equal(validateRelease(source, { source: true }), source);
    assert.equal(Object.hasOwn(requirement, 'any_of'), false);
    requirement.any_of = [];
    validateRelease(source, { source: true });
    requirement.any_of = ['/manifest_url', '/sources/a~1b/~0name'];
    validateRelease(source, { source: true });
    await writeFile(options.source, jsonBytes(source));
    const packed = await packRelease(options);
    const result = await verifyReleaseDirectory(options.destination);
    const members = await archiveMembers(packed.archive, 'zip');
    assert.deepEqual(result.manifest.requirements, [requirement]);
    assert.deepEqual(JSON.parse(members.get('release.json')).requirements, [requirement]);
    assert.deepEqual(selectRelease(result.manifest, 'win32-x64').requirements, [requirement]);
  }));
test('用户输入替代指针拒绝自身和额外指针重复', async () =>
  temporary(async (root) => {
    const { source } = await fixture(root);
    for (const any_of of [
      ['/local_manifest'],
      ['/manifest_url', '/manifest_url'],
      ['/manifest_url', '/local_manifest'],
    ]) {
      source.requirements = [
        {
          component_id: 'demo',
          config_pointer: '/local_manifest',
          any_of,
          title: '供应清单',
          description: '',
        },
      ];
      assert.throws(() => validateRelease(source, { source: true }), /替代指针.*重复/);
    }
  }));
test('用户输入替代指针拒绝错误容器、坏转义、控制字符和超长路径', async () =>
  temporary(async (root) => {
    const { source } = await fixture(root);
    for (const any_of of [
      null,
      '/manifest_url',
      {},
      1,
      [null],
      [1],
      [''],
      ['manifest_url'],
      ['#/manifest_url'],
      ['/bad~'],
      ['/bad~2'],
      ['/bad\u0000'],
      ['/bad\u001f'],
      ['/bad\u007f'],
      ['/' + 'x'.repeat(512)],
    ]) {
      source.requirements = [
        {
          component_id: 'demo',
          config_pointer: '/local_manifest',
          any_of,
          title: '供应清单',
          description: '',
        },
      ];
      assert.throws(() => validateRelease(source, { source: true }), /替代指针无效/);
    }
  }));
test('用户输入替代指针接受16项和512字符边界，拒绝第17项', async () =>
  temporary(async (root) => {
    const { source } = await fixture(root);
    const requirement = {
      component_id: 'demo',
      config_pointer: '/local_manifest',
      any_of: ['/' + 'x'.repeat(511), ...Array.from({ length: 15 }, (_, i) => `/source_${i}`)],
      title: '供应清单',
      description: '',
    };
    source.requirements = [requirement];
    validateRelease(source, { source: true });
    requirement.any_of.push('/source_16');
    assert.throws(() => validateRelease(source, { source: true }), /替代指针.*超过16项/);
  }));
test('工具供应源码发布只要求本地或远端清单，托管安装根不作统一必填', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const source = JSON.parse(await readFile(join(root, 'backend/plugins/tool-supply/release.json')));
  validateRelease(source, { source: true });
  assert.deepEqual(source.requirements, [
    {
      component_id: 'tool-supply',
      ...officialDependencies['tool-supply'].requirements[0],
    },
  ]);
  assert.equal(source.requirements[0].config_pointer, '/local_manifest');
  assert.deepEqual(source.requirements[0].any_of, ['/manifest_url']);
  assert.equal(source.requirements[0].required, true);
  assert.ok(source.requirements.every((item) => item.config_pointer !== '/install_root'));
});
test('流式工具可验证超过256MiB成员，组件读取模式提前拒绝', async () =>
  temporary(async (root) => {
    const payload = join(root, 'large.bin'),
      archive = join(root, 'large.zip'),
      size = 256 * 1024 * 1024 + 1;
    const file = await open(payload, 'wx');
    try {
      await file.truncate(size);
    } finally {
      await file.close();
    }
    await writeZip(archive, [{ name: 'bin/large.exe', path: payload }]);
    const members = await archiveMembers(archive, 'zip', { collect: false });
    assert.deepEqual(members.get('bin/large.exe'), { size });
    await assert.rejects(archiveMembers(archive, 'zip'), /超过256MiB/);
  }));
test('ZIP拒绝损坏CRC、链接、空deflate和尾部垃圾', async () =>
  temporary(async (root) => {
    const original = join(root, 'original.zip');
    await writeZip(original, [{ name: 'entry.exe', bytes: Buffer.from('tool') }]);
    const bytes = await readFile(original),
      directory = bytes.readUInt32LE(bytes.length - 6),
      cases = [
        [
          'crc',
          (value) => {
            value[30 + Buffer.byteLength('entry.exe')] ^= 1;
          },
        ],
        [
          'link',
          (value) => {
            value.writeUInt32LE(0xa1ff0000, directory + 38);
          },
        ],
        [
          'deflate',
          (value) => {
            value.writeUInt16LE(8, 8);
            value.writeUInt16LE(8, directory + 10);
            value.writeUInt32LE(0, directory + 20);
          },
        ],
      ];
    for (const [name, mutate] of cases) {
      const changed = Buffer.from(bytes),
        path = join(root, name + '.zip');
      mutate(changed);
      await writeFile(path, changed);
      await assert.rejects(archiveMembers(path, 'zip', { collect: false }));
    }
    const path = join(root, 'trailing.zip');
    await writeFile(path, Buffer.concat([bytes, Buffer.from('trailing')]));
    await assert.rejects(archiveMembers(path, 'zip', { collect: false }), /尾部/);
  }));
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
test('开发期接受常用SemVer范围，固定版本兼容厂商四段标识且预发布不隐式放行', () => {
  for (const declaration of [
    '^1.2.0',
    '~1.2.0',
    '>=1.2.0 <2.0.0',
    '1.x',
    '1.2',
    '1.2.0 - 1.9.0',
    '^1.0.0 || ^2.0.0',
    '*',
  ]) {
    assert.ok(sourceVersion(declaration), declaration);
    assert.ok(versionSatisfied(declaration, '1.2.3'), declaration);
    assert.equal(fixedVersion(declaration), false, declaration);
  }
  assert.ok(versionSatisfied('5.0.0.71', '5.0.0.71'));
  assert.ok(versionSatisfied('unresolved', '1.2.3'));
  assert.ok(versionSatisfied('>=1.2.3-beta.1 <2.0.0', '1.2.3-beta.2'));
  assert.equal(versionSatisfied('^1.2.3', '1.3.0-beta.1'), false);
  assert.equal(versionSatisfied('^1.2.3', '2.0.0'), false);
  assert.equal(versionSatisfied('^1.2.3', '^1.2.4'), false);
  assert.equal(versionSatisfied('5.0.0.71', '5.0.0.72'), false);
  for (const value of ['>=bad', '^', '>=2.0.0 <', ' 1.2.3', '1.2.3\n', '', null, {}])
    assert.equal(sourceVersion(value), false, String(value));
});
test('源码组件和工具范围发布后仅保留实际固定版本，源声明和工具摘要不变', async () =>
  temporary(async (root) => {
    const { source, inputs, options } = await fixture(root);
    source.components[0].version = '^0.1.0';
    source.tools[0].version = '>=1.0.0 <2.0.0';
    inputs.components.demo.version = '0.1.0';
    inputs.tools.tool.version = '1.4.2';
    await writeFile(options.source, jsonBytes(source));
    await writeFile(options.inputs, jsonBytes(inputs));
    const originalDigest = digestBytes(await readFile(join(root, 'component.zip')));
    const prepared = await prepareRelease(options.source, options.inputs, options.platform);
    assert.equal(prepared.manifest.components[0].variants[0].sha256, originalDigest);
    await packRelease(options);
    const { manifest } = await verifyReleaseDirectory(options.destination);
    assert.equal(manifest.components[0].version, '0.1.0');
    assert.equal(manifest.tools[0].version, '1.4.2');
    assert.equal(
      manifest.tools[0].variants[0].sha256,
      digestBytes(await readFile(join(root, 'tool.bin'))),
    );
    assert.equal(digestBytes(await readFile(join(root, 'component.zip'))), originalDigest);
    assert.deepEqual(JSON.parse(await readFile(options.source)), source);
    for (const key of ['components', 'tools']) {
      const changed = structuredClone(manifest);
      changed[key][0].version = '^1.0.0';
      assert.throws(() => validateRelease(changed), /无效/);
      changed[key][0].version = 'unresolved';
      assert.throws(() => validateRelease(changed), /无效/);
    }
    const releaseRange = structuredClone(source);
    releaseRange.version = '^0.1.0';
    assert.throws(() => validateRelease(releaseRange, { source: true }), /发布身份/);
  }));
test('工具不满足范围或输入缺实际固定版本均拒绝且不创建输出', async () =>
  temporary(async (root) => {
    const { source, inputs, options } = await fixture(root);
    source.tools[0].version = '^1.0.0';
    await writeFile(options.source, jsonBytes(source));
    for (const version of ['2.0.0', '^1.0.0', 'unresolved', null]) {
      inputs.tools.tool.version = version;
      await writeFile(options.inputs, jsonBytes(inputs));
      await assert.rejects(packRelease(options), /源码范围|已核验固定版本/);
      await assert.rejects(access(options.destination));
    }
    delete inputs.tools.tool.version;
    source.tools[0].version = '1.0.0';
    await writeFile(options.source, jsonBytes(source));
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /已核验固定版本/);
  }));
test('unresolved源码通过实际输入锁定，未提供可选工具不会泄漏到成品', async () =>
  temporary(async (root) => {
    const { source, options } = await fixture(root);
    source.components[0].version = 'unresolved';
    source.tools[0].version = 'unresolved';
    await writeFile(options.source, jsonBytes(source));
    await packRelease(options);
    const { manifest } = await verifyReleaseDirectory(options.destination);
    assert.equal(manifest.components[0].version, '0.1.0');
    assert.equal(manifest.tools[0].version, '1.0.0');
    assert.equal(manifest.tools.length, 1);
    assert.ok(!JSON.stringify(manifest).includes('unresolved'));
  }));
test('组件范围不满足、输入版本矛盾或归档双重版本不一致均拒绝', async () =>
  temporary(async (root) => {
    const { source, inputs, options } = await fixture(root);
    source.components[0].version = '^0.2.0';
    await writeFile(options.source, jsonBytes(source));
    await assert.rejects(packRelease(options), /描述或版本不匹配/);
    source.components[0].version = '^0.1.0';
    inputs.components.demo.version = '0.1.1';
    await writeFile(options.source, jsonBytes(source));
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /描述或版本不匹配/);
    delete inputs.components.demo.version;
    await writeFile(options.inputs, jsonBytes(inputs));
    const members = await archiveMembers(join(root, 'component.zip'), 'zip');
    members.set('package/plugin.json', jsonBytes({ id: 'demo', version: '0.1.1' }));
    await writeZip(
      join(root, 'different.zip'),
      [...members].map(([name, bytes]) => ({ name, bytes })),
    );
    inputs.components.demo.file = 'different.zip';
    await writeFile(options.inputs, jsonBytes(inputs));
    await assert.rejects(packRelease(options), /清单身份与发布声明不匹配/);
    await assert.rejects(access(options.destination));
  }));
test('工具入口不存在时拒绝，不能只验压缩包摘要', async () =>
  temporary(async (root) => {
    const { inputs, options } = await fixture(root);
    await writeZip(join(root, 'tool.zip'), [{ name: 'actual.bin', bytes: Buffer.from('tool') }]);
    inputs.tools.tool = {
      file: 'tool.zip',
      version: '1.0.0',
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

test('官方便携模板保留公开资料，空值表示用户尚未配置且不改写原件', async () => {
  const root = fileURLToPath(new URL('../../backend/plugins/', import.meta.url));
  const expected = {
    'ai-assistant': ['projects'],
    'ai-sdk': ['projects', 'state_root', 'codex_home'],
    settings: ['storage_root'],
    'tool-supply': ['install_root', 'local_manifest'],
  };
  for (const id of Object.keys(expected)) {
    const manifest = await readFile(join(root, id, 'manifest.json'));
    const metadata = await readFile(join(root, id, 'market.json'));
    const original = new Map([
      ['package/package.json', jsonBytes({ deviceforge: { manifest: 'plugin.json' } })],
      ['package/plugin.json', manifest],
      ['package/market.json', metadata],
      [
        `package/bin/${id}.config.example.json`,
        jsonBytes(JSON.parse(manifest).configuration.defaults),
      ],
    ]);
    const changed = portableOfficialMembers({ id }, original);
    const definition = JSON.parse(changed.get('package/plugin.json')).configuration;
    for (const key of expected[id]) {
      assert.equal(definition.defaults[key], null, `${id}/${key}`);
      assert.ok(definition.schema.properties[key].type.includes('null'), `${id}/${key} 模式`);
    }
    assert.deepEqual(
      JSON.parse(changed.get(`package/bin/${id}.config.example.json`)),
      definition.defaults,
    );
    assert.deepEqual(original.get('package/plugin.json'), manifest);
    assert.equal(changed.get('package/market.json'), metadata);
    assert.deepEqual(portableOfficialMembers({ id }, changed), changed, `${id} 暂存应可重复执行`);
  }
});

test('设备内绝对路径仅允许固定插件与字段，不能混入主机配置', () => {
  const members = (defaults) =>
    new Map([
      ['package/package.json', jsonBytes({ deviceforge: { manifest: 'plugin.json' } })],
      ['package/plugin.json', jsonBytes({ configuration: { defaults } })],
      ['package/bin/tool.config.example.json', jsonBytes(defaults)],
    ]);
  for (const [id, defaults] of [
    ['android-device', { profile: { simpleperf: '/system/bin/simpleperf' } }],
    ['frida', { server_path: '/data/local/tmp/deviceforge-frida-server' }],
  ]) {
    const original = members(defaults);
    assert.deepEqual(portableOfficialMembers({ id }, original), original);
    assert.throws(() => portableOfficialMembers({ id: 'other' }, original), /机器路径/);
  }
  assert.throws(
    () => portableOfficialMembers({ id: 'frida' }, members({ tools: { frida: '/tmp/frida' } })),
    /机器路径/,
  );
  assert.throws(
    () =>
      portableOfficialMembers(
        { id: 'android-device' },
        members({ profile: { simpleperf: '/tmp/simpleperf' } }),
      ),
    /机器路径/,
  );
});

async function officialInputFixture(root) {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const declarations = (await officialSources(repository)).reports;
  const native = [];
  for (const { id } of declarations) {
    const archive = join(root, `${id}.tgz`);
    await writeTgz(
      archive,
      new Map([
        [
          'package/package.json',
          jsonBytes({
            version: '0.1.0',
            deviceforge: {
              kind: 'server',
              manifest: 'plugin.json',
              entrypoints: { 'win32-x64': { runtime: 'native', path: 'bin/plugin.exe' } },
            },
          }),
        ],
        ['package/plugin.json', jsonBytes({ id, version: '0.1.0' })],
        ['package/bin/plugin.exe', Buffer.from('受控夹具，不执行')],
      ]),
    );
    native.push({ id, version: '0.1.0', archive, size: (await readFile(archive)).length });
  }
  const bytes = Buffer.from('受控工具，不执行'),
    tools = {};
  await writeFile(join(root, 'tool.bin'), bytes);
  for (const [id, declaration] of Object.entries(officialTools))
    tools[id] = {
      file: 'tool.bin',
      version: declaration.version,
      platform: declaration.platform,
      format: 'file',
      sha256: digestBytes(bytes),
      size: bytes.length,
      entries: Object.fromEntries(
        Object.keys(declaration.entries).map((entry) => [entry, 'payload']),
      ),
    };
  const components = join(root, 'components.json'),
    inventory = join(root, 'inventory.json');
  await writeFile(components, jsonBytes(native));
  await writeFile(inventory, jsonBytes({ format_version: 1, platform: 'win32-x64', tools }));
  return { components, inventory, destination: join(root, 'inputs'), native, tools };
}

test('十八份输入绑定冻结组件摘要并明确可选缺项，不执行组件', async () =>
  temporary(async (root) => {
    const options = await officialInputFixture(root);
    const result = await prepareOfficialInputs(options);
    assert.equal(result.components, 18);
    const ai = JSON.parse(await readFile(join(options.destination, 'ai-sdk.json')));
    assert.match(ai.components['ai-sdk'].sha256, /^[a-f0-9]{64}$/);
    assert.equal(ai.components['ai-sdk'].version, '0.1.0');
    assert.equal(ai.tools['codex-sdk'].entries.sdk, 'payload');
    assert.ok(
      result.reports
        .find((item) => item.id === 'android-packages')
        .optional_tools_omitted.includes('java'),
    );
    await assert.rejects(prepareOfficialInputs(options), /EEXIST/);
  }));

test('官方冻结输入接受源码范围并锁定归档版本，拒绝工具库存越界版本', async () =>
  temporary(async (root) => {
    const options = await officialInputFixture(root);
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const declarations = (await officialSources(repository)).reports;
    const developmentRoot = join(root, 'development');
    for (const { directory } of declarations) {
      const source = JSON.parse(
        await readFile(join(repository, 'backend/plugins', directory, 'release.json')),
      );
      source.components[0].version = '^0.1.0';
      for (const tool of source.tools)
        if (options.tools[tool.id] && options.tools[tool.id].version !== '5.0.0.71')
          tool.version = `>=${options.tools[tool.id].version}`;
      const destination = join(developmentRoot, 'backend/plugins', directory);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'release.json'), jsonBytes(source));
    }
    const result = await prepareOfficialInputs({ ...options, root: developmentRoot });
    assert.equal(result.components, 18);
    const input = JSON.parse(await readFile(join(options.destination, 'android-device.json')));
    assert.equal(input.components['android-device'].version, '0.1.0');
    assert.equal(input.tools.adb.version, '36.0.0');
    options.tools.adb.version = '35.0.0';
    await writeFile(
      options.inventory,
      jsonBytes({ format_version: 1, platform: 'win32-x64', tools: options.tools }),
    );
    const rejected = { ...options, root: developmentRoot, destination: join(root, 'rejected') };
    await assert.rejects(prepareOfficialInputs(rejected), /工具版本或平台不符/);
    await assert.rejects(access(rejected.destination));
    options.native[0].version = '0.2.0';
    await writeFile(options.components, jsonBytes(options.native));
    await assert.rejects(prepareOfficialInputs(rejected), /冻结组件版本或路径无效/);
  }));

test('输入生成拒绝少组件和必需工具缺失，失败前不产生输入目录', async () =>
  temporary(async (root) => {
    const options = await officialInputFixture(root);
    await writeFile(options.components, jsonBytes(options.native.slice(1)));
    await assert.rejects(prepareOfficialInputs(options), /十八个/);
    await assert.rejects(access(options.destination));
    await writeFile(options.components, jsonBytes(options.native));
    delete options.tools.adb;
    await writeFile(
      options.inventory,
      jsonBytes({ format_version: 1, platform: 'win32-x64', tools: options.tools }),
    );
    await assert.rejects(prepareOfficialInputs(options), /必需工具/);
    await assert.rejects(access(options.destination));
  }));

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
    assert.equal(plan.entry.description, plan.manifest.description);
    assert.equal(
      JSON.parse(await readFile(join(root, 'market.json'))).description,
      '测试目录最后写入',
    );
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
