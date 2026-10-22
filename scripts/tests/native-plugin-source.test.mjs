import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from '../../cli/src/paths.mjs';
import { copyNativePluginConfiguration, loadNativePluginSource } from '../native-plugin-source.mjs';
import { nativePluginPlan, nativePluginReadme } from '../native-plugin-plan.mjs';
import { materializeManifest } from '../../cli/src/plugin-package.mjs';

async function fixture(run) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'deviceforge-plugin-source-'));
  try {
    await run(directory);
  } finally {
    const target = resolve(directory);
    assert.ok(target !== parent && inside(parent, target));
    await rm(target, { recursive: true, force: true });
  }
}

test('正式清单优先于旧示例，配置包只携带公开模板', async () => {
  await fixture(async (directory) => {
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({ id: 'settings', version: '1.0.0' }),
    );
    await writeFile(
      join(directory, 'manifest.example.json'),
      JSON.stringify({ id: 'old', version: '1.0.0' }),
    );
    await writeFile(join(directory, 'settings.config.example.json'), '{}');
    await writeFile(join(directory, 'tool-catalog.example.json'), '{"modules":[]}');
    await writeFile(join(directory, 'settings.config.json'), '{"private":"不应分发"}');
    const source = await loadNativePluginSource(directory);
    assert.equal(source.manifest.id, 'settings');
    assert.deepEqual(
      source.configurationTemplates.map((item) => item.name),
      ['settings.config.example.json', 'tool-catalog.example.json'],
    );
    assert.ok(source.configurationTemplates.every((item) => inside(directory, item.source)));
  });
});

test('旧插件仍可仅提供示例清单，缺失或损坏的正式清单不能静默降级', async () => {
  await fixture(async (directory) => {
    await assert.rejects(loadNativePluginSource(directory), { code: 'ENOENT' });
    await writeFile(join(directory, 'manifest.example.json'), '{"id":"echo"}');
    assert.equal((await loadNativePluginSource(directory)).manifest.id, 'echo');
    await writeFile(join(directory, 'manifest.json'), '损坏清单');
    await assert.rejects(loadNativePluginSource(directory), SyntaxError);
  });
});

test('配置模板沿用受限 JSON 门禁，说明要求显式配置而非自动启用', async () => {
  await fixture(async (directory) => {
    await writeFile(join(directory, 'manifest.json'), '{"id":"settings"}');
    await writeFile(join(directory, 'settings.config.example.json'), '损坏模板');
    await assert.rejects(loadNativePluginSource(directory), SyntaxError);
    await writeFile(join(directory, 'settings.config.example.json'), ' '.repeat(65537));
    await assert.rejects(loadNativePluginSource(directory), /受限普通 JSON/);
  });
  const plan = nativePluginPlan(
    {
      id: 'settings-crate',
      name: 'settings',
      version: '1.0.0',
      license: 'MIT',
      targets: [{ name: 'settings-plugin', kind: ['bin'] }],
    },
    { id: 'settings', version: '1.0.0', protocol_version: 4, operations: [] },
  );
  const readme = nativePluginReadme(plan, '0.1.0', '中文说明', [
    { name: 'settings.config.example.json' },
  ]);
  assert.match(readme, /bin 目录携带公开配置模板：settings.config.example.json/);
  assert.match(readme, /模板不会自动启用/);
  assert.match(readme, /中文说明/);
});

test('配置声明要求可携带的公开模板，拒绝路径穿越和不完整声明', async () => {
  await fixture(async (directory) => {
    const configuration = {
      version: 1,
      schema: { type: 'object', properties: {}, additionalProperties: false },
      defaults: {},
      apply_policy: 'next_invocation',
      legacy_filename: 'settings.config.json',
    };
    const write = (value) =>
      writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({ id: 'settings', configuration: value }),
      );
    await write(configuration);
    await assert.rejects(loadNativePluginSource(directory), /缺少公开模板/);
    await writeFile(join(directory, 'settings.config.example.json'), '{}');
    assert.deepEqual(
      (await loadNativePluginSource(directory)).manifest.configuration,
      configuration,
    );
    for (const value of [
      { ...configuration, version: 2 },
      { ...configuration, defaults: [] },
      { ...configuration, apply_policy: 'unknown' },
      { ...configuration, legacy_filename: '../settings.config.json' },
    ]) {
      await write(value);
      await assert.rejects(loadNativePluginSource(directory), /插件.*配置/);
    }
  });
});

test('18 个工作区插件声明均通过便携清单、模板复制和安装入口映射保持', async () => {
  const ids = [
    'ai-assistant',
    'ai-sdk',
    'android-device',
    'android-packages',
    'artifact-copy',
    'automation',
    'cooperative-demo',
    'dex-analysis',
    'echo',
    'frida',
    'harmony-device',
    'marketplace',
    'mirroring',
    'msgpack',
    'performance-demo',
    'settings',
    'terminal',
    'tool-supply',
  ];
  const empty = new Set([
    'artifact-copy',
    'cooperative-demo',
    'dex-analysis',
    'echo',
    'msgpack',
    'performance-demo',
  ]);
  for (const id of ids) {
    const source = await loadNativePluginSource(
      fileURLToPath(new URL(`../../backend/plugins/${id}/`, import.meta.url)),
    );
    const definition = source.manifest.configuration;
    assert.equal(source.marketMetadata.id, source.manifest.id, id);
    assert.equal(source.marketMetadata.version, source.manifest.version, id);
    assert.ok(
      source.marketMetadata.name.trim() && source.marketMetadata.name !== source.manifest.id,
      id,
    );
    assert.ok(source.marketMetadata.summary.trim() && source.marketMetadata.description.trim(), id);
    assert.equal(definition.version, 1, id);
    assert.equal(definition.schema.type, 'object', id);
    assert.equal(definition.schema.additionalProperties, false, id);
    assert.equal(Object.keys(definition.schema.properties).length === 0, empty.has(id), id);
    const plan = nativePluginPlan(
      {
        id,
        name: id,
        version: source.manifest.version,
        license: 'MIT',
        targets: [{ name: `${id}-plugin`, kind: ['bin'] }],
      },
      source.manifest,
    );
    assert.deepEqual(plan.portableManifest.configuration, definition);
    assert.ok(plan.packageJson.files.includes('market.json'), id);
    await fixture(async (directory) => {
      await mkdir(join(directory, 'bin'));
      await copyNativePluginConfiguration(source, directory);
      await writeFile(join(directory, plan.entry), '仅用于安装映射测试，不执行');
      await writeFile(join(directory, 'plugin.json'), JSON.stringify(plan.portableManifest));
      await writeFile(join(directory, 'package.json'), JSON.stringify(plan.packageJson));
      const installed = await materializeManifest(directory, directory);
      assert.deepEqual(installed.configuration, definition, id);
      const copied = (await readdir(join(directory, 'bin'))).filter((name) =>
        name.endsWith('.example.json'),
      );
      assert.deepEqual(
        copied.sort(),
        source.configurationTemplates.map(({ name }) => name).sort(),
        id,
      );
      for (const { name, source: original } of source.configurationTemplates) {
        assert.equal(
          await readFile(join(directory, 'bin', name), 'utf8'),
          await readFile(original, 'utf8'),
        );
      }
    });
  }
});
