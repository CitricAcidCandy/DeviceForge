import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archive } from '../device-provider/fixtures.mjs';

const capabilities = [
  { id: 'packages', version: 1, operation: 'packages', scope: 'device', access: 'read' },
  { id: 'connect', version: 1, operation: 'connect', scope: 'provider', access: 'write' },
  { id: 'disconnect', version: 1, operation: 'disconnect', scope: 'provider', access: 'write' },
];

// 仅打包受控 Node 入口；不安装平台插件，不读取 ADB/HDC 或真实设备地址。
export async function createWorkspaceFixture(root) {
  const id = 'workspace-device-fixture';
  const directory = join(root, 'fixture-state');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'connection.json'), 'null', 'utf8');
  const manifest = {
    id,
    version: '1.0.0',
    protocol_version: 3,
    args: [],
    artifacts: { input_fields: [], outputs: true },
    devices: {
      api_version: 3,
      platform: '受控设备工作台夹具',
      discover_operation: 'discover',
      capabilities,
    },
    operations: [
      {
        name: 'discover',
        title: '发现受控模拟设备',
        input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      },
      ...capabilities.map((capability) => ({
        name: capability.operation,
        title: `受控模拟能力 ${capability.id}`,
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['device_id', 'input'],
          properties: {
            device_id: { type: capability.scope === 'provider' ? 'null' : 'string' },
            input: {
              type: 'object',
              additionalProperties: false,
              properties: capability.scope === 'provider' ? { address: { type: 'string' } } : {},
              required: capability.scope === 'provider' ? ['address'] : [],
            },
          },
        },
      })),
    ],
  };
  const descriptor = {
    name: 'deviceforge-workspace-device-fixture',
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'server',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } },
    },
  };
  const source = await readFile(new URL('./node-provider.mjs', import.meta.url), 'utf8');
  return {
    id,
    directory,
    archive: archive([
      ['package.json', JSON.stringify(descriptor)],
      ['plugin.json', JSON.stringify(manifest)],
      ['dist/index.mjs', source],
      ['dist/fixture.json', JSON.stringify({ id, directory })],
    ]),
  };
}

export async function readWorkspaceEvents(fixture) {
  try {
    return (await readFile(join(fixture.directory, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
