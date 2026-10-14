import assert from 'node:assert/strict';
import { control, localId, operation } from './fixtures.mjs';

export const actionInput = (provider, capability, deviceId, input = {}) => ({
  provider_id: provider.id,
  generation: provider.generation,
  device_id: deviceId,
  capability,
  version: 1,
  input,
});

export async function verifyDirectory(client, provider, directory) {
  assert.deepEqual(directory.provider, provider);
  assert.ok(Number.isSafeInteger(directory.observed_at) && directory.observed_at > 0);
  assert.match(directory.discovery_job_id, /^[\da-f-]{36}$/);
  assert.equal(directory.devices.length, 3);
  for (const device of directory.devices) {
    assert.equal(device.reference.provider_id, provider.id);
    assert.equal(device.reference.generation, provider.generation);
    assert.ok(device.reference.local_id);
  }
  assert.ok(directory.devices.some((device) => device.reference.local_id === localId));
  assert.equal(
    (await client.finished(directory.discovery_job_id)).operation,
    operation(provider, 'discover'),
  );
}

export async function assertNoDirectory(client, provider) {
  const directories = await client.json('/api/v2/devices');
  assert.ok(
    !directories.some((directory) => directory.provider.id === provider.id),
    '刷新失败或取消后不能保留该提供者的陈旧目录',
  );
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  return directories;
}

export async function verifyDiscovery(context) {
  const { client, first, second, report } = context;
  const providers = await client.json('/api/v2/device-providers');
  assert.deepEqual(providers.map((item) => item.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(await client.tool('deviceforge.list_device_providers'), providers);
  for (const item of [first, second]) {
    item.provider = providers.find((provider) => provider.id === item.id);
    const definition = item.provider.definition;
    assert.equal(item.provider.version, '1.0.0');
    assert.ok(item.provider.generation);
    assert.equal(definition.api_version, item.manifest.devices.api_version);
    assert.equal(definition.platform, '第三方模拟设备');
    assert.equal(definition.discover_operation, operation(item, 'discover'));
    assert.deepEqual(
      definition.capabilities,
      item.manifest.devices.capabilities.map((capability) => ({
        ...capability,
        operation: operation(item, capability.operation),
      })),
    );
  }
  assert.deepEqual(await client.json('/api/v2/devices'), []);
  assert.deepEqual(await client.tool('deviceforge.list_devices'), []);
  const beforeObserved = actionInput(first.provider, 'device_read', localId, {
    label: 'not-observed',
  });
  await client.post('/api/v2/device-actions', beforeObserved, { status: 409, code: 'conflict' });
  await client.tool('deviceforge.invoke_device', beforeObserved, 'conflict');
  for (const item of [first, second]) {
    await control(item, 'valid', `discover-${item.id}`);
    item.directorySnapshot = await client.refresh(item.provider);
    await verifyDirectory(client, item.provider, item.directorySnapshot);
  }
  const directories = await client.json('/api/v2/devices');
  assert.equal(directories.length, 2);
  assert.deepEqual(await client.tool('deviceforge.list_devices'), directories);
  const identities = directories
    .flatMap((directory) => directory.devices)
    .filter((device) => device.reference.local_id === localId)
    .map((device) => device.reference);
  assert.equal(identities.length, 2);
  assert.notDeepEqual(identities[0], identities[1], '同 localID 必须保留不同提供者身份');
  await control(first, 'valid', 'mcp-refresh');
  const refreshed = await client.tool('deviceforge.refresh_devices', {
    id: first.id,
    generation: first.provider.generation,
  });
  await verifyDirectory(client, first.provider, refreshed);
  assert.notEqual(refreshed.discovery_job_id, first.directorySnapshot.discovery_job_id);
  first.directorySnapshot = refreshed;
  report.checks.push({
    name: '在线加载后第三方发现、同名身份与 HTTP/MCP 目录',
    passed: true,
    providers: providers.map(({ id, generation, definition }) => ({
      id,
      generation,
      devices_api_version: definition.api_version,
      capabilities: definition.capabilities.map((capability) => ({
        id: capability.id,
        version: capability.version,
        execution_timeout_ms: capability.execution_timeout_ms ?? null,
        execution_timeout_omitted: capability.execution_timeout_ms === undefined,
      })),
    })),
    same_local_id: localId,
  });

  for (const mode of ['bad-state', 'duplicate', 'undeclared-capability']) {
    for (const transport of ['http', 'mcp']) {
      const previous = first.directorySnapshot;
      await control(first, mode, `bad-${mode}-${transport}`);
      if (transport === 'http')
        await client.refresh(first.provider, { status: 502, code: 'dependency_failed' });
      else
        await client.tool(
          'deviceforge.refresh_devices',
          { id: first.id, generation: first.provider.generation },
          'dependency_failed',
        );
      const directories = await assertNoDirectory(client, first.provider);
      assert.deepEqual(
        directories.find((directory) => directory.provider.id === second.id),
        second.directorySnapshot,
        '一个提供者的刷新失败不能撤销另一个提供者的目录',
      );
      // 每次失败都重新成功观测，保证下一次坏发现从已有目录开始验证清空。
      await control(first, 'valid', `recover-${mode}-${transport}`);
      const recovered =
        transport === 'http'
          ? await client.refresh(first.provider)
          : await client.tool('deviceforge.refresh_devices', {
              id: first.id,
              generation: first.provider.generation,
            });
      await verifyDirectory(client, first.provider, recovered);
      assert.notEqual(recovered.discovery_job_id, previous.discovery_job_id);
      first.directorySnapshot = recovered;
    }
    report.checks.push({
      name: `错误发现撤销陈旧目录、成功刷新重建：${mode}`,
      passed: true,
      code: 'dependency_failed',
    });
  }
  const missing = { ...first.provider, id: 'not_installed_provider' };
  await client.refresh(missing, { status: 404, code: 'not_found' });
  await client.tool(
    'deviceforge.refresh_devices',
    { id: missing.id, generation: missing.generation },
    'not_found',
  );
  const stale = { ...first.provider, generation: '00000000-0000-4000-8000-000000000000' };
  await client.refresh(stale, { status: 409, code: 'conflict' });
  await client.tool(
    'deviceforge.refresh_devices',
    { id: stale.id, generation: stale.generation },
    'conflict',
  );
  report.checks.push({ name: '未知提供者、未观测设备和旧代刷新精确拒绝', passed: true });
}
