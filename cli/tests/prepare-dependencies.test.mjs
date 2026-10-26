import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDependencies } from '../src/prepare-dependencies.mjs';
import { inside } from '../src/paths.mjs';

test('旧运行包不调用尚未提供的准备子命令，预取消不创建宿主进程', async () => {
  assert.equal(await prepareDependencies({}, {}, '', 'demo', {}, undefined), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareDependencies({ dependencyPreparation: true, binary: 'never-executed' },
    {}, '', 'demo', {}, controller.signal));
});

const host = process.env.DEVICEFORGE_TEST_DEPENDENCY_HOST;
test('新冻结宿主初始部署复用真实用户根和通用发现用例，无需启动HTTP服务', { skip: !host }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-cli-prepare-'));
  try {
    const user = join(temporary, 'user/.deviceforge');
    const plugins = join(temporary, 'server-plugins');
    const deployed = join(plugins, 'third-party-cli');
    await mkdir(deployed, { recursive: true });
    await mkdir(join(user, 'vendor'), { recursive: true });
    await writeFile(join(user, 'vendor/tool.bin'), 'user supplied tool');
    await writeFile(join(deployed, 'manifest.json'), JSON.stringify({ id: 'third-party-cli', version: '1.0.0' }));
    const definition = { format_version: 1, dependencies: [{ id: 'third-party-tool', name: '第三方工具',
      version_requirement: '*', entries: ['main'], discovery: [{ kind: 'user_directory', value: 'vendor',
        entries: { main: 'tool.bin' } }], bindings: [{ config_pointer: '/helper', entry: 'main' }] }] };
    const path = join(deployed, 'dependencies.json');
    await writeFile(path, JSON.stringify(definition));
    const options = { dataDirectory: join(temporary, 'data') };
    const runtime = { binary: host, dependencyPreparation: true };
    const environment = { ...process.env, DEVICEFORGE_USER_DIR: user };
    const first = await prepareDependencies(runtime, options, plugins, 'third-party-cli', environment, AbortSignal.timeout(30000));
    assert.equal(first.ready, true);
    assert.equal(first.dependencies[0].source, 'local');
    // 另一个插件不声明发现布局，仍复用公共本地登记，而不是第一插件私有状态。
    const second = join(plugins, 'another-third-party');
    await mkdir(second);
    await writeFile(join(second, 'manifest.json'), JSON.stringify({ id: 'another-third-party', version: '1.0.0' }));
    definition.dependencies[0].discovery = [];
    await writeFile(join(second, 'dependencies.json'), JSON.stringify(definition));
    const reused = await prepareDependencies(runtime, options, plugins, 'another-third-party', environment, AbortSignal.timeout(30000));
    assert.equal(reused.ready, true);
    assert.equal(reused.dependencies[0].source, 'local');
    definition.dependencies[0].id = 'missing-tool';
    await writeFile(path, JSON.stringify(definition));
    const missing = await prepareDependencies(runtime, options, plugins, 'third-party-cli', environment, AbortSignal.timeout(30000));
    assert.equal(missing.ready, false);
  } finally {
    assert.ok(inside(tmpdir(), temporary) && temporary !== tmpdir());
    await rm(temporary, { recursive: true, force: true });
  }
});
