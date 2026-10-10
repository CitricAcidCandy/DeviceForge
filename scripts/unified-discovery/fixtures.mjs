import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { archive as providerArchive } from '../device-provider/fixtures.mjs';

export const localId = 'same-local-device';
export const otherId = 'other-local-device';
export const capabilities = Object.freeze([
  Object.freeze({ id: 'device_read', version: 1, operation: 'device_read', scope: 'device', access: 'read' }),
  Object.freeze({ id: 'device_write', version: 1, operation: 'device_write', scope: 'device', access: 'write' }),
]);

// undefined 表示不写 raw_state 字段；null 表示显式 JSON null，不能混为一种输入。
export const rawCases = Object.freeze({
  valid: ' Vendor.Recovery 模式 ',
  recovery: 'recovery',
  sideload: 'sideload',
  bootloader: 'bootloader',
  unknown: 'vendor-mode-that-host-does-not-know',
  missing: undefined,
  null: null,
  empty: '',
  whitespace: ' \u3000',
  'unicode-control': 'raw\u0085state',
  'ascii-control': 'raw\nstate',
  'ascii-100': 'x'.repeat(100),
  'ascii-101': 'x'.repeat(101),
  'utf8-100': `${'界'.repeat(33)}a`,
  'utf8-101': `${'界'.repeat(33)}ab`,
  number: 7,
  boolean: true,
  array: Object.freeze([]),
  object: Object.freeze({}),
});

const labelPattern = /^[a-z0-9_-]{1,80}$/;
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const modes = new Set(['valid', 'hold', 'empty', 'duplicate', 'bad-state', 'undeclared-capability', 'mixed-bad-raw']);
const resultModes = new Set(['array', 'pseudo-wrapper', 'pseudo-wrapper-extra', 'object']);
const cancelModes = new Set(['complete', 'failed', 'ignore']);

function directory(item) {
  assert.ok(item && isAbsolute(item.controlDirectory), '夹具控制目录必须是管理员生成的绝对路径');
  return item.controlDirectory;
}

function label(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, labelPattern, '场景标签只能使用有限简单名称');
  return value;
}

function milliseconds(value, fallback, maximum) {
  const result = value ?? fallback;
  assert.ok(Number.isSafeInteger(result) && result >= 0 && result <= maximum, '夹具时间必须有界');
  return result;
}

// 复用既有有限 TAR 构造器；归档解析、安装、来源判断均由真实宿主完成。
export const archive = providerArchive;

