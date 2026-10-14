import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inside } from '../../cli/src/paths.mjs';
import { loadNativePluginSource } from '../native-plugin-source.mjs';
import { nativePluginPlan, nativePluginReadme } from '../native-plugin-plan.mjs';

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
