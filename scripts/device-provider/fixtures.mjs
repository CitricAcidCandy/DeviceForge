import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { poll } from './client.mjs';

export const localId = 'same-local-device';
export const otherId = 'other-local-device';
export const offlineId = 'offline-local-device';
export const capabilities = [
  {
    id: 'provider_read',
    version: 1,
    operation: 'provider_read',
    scope: 'provider',
    access: 'read',
  },
  {
    id: 'provider_write',
    version: 1,
    operation: 'provider_write',
    scope: 'provider',
    access: 'write',
  },
  { id: 'device_read', version: 1, operation: 'device_read', scope: 'device', access: 'read' },
  { id: 'device_write', version: 1, operation: 'device_write', scope: 'device', access: 'write' },
  { id: 'disabled', version: 1, operation: 'disabled', scope: 'device', access: 'read' },
  { id: 'missing', version: 1, operation: 'missing', scope: 'device', access: 'read' },
];

// 本夹具只生成少量标准 TAR 条目，不引入 npm/Cargo 或生产归档解析。
export function archive(files) {
  assert.ok(files.length <= 8);
  const blocks = [];
  for (const [path, content] of Object.entries(Object.fromEntries(files))) {
    const bytes = Buffer.from(content, 'utf8');
    assert.ok(Buffer.byteLength(`package/${path}`) < 100 && bytes.length <= 64 * 1024);
    const header = Buffer.alloc(512);
    header.write(`package/${path}`, 0, 100, 'utf8');
    for (const [offset, length, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, bytes.length],
      [136, 12, 0],
    ]) {
      header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
    }
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      `${header
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
      8,
      'ascii',
    );
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

export async function fixture(id, root, { apiVersion = 1, executionTimeoutMs } = {}) {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  const config = { id, directory, localId, otherId, offlineId };
  const manifest = {
    id,
    version: '1.0.0',
    protocol_version: 3,
    args: [],
    devices: {
      api_version: apiVersion,
      platform: '第三方模拟设备',
      discover_operation: 'discover',
      capabilities: capabilities.map((capability) => ({
        ...capability,
        ...(capability.id === 'device_write' && executionTimeoutMs !== undefined
          ? { execution_timeout_ms: executionTimeoutMs }
          : {}),
      })),
    },
    operations: [
      {
        name: 'discover',
        title: '发现模拟设备',
        input_schema: { type: 'object', additionalProperties: false },
      },
      ...capabilities.map((capability) => ({
        name: capability.operation,
        title: `模拟能力 ${capability.id}`,
        input_schema: {
          type: 'object',
          required: ['device_id', 'input'],
          additionalProperties: false,
          properties: { device_id: { type: ['string', 'null'] }, input: { type: 'object' } },
        },
      })),
    ],
  };
  const descriptor = {
    name: `deviceforge-provider-smoke-${id}`,
    version: '1.0.0',
    type: 'module',
    deviceforge: {
      kind: 'server',
      manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } },
    },
  };
  const source = await readFile(new URL('./node-provider.mjs', import.meta.url), 'utf8');
  const files = [
    ['package.json', JSON.stringify(descriptor)],
    ['plugin.json', JSON.stringify(manifest)],
    ['dist/index.mjs', source],
    ['dist/fixture.json', JSON.stringify(config)],
  ];
  const value = {
    id,
    directory,
    manifest,
    archive: archive(files),
    invalidBudgetArchives: [0, 120001].map((budget) =>
      archive(
        files.map(([path, bytes]) =>
          path === 'plugin.json'
            ? [
                path,
                JSON.stringify({
                  ...manifest,
                  devices: {
                    ...manifest.devices,
                    api_version: 2,
                    capabilities: manifest.devices.capabilities.map((capability) => ({
                      ...capability,
                      execution_timeout_ms: budget,
                    })),
                  },
                }),
              ]
            : [path, bytes],
        ),
      ),
    ),
    invalidArchive: archive(
      files.map(([path, bytes]) =>
        path === 'plugin.json'
          ? [
              path,
              JSON.stringify({
                ...manifest,
                devices: { ...manifest.devices, discover_operation: 'not_declared' },
              }),
            ]
          : [path, bytes],
      ),
    ),
  };
  await control(value, 'valid', 'initial');
  return value;
}

export const operation = (item, name) => `plugin.${item.id}.${name}`;
export const control = (item, mode, label) =>
  writeFile(join(item.directory, 'control.json'), JSON.stringify({ mode, label }), 'utf8');
export const release = (item, label) =>
  writeFile(join(item.directory, `${label}.release`), '已解除本次门闩', 'utf8');
export async function events(item) {
  try {
    const text = await readFile(join(item.directory, 'events.jsonl'), 'utf8');
    // 在运行进程追加时忽略尚未写完的末行，终态核对会读取完整记录。
    return text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
export const started = (item, label) =>
  poll(
    () => events(item),
    (all) => all.some((event) => event.kind === 'started' && event.label === label),
    label,
  ).then((all) => all.find((event) => event.kind === 'started' && event.label === label));
export function exited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}
export async function cleaned(item, label, { cancelled = false, atReturn = false } = {}) {
  const read = async () => {
    const all = await events(item);
    const start = all.find((event) => event.kind === 'started' && event.label === label);
    const done =
      start &&
      all.some((event) => event.kind === 'cleaned' && event.request_id === start.request_id);
    const notified =
      start &&
      all.some(
        (event) => event.kind === 'cancel_received' && event.request_id === start.request_id,
      );
    return { start, done, notified, exited: start ? exited(start.pid) : false };
  };
  const result = atReturn
    ? await read()
    : await poll(read, (value) => value.done && value.exited, `${label} 清理及进程退出`);
  assert.ok(result.done && result.exited, '卸载返回前必须完成自有夹具清理并退出');
  if (cancelled) assert.equal(result.notified, true, '必须真正收到合作取消帧');
  return {
    label,
    pid: result.start.pid,
    request_id: result.start.request_id,
    cleaned: true,
    process_exited: true,
    cancellation_received: result.notified,
  };
}