export async function fixture(id, root, { protocol = 3, devicesApiVersion = 3, platform = 'android', executionTimeoutMs } = {}) {
  assert.match(id, idPattern, '夹具 ID 只能使用有限简单名称');
  assert.ok([1, 2, 3].includes(protocol), '任务协议只支持 1/2/3');
  assert.ok([1, 2, 3].includes(devicesApiVersion), '设备声明只支持 API 1/2/3');
  assert.equal(typeof platform, 'string');
  assert.ok(platform.trim() && Buffer.byteLength(platform, 'utf8') <= 100 && !/\p{Cc}/u.test(platform));
  const controlDirectory = resolve(root, id);
  // 每个归档保留独立控制目录，不覆盖另一个运行批次的事件证据。
  await mkdir(resolve(root), { recursive: true });
  await mkdir(controlDirectory);
  const manifest = { id, version: '1.0.0', protocol_version: protocol, args: [],
    devices: { api_version: devicesApiVersion, platform, discover_operation: 'discover',
      capabilities: capabilities.map((capability) => ({ ...capability,
        ...(executionTimeoutMs !== undefined ? { execution_timeout_ms: executionTimeoutMs } : {}) })) },
    operations: [
      { name: 'discover', title: '统一发现模拟设备', input_schema: { type: 'object', additionalProperties: false } },
      ...capabilities.map((capability) => ({ name: capability.operation, title: `模拟能力 ${capability.id}`,
        input_schema: { type: 'object', required: ['device_id', 'input'], additionalProperties: false,
          properties: { device_id: { type: 'string' }, input: { type: 'object' } } } })),
    ] };
  const descriptor = { name: `deviceforge-unified-discovery-${id}`, version: '1.0.0', type: 'module',
    deviceforge: { kind: 'server', manifest: 'plugin.json', entrypoints: { any: { runtime: 'node', path: 'dist/index.mjs' } } } };
  const config = { id, protocol, devicesApiVersion, platform, directory: controlDirectory, localId, otherId };
  const source = await readFile(new URL('./node-provider.mjs', import.meta.url), 'utf8');
  const packageFor = (value) => archive([
    ['package.json', JSON.stringify(descriptor)], ['plugin.json', JSON.stringify(value)],
    ['dist/index.mjs', source], ['dist/fixture.json', JSON.stringify(config)],
  ]);
  const invalid = (change) => {
    const value = structuredClone(manifest);
    change(value);
    return packageFor(value);
  };
  const tgz = packageFor(manifest);
  const item = { id, protocol, devicesApiVersion, platform,
    discoverOperation: `plugin.${id}.discover`, manifest, tgz, archive: tgz,
    sha256: createHash('sha256').update(tgz).digest('hex'),
    controlDirectory, directory: controlDirectory, localId, otherId,
    invalidArchives: {
      schemaNonObject: invalid((value) => { value.operations[0].input_schema = { type: 'array' }; }),
      schemaRejectsEmpty: invalid((value) => { value.operations[0].input_schema = { type: 'object', required: ['forbidden'] }; }),
      missingDiscovery: invalid((value) => { value.devices.discover_operation = 'not_declared'; }),
      unsupportedDeviceApi: invalid((value) => { value.devices.api_version = 4; }),
      budgetZero: invalid((value) => { value.devices.api_version = 3; value.devices.capabilities[0].execution_timeout_ms = 0; }),
      budgetOverflow: invalid((value) => { value.devices.api_version = 3; value.devices.capabilities[0].execution_timeout_ms = 120001; }),
      legacyBudget: invalid((value) => { value.devices.api_version = 1; value.devices.capabilities[0].execution_timeout_ms = 1; }),
    } };
  await control(item, { label: 'initial', rawCase: devicesApiVersion === 3 ? 'valid' : 'missing' });
  return item;
}

export const operation = (item, name = 'discover') => `plugin.${item.id}.${name}`;

