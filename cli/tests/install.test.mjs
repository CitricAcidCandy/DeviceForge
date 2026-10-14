import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeManifest } from '../src/plugin-package.mjs';
import { installPlugin, listPlugins } from '../src/install.mjs';
import { loadRuntime } from '../src/runtime.mjs';

async function fixture(directory, schema = { type: 'object' }) {
  const source = join(directory, 'plugin source');
  await mkdir(source);
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'test-deviceforge-plugin',
      version: '1.0.0',
      deviceforge: {
        kind: 'server',
        manifest: 'plugin.json',
        entrypoints: { any: { runtime: 'node', path: 'entry.mjs' } },
      },
    }),
  );
  await writeFile(join(source, 'entry.mjs'), 'process.stdout.write("测试入口不会在安装阶段执行");');
  await writeFile(
    join(source, 'plugin.json'),
    JSON.stringify({
      id: 'test',
      version: '1.0.0',
      protocol_version: 1,
      args: [],
      operations: [{ name: 'echo', title: '回显', input_schema: schema }],
    }),
  );
  return source;
}
test('安装使用宿主契约、原子发布和固定 Node 入口，不覆盖已有插件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-install-'));
  try {
    const source = await fixture(directory);
    const dataDirectory = join(directory, 'data');
    const runtime = await loadRuntime();
    const options = { source, dataDirectory };
    const result = await installPlugin(options, { runtime, environment: {} });
    assert.equal(result.id, 'test');
    assert.equal((await listPlugins(options, {}))[0].version, '1.0.0');
    const manifest = JSON.parse(
      await readFile(join(dataDirectory, 'plugins/test/manifest.json'), 'utf8'),
    );
    assert.equal(manifest.executable, process.execPath);
    assert.equal(manifest.args[0], join(dataDirectory, 'plugins/test/entry.mjs'));
    await assert.rejects(installPlugin(options, { runtime, environment: {} }), /已经存在/);
    assert.deepEqual(await readdir(join(dataDirectory, '.plugins-install')), []);
    await mkdir(join(directory, 'bad'));
    const unsafe = await fixture(join(directory, 'bad'), {
      type: 'object',
      properties: { x: { $ref: 'https://example.com/schema' } },
    });
    await assert.rejects(
      installPlugin(
        { source: unsafe, dataDirectory: join(directory, 'bad-data') },
        { runtime, environment: {} },
      ),
      /Rust 宿主拒绝/,
    );
    assert.deepEqual(await readdir(join(directory, 'bad-data/plugins')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('便携清单拒绝机器路径和错误平台，原生入口不能越界', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deviceforge-manifest-'));
  try {
    const source = await fixture(directory);
    await materializeManifest(source, source);
    const path = join(source, 'plugin.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.executable = 'C:/server/tool.exe';
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(materializeManifest(source, source), /不应包含 executable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
