import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archive, events, exited } from '../device-provider/fixtures.mjs';
import { poll } from '../device-provider/client.mjs';
import { sha256 } from '../../backend/scripts/online-plugins/fixtures.mjs';

export { events, exited };
export const localId = 'nested-demo-device';
export const pointer = '/input/artifact_id';
export const sourceBytes = Buffer.from('{\r\n  "类型": "synthetic_demo",\r\n  "值": [1, 2, 3]\r\n}\r\n', 'utf8');
export const decoyBytes = Buffer.from('{"用途":"未声明产物，不应复制"}\n', 'utf8');

function schema(strict) {
  return { type: 'object', required: ['device_id', 'input'], additionalProperties: false,
    properties: { device_id: { type: 'string' }, input: { type: 'object',
      required: ['artifact_id', 'label'], additionalProperties: false, properties: {
        artifact_id: strict ? { type: 'string' } : {}, label: { type: 'string', pattern: '^[a-z0-9_-]{1,80}$' },
        mode: { type: 'string', enum: ['normal', 'blocked'] },
        undeclared_artifact_id: { type: 'string' }, hidden_artifact_id: { type: 'string' },
      } } } };
}

function manifest(id, protocol) {
  return { id, version: '1.0.0', protocol_version: protocol, args: [],
    artifacts: { input_pointers: [pointer], outputs: true },
    devices: { api_version: 1, platform: 'synthetic_demo', discover_operation: 'discover', capabilities: [
      { id: 'device.write', version: 1, operation: 'write', scope: 'device', access: 'write' },
      { id: 'device.write_unchecked', version: 1, operation: 'write_unchecked', scope: 'device', access: 'write' },
    ] }, operations: [
      { name: 'discover', title: '发现模拟设备', input_schema: { type: 'object', additionalProperties: false } },
      { name: 'write', title: '嵌套产物写能力', input_schema: schema(true) },
      { name: 'write_unchecked', title: '选择器早期拒绝验证', input_schema: schema(false) },
    ] };
}

export async function fixture(protocol, root) {
  assert.ok([2, 3].includes(protocol));
  const id = `nested_artifacts_v${protocol}`;
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  const source = await readFile(new URL('./provider.mjs', import.meta.url), 'utf8');
  const configuration = { id, protocol, directory, localId,
    source_sha256: sha256(sourceBytes), source_size: sourceBytes.length };
  const makeArchive = (declaration) => archive([
    ['package.json', JSON.stringify({ name: `deviceforge-${declaration.id}`, version: '1.0.0', type: 'module',
      deviceforge: { kind: 'server', manifest: 'plugin.json',
        entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } } } })],
    ['plugin.json', JSON.stringify(declaration)], ['dist/index.mjs', source],
    ['dist/config.mjs', `export default ${JSON.stringify(configuration)};\n`],
  ]);
  const declaration = manifest(id, protocol);
  const badSelectors = [
    ['empty-root', { input_pointers: [''] }],
    ['missing-slash', { input_pointers: ['input/artifact_id'] }],
    ['bad-escape', { input_pointers: ['/input/~2'] }],
    ['duplicate', { input_pointers: [pointer, pointer] }],
    ['equivalent', { input_fields: ['input'], input_pointers: ['/input'] }],
    ['too-many', { input_fields: Array.from({ length: 8 }, (_, index) => `field_${index}`), input_pointers: [pointer] }],
  ];
  return { id, protocol, directory, manifest: declaration, archive: makeArchive(declaration),
    invalid: badSelectors.map(([label, selectors]) => ({ label,
      archive: makeArchive({ ...declaration, id: `${id}_bad_${label.replaceAll('-', '_')}`,
        artifacts: { ...selectors, outputs: true } }) })) };
}

export const operation = (item, name) => `plugin.${item.id}.${name}`;
export const action = (item, input, capability = 'device.write', provider = item.provider) => ({
  provider_id: provider.id, generation: provider.generation, device_id: localId, capability, version: 1, input,
});
export const started = (item, label) => poll(() => events(item),
  (all) => all.some((event) => event.kind === 'started' && event.label === label), `${label} 进程启动`, 10000)
  .then((all) => all.find((event) => event.kind === 'started' && event.label === label));

export async function processEvidence(item, label, { atReturn = false, cooperative = false } = {}) {
  const read = async () => {
    const all = await events(item);
    const start = all.find((event) => event.kind === 'started' && event.label === label);
    const related = start ? all.filter((event) => event.request_id === start.request_id) : [];
    return { start, related, exited: Boolean(start && exited(start.pid)) };
  };
  const evidence = atReturn ? await read() : await poll(read, (value) => value.exited, `${label} 真 PID 退出`, 10000);
  assert.ok(evidence.start && evidence.exited, '自有调用进程必须真实退出');
  if (cooperative) {
    for (const kind of ['cancel_received', 'cleaned', 'response_written', 'stdin_eof', 'process_exit']) {
      assert.ok(evidence.related.some((event) => event.kind === kind), `合作清理必须有 ${kind}`);
    }
  }
  return { provider_id: item.id, protocol: item.protocol, pid: evidence.start.pid, label,
    request_id: evidence.start.request_id, process_exited: evidence.exited, cooperative_confirmed: cooperative,
    events: evidence.related.map(({ kind, at }) => ({ kind, at })) };
}
