import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { deploymentSnapshot } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { isDeepStrictEqual } from 'node:util';
import { events, localId, operation, pointer } from './fixtures.mjs';
import { terminal } from './client.mjs';

export async function installProviders(context) {
  const { host, fixtures, report } = context;
  const { client } = host;
  const baselinePackages = await client.json('/api/v2/plugin-packages/server');
  const baselineProviders = await client.json('/api/v2/device-providers');
  assert.ok(
    !baselinePackages.some((value) => fixtures.some((item) => item.id === value.id)),
    '本次提供者 ID 不得覆盖已有包',
  );
  context.baseline = { packages: baselinePackages, providers: baselineProviders };
  const before = await deploymentSnapshot(host.plugins);
  for (const item of fixtures) {
    for (const invalid of item.invalid) {
      await client.json('/api/v2/plugin-packages/server?format=tgz', {
        method: 'POST',
        status: 400,
        code: 'invalid_input',
        headers: { 'content-type': 'application/gzip' },
        body: invalid.archive,
      });
      await poll(
        () => deploymentSnapshot(host.plugins),
        (value) => isDeepStrictEqual(value, before),
        '坏 Pointer 安装无暂存、锁与部署残留',
        5000,
      );
      assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), baselinePackages);
      assert.deepEqual(await client.json('/api/v2/device-providers'), baselineProviders);
      assert.deepEqual(await events(item), [], '坏包不得启动夹具进程');
      report.checks.push({
        name: `协议 ${item.protocol} 坏 Pointer：${invalid.label}`,
        passed: true,
        status: 400,
        code: 'invalid_input',
        no_residue: true,
      });
    }
  }
  for (const item of fixtures) {
    const installed = await client.json('/api/v2/plugin-packages/server?format=tgz', {
      method: 'POST',
      status: 201,
      headers: { 'content-type': 'application/gzip' },
      body: item.archive,
    });
    assert.equal(installed.id, item.id);
    assert.equal(installed.runtime, 'node');
    assert.equal(installed.entry_path, 'dist/index.mjs');
    const deployed = JSON.parse(await readFile(join(host.plugins, item.id, 'plugin.json'), 'utf8'));
    assert.deepEqual(deployed.artifacts.input_pointers, [pointer]);
    assert.equal(deployed.artifacts.outputs, true);
    assert.equal(deployed.protocol_version, item.protocol);
    assert.deepEqual(await events(item), [], '安装不得执行入口');
  }
  assert.deepEqual(await client.json('/api/v2/device-providers'), baselineProviders);
  assert.equal(
    (await client.json('/api/v2/plugin-packages/server')).length,
    baselinePackages.length + 2,
  );
  for (const [index, item] of fixtures.entries()) {
    const loaded = await client.manage(item.id, 'load', index === 0 ? 'http' : 'mcp');
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    assert.deepEqual(await events(item), [], '加载不得自动发现或读取产物');
  }
  const providers = await client.json('/api/v2/device-providers');
  assert.deepEqual(
    providers
      .filter((value) => fixtures.some((item) => item.id === value.id))
      .map((item) => item.id)
      .sort(),
    fixtures.map((item) => item.id).sort(),
  );
  assert.deepEqual(
    providers.filter((value) => !fixtures.some((item) => item.id === value.id)),
    baselineProviders,
  );
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), providers);
  for (const item of fixtures) {
    item.provider = providers.find((provider) => provider.id === item.id);
    assert.equal(item.provider.definition.platform, 'synthetic_demo');
    await discover(client, item, item.protocol === 2 ? 'http' : 'mcp');
  }
  assert.deepEqual(
    await client.tool('deviceforge.list_devices'),
    await client.json('/api/v2/devices'),
  );
  report.checks.push({ name: '协议 2/3 在线安装保留嵌套声明、显式加载与空输入发现', passed: true });
}

export async function discover(client, item, transport = 'http') {
  const directory =
    transport === 'http'
      ? await client.refresh(item.provider)
      : await client.tool('deviceforge.refresh_devices', {
          id: item.id,
          generation: item.provider.generation,
        });
  assert.deepEqual(directory.provider, item.provider);
  assert.equal(directory.devices.length, 1);
  const reference = directory.devices[0].reference;
  assert.deepEqual(reference, {
    provider_id: item.id,
    generation: item.provider.generation,
    local_id: localId,
  });
  const job = await terminal(client, directory.discovery_job_id);
  assert.equal(job.operation, operation(item, 'discover'));
  assert.deepEqual(job.input, {});
  assert.deepEqual(job.result.artifacts, []);
  const all = await events(item);
  const discoveries = all.filter((event) => event.operation === 'discover');
  const starts = discoveries.filter((event) => event.kind === 'started');
  assert.ok(starts.length > 0);
  for (const start of starts) {
    assert.ok(
      discoveries.some(
        (event) =>
          event.request_id === start.request_id &&
          event.kind === 'discovered_without_artifact_read' &&
          event.input_count === 0,
      ),
    );
  }
  assert.ok(
    !discoveries.some((event) => ['copy_verified', 'output_written'].includes(event.kind)),
    '发现操作不得读取输入文件或生成产物',
  );
  item.directorySnapshot = directory;
  return directory;
}
