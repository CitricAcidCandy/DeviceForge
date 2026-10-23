import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeFaultWorkers } from './fault-processes.mjs';

export async function prepareBrowserProvider(context, snapshot, directory) {
  const root = join(directory, 'browser-provider');
  const deployment = join(context.host.plugins, 'mirroring-recovery-device');
  await mkdir(root); await mkdir(deployment);
  await writeFile(join(root, 'fault-fixture-owner'), '本轮模拟设备提供者', { flag: 'wx' });
  const executable = join(deployment, 'provider.mjs');
  await copyFile(fileURLToPath(new URL('./browser-provider-worker.mjs', import.meta.url)), executable);
  await writeFile(join(deployment, 'manifest.json'), JSON.stringify({
    id: 'mirroring-recovery-device', version: '1.0.0', protocol_version: 3,
    executable: process.execPath, args: [executable, '--root=' + root, '--device=' + context.fixture.device],
    devices: { api_version: 3, platform: '恢复验收合成设备', discover_operation: 'discover',
      capabilities: [{ id: 'inspect', version: 1, operation: 'inspect', scope: 'device', access: 'read' }] },
    operations: [
      { name: 'discover', title: '发现本轮合成设备', input_schema: { type: 'object', properties: {} } },
      { name: 'inspect', title: '本轮合成设备说明', input_schema: { type: 'object' } },
    ],
  }), { flag: 'wx' });
  const loaded = await context.host.client.post('/api/v2/plugins/mirroring-recovery-device/load');
  assert.equal(loaded.state, 'loaded');
  context.report.browser_provider = { id: loaded.id, generation: loaded.generation,
    synthetic_device: context.fixture.device, fixture_root: root, no_platform_tools: true };
  return observeFaultWorkers(root, join(snapshot, 'process-probe.exe'), join(snapshot, 'apk-server.exe'), context.report);
}