export async function control(item, options) {
  const allowed = new Set(['label', 'mode', 'rawCase', 'rawState', 'resultMode', 'cancelMode', 'state', 'model',
    'durationMs', 'waitLimitMs', 'cleanupDelayMs', 'eofTimeoutMs', 'exitCode']);
  assert.ok(options && typeof options === 'object' && !Array.isArray(options));
  assert.ok(Object.keys(options).every((key) => allowed.has(key)), '管理员控制字段不得拼错');
  const snapshot = { label: label(options.label), mode: options.mode ?? 'valid',
    rawCase: options.rawCase ?? (item.devicesApiVersion === 3 ? 'valid' : 'missing'),
    resultMode: options.resultMode ?? 'array', cancelMode: options.cancelMode ?? 'complete',
    state: options.state ?? 'online', durationMs: milliseconds(options.durationMs, 25, 35000),
    waitLimitMs: milliseconds(options.waitLimitMs, 12000, 35000),
    cleanupDelayMs: milliseconds(options.cleanupDelayMs, 40, 500),
    eofTimeoutMs: milliseconds(options.eofTimeoutMs, 6000, 10000), exitCode: options.exitCode ?? 0 };
  assert.ok(modes.has(snapshot.mode) && resultModes.has(snapshot.resultMode) && cancelModes.has(snapshot.cancelMode));
  assert.ok(Object.hasOwn(rawCases, snapshot.rawCase), '未知原文场景名称');
  assert.ok(['online', 'offline', 'unauthorized', 'unknown'].includes(snapshot.state));
  assert.ok(Number.isSafeInteger(snapshot.exitCode) && snapshot.exitCode >= 0 && snapshot.exitCode <= 125);
  if (Object.hasOwn(options, 'rawState')) {
    assert.notEqual(options.rawState, undefined, '要省略原文字段请使用 rawCase=missing');
    assert.ok(Buffer.byteLength(JSON.stringify(options.rawState), 'utf8') <= 4096, '自定义坏原文仍需有界');
    snapshot.rawState = options.rawState;
  } else if (snapshot.rawCase !== 'missing') {
    snapshot.rawState = rawCases[snapshot.rawCase];
  }
  if (Object.hasOwn(options, 'model')) {
    assert.ok(options.model === null || (typeof options.model === 'string' && Buffer.byteLength(options.model, 'utf8') <= 200));
    snapshot.model = options.model;
  }
  const path = join(directory(item), `control-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' });
  await rename(path, join(directory(item), 'control.json'));
  return snapshot;
}

export const release = (item, value) => writeFile(join(directory(item), `${label(value)}.release`), '已解除本次发现门闩', 'utf8');

export async function events(item) {
  const path = join(directory(item), 'events.jsonl');
  try {
    assert.ok((await stat(path)).size <= 2 * 1024 * 1024, '夹具事件文件必须有界');
    const bytes = await readFile(path);
    assert.ok(bytes.length <= 2 * 1024 * 1024, '夹具事件文件必须有界');
    const text = bytes.toString('utf8');
    // 真实进程追加时忽略未写完的末行；完整坏行仍直接失败，不能吞掉伪证据。
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function started(item, value, { timeout = 12000 } = {}) {
  const name = label(value);
  const all = await poll(() => events(item),
    (records) => records.some((record) => record.kind === 'started' && record.label === name), name, timeout);
  const matches = all.filter((record) => record.kind === 'started' && record.label === name);
  assert.equal(matches.length, 1, '每个场景标签只允许一次真实发现执行');
  return matches[0];
}

export async function event(item, value, kind, { timeout = 12000 } = {}) {
  const name = label(value);
  const all = await poll(() => events(item),
    (records) => records.some((record) => record.kind === kind && record.label === name), `${name} ${kind}`, timeout);
  return all.find((record) => record.kind === kind && record.label === name);
}

// 信号 0 只检查同一个已记录 PID 是否仍存在，不结束夹具或其它进程。
export function exited(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}

export async function cleaned(item, value, { cancelled = false, eof = true, atReturn = false, timeout = 12000, exitCode = 0 } = {}) {
  const name = label(value);
  const read = async () => {
    const all = await events(item);
    const starts = all.filter((record) => record.kind === 'started' && record.label === name);
    assert.ok(starts.length <= 1, '一次场景不得执行多个真实进程');
    const start = starts[0];
    const records = start ? all.filter((record) => record.request_id === start.request_id && record.pid === start.pid) : [];
    const has = (kind) => records.some((record) => record.kind === kind);
    const exit = records.find((record) => record.kind === 'process_exit');
    return { start, done: has('cleaned'), response: has('response_written'), eof: has('stdin_eof'),
      notified: has('cancel_received'), exit, exited: start ? exited(start.pid) : false };
  };
  const complete = (result) => result.done && result.response && result.exit && result.exited && (!eof || result.eof);
  const result = atReturn ? await read() : await poll(read, complete, `${name} 真实清理、EOF与退出`, timeout);
  assert.ok(complete(result), '成功返回必须具有清理标记、响应、真实退出事件及不存在的 PID');
  assert.equal(result.exit.exit_code, exitCode, '真实退出码必须符合场景要求');
  if (cancelled) assert.equal(result.notified, true, '协议 3 必须实际收到匹配取消控制帧');
  return { label: name, pid: result.start.pid, request_id: result.start.request_id,
    protocol: item.protocol, cleaned: true, response_written: result.response, stdin_eof: result.eof,
    exit_event: true, exit_code: result.exit.exit_code, process_exited: true, cancellation_received: result.notified };
}
