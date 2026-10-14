import { readFile } from 'node:fs/promises';
import { npmTgz } from '../../backend/scripts/online-plugins/fixtures.mjs';
import { fixture } from '../unified-discovery/fixtures.mjs';

export const providerId = 'raw_browser_provider';
export const browserId = 'raw_browser_probe';
export const rawNodeId = 'raw_node_browser_provider';
const descriptor = (kind, id, runtime, path) => ({
  name: `deviceforge-${id}`,
  version: '1.0.0',
  type: 'module',
  deviceforge: { kind, manifest: 'plugin.json', entrypoints: { any: { runtime, path } } },
});
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// 复用已冻结 TAR/TGZ 辅助和 RAW-NODE 接口；不修改公共夹具或传入业务路径。
export async function createFixtures(controlRoot) {
  const object = { type: 'object', properties: {}, additionalProperties: false };
  const input = {
    type: 'object',
    properties: { device_id: { type: ['string', 'null'] }, input: { type: 'object' } },
    required: ['device_id', 'input'],
    additionalProperties: false,
  };
  const manifest = {
    id: providerId,
    version: '1.0.0',
    protocol_version: 2,
    args: [],
    operations: [
      { name: 'discover', title: '模拟原始状态发现', input_schema: object },
      { name: 'configure', title: '配置本次夹具观测', input_schema: input },
      { name: 'echo', title: '模拟设备回显', input_schema: input },
    ],
    devices: {
      api_version: 3,
      platform: 'raw_synthetic',
      discover_operation: 'discover',
      capabilities: [
        {
          id: 'provider.configure',
          version: 1,
          operation: 'configure',
          scope: 'provider',
          access: 'write',
        },
        {
          id: 'device.echo',
          version: 1,
          operation: 'echo',
          scope: 'device',
          access: 'read',
          execution_timeout_ms: 120000,
        },
      ],
    },
  };
  const serverFiles = [
    {
      path: 'package.json',
      bytes: json(descriptor('server', providerId, 'node', 'dist/index.mjs')),
    },
    { path: 'plugin.json', bytes: json(manifest) },
    { path: 'dist/index.mjs', bytes: await readFile(new URL('./provider.mjs', import.meta.url)) },
  ];
  const browserFiles = [
    {
      path: 'package.json',
      bytes: json(descriptor('browser', browserId, 'browser', 'dist/index.js')),
    },
    { path: 'plugin.json', bytes: json({ id: browserId, version: '1.0.0', api_version: 2 }) },
    {
      path: 'dist/index.js',
      bytes: await readFile(new URL('./browser-plugin.mjs', import.meta.url)),
    },
    {
      path: 'dist/relative.js',
      bytes:
        '// 新运行路径需执行新的相对依赖模块。\nexport const dependencyRun = crypto.randomUUID();\n',
    },
  ];
  const rawNode = await fixture(rawNodeId, controlRoot, {
    protocol: 3,
    devicesApiVersion: 3,
    platform: 'raw_node_synthetic',
    executionTimeoutMs: 120000,
  });
  return [
    { id: providerId, kind: 'server', files: serverFiles, archive: npmTgz(serverFiles) },
    { id: browserId, kind: 'browser', files: browserFiles, archive: npmTgz(browserFiles) },
    {
      id: rawNode.id,
      kind: 'server',
      fixtureName: 'raw-node',
      archive: rawNode.tgz,
      rawNode,
      generator: 'scripts/unified-discovery/fixtures.mjs::fixture(API3/protocol3)',
    },
  ];
}
