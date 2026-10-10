import assert from 'node:assert/strict';
import { deploymentSnapshot } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { events, operation } from '../unified-discovery/fixtures.mjs';
import { passed } from './evidence.mjs';

export async function install(client, item) {
  const installed = await client.json('/api/v2/plugin-packages/server?format=tgz', {
    method: 'POST', body: item.archive, headers: { 'content-type': 'application/gzip' }, status: 201,
  });
  assert.equal(installed.id, item.id);
  return installed;
}

export async function registrations(client) {
  const operations = await client.json('/api/v2/operations');
  const providers = await client.json('/api/v2/device-providers');
  const plugins = await client.json('/api/v2/plugins');
  assert.deepEqual(await client.tool('deviceforge.list_operations'), operations);
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), providers);
  assert.deepEqual(await client.tool('deviceforge.list_plugins'), plugins);
  return { operations, providers, plugins, tools: await client.tools() };
}

export function assertOwnerAbsent(snapshot, item) {
  const names = [...item.manifest.operations.map((entry) => operation(item, entry.name)), item.alias].filter(Boolean);
  assert.ok(!snapshot.providers.some((entry) => entry.id === item.id));
  assert.ok(!snapshot.plugins.some((entry) => entry.id === item.id));
  for (const name of names) {
    assert.ok(!snapshot.operations.some((entry) => entry.id === name), `失败owner不得留下操作 ${name}`);
    assert.ok(!snapshot.tools.includes(name), `失败owner不得留下MCP工具 ${name}`);
  }
}

export async function providersFor(client, items) {
  const providers = await client.json('/api/v2/device-providers');
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), providers);
  for (const item of items) {
    const provider = providers.find((entry) => entry.id === item.id);
    assert.ok(provider, `已加载提供者 ${item.id} 必须可见`);
    assert.equal(provider.definition.api_version, item.devicesApiVersion);
    assert.equal(provider.definition.platform, item.platform);
    assert.equal(provider.definition.discover_operation, item.discoverOperation);
    assert.deepEqual(provider.definition.capabilities, item.manifest.devices.capabilities
      .map((entry) => ({ ...entry, operation: operation(item, entry.operation) })));
    item.provider = provider;
  }
  return providers;
}

export async function verifyAdmission(context) {
  const { host, fixtures, report } = context;
  const client = host.client, valid = [...fixtures.items, fixtures.wide];
  assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), [], '真实空部署目录启动');
  assert.deepEqual(await client.json('/api/v2/devices'), []);
  for (const item of valid) await install(client, item);
  const beforePackages = await client.json('/api/v2/plugin-packages/server');
  const beforeFiles = await deploymentSnapshot(host.plugins);
  const invalidCases = [];
  for (const [name, bytes] of Object.entries(fixtures.invalid.invalidArchives)) {
    await client.json('/api/v2/plugin-packages/server?format=tgz', { method: 'POST', body: bytes,
      headers: { 'content-type': 'application/gzip' }, status: 400, code: 'invalid_input' });
    assert.deepEqual(await client.json('/api/v2/plugin-packages/server'), beforePackages, '坏包不得污染合法已部署目录');
    assert.deepEqual(await deploymentSnapshot(host.plugins), beforeFiles, '坏包不得留下隐藏暂存、锁或文件残留');
    assert.equal((await events(fixtures.invalid)).length, 0, '安装验证不执行插件');
    invalidCases.push({ case: name, status: 400, code: 'invalid_input', deployment_unchanged: true });
  }
  passed(report, '坏公开声明安装精确拒绝且完整部署快照无残留', { cases: invalidCases });

  for (const item of valid) await client.manage(item.id, 'load');
  const baseline = await registrations(client);
  const profileCases = [];
  for (const item of fixtures.profiles) {
    await install(client, item);
    await client.post(`/api/v2/plugins/${item.id}/load`, undefined, { status: 400, code: 'invalid_input' });
    assertOwnerAbsent(await registrations(client), item);
    await client.tool('deviceforge.load_plugin', { id: item.id }, 'invalid_input');
    const after = await registrations(client);
    assertOwnerAbsent(after, item);
    assert.deepEqual(after, baseline, 'profile加载失败不得污染已存在的合法贡献');
    assert.ok((await client.json('/api/v2/plugin-packages/server')).some((entry) => entry.id === item.id),
      '合法manifest的profile加载失败仍应保留已安装部署');
    assert.equal((await events(item)).length, 0, 'profile错误在真实工具启动前拒绝');
    profileCases.push({ plugin_id: item.id, devices_api_version: item.devicesApiVersion,
      declared_platform: item.platform, status: 400, code: 'invalid_input',
      deployment_retained: true, http_mcp_contributions_absent: true });
  }
  // 故意不称为原子性证明；这里只核对两个公开端点采样，无半份owner残留。
  passed(report, '合法部署profile/API3/platform不匹配load拒绝，HTTP/MCP贡献无残留', { cases: profileCases });
  const providers = await providersFor(client, valid);
  assert.deepEqual(providers.map((entry) => entry.id).sort(), valid.map((item) => item.id).sort());
  report.providers = providers.map(({ id, generation, definition }) => ({ id, generation,
    devices_api_version: definition.api_version, discover_operation: definition.discover_operation,
    capabilities: definition.capabilities.map((capability) => ({ id: capability.id, version: capability.version,
      execution_timeout_ms: capability.execution_timeout_ms ?? null,
      execution_timeout_omitted: capability.execution_timeout_ms === undefined })) }));
}
