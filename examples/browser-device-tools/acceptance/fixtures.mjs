import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { npmTgz } from '../../../backend/scripts/online-plugins/fixtures.mjs';
import { fixture, control, started, cleaned, events } from '../../../scripts/unified-discovery/fixtures.mjs';
import { digest } from '../../../scripts/unified-discovery-browser/lifecycle.mjs';

export const browserId = 'browser_device_tools';
export const consumerId = 'browser_device_tools_consumer';

// 只核对已冻结示例，不将新增验收目录混入原十文件摘要。
export async function verifyFrozenInputs() {
  const frozen = JSON.parse(await readFile(new URL('./frozen-inputs.json', import.meta.url), 'utf8'));
  const files = [];
  for (const path of Object.keys(frozen.files).sort()) {
    const actual = await digest(new URL('../' + path, import.meta.url));
    assert.equal(actual.sha256.toUpperCase(), frozen.files[path], '示例冻结输入变化：' + path);
    files.push({ path: 'examples/browser-device-tools/' + path, ...actual });
  }
  const payload = files.map((item) => item.path + '\t' + item.sha256.toUpperCase() + '\n').join('');
  const aggregate = createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
  assert.equal(aggregate, frozen.aggregateSha256);
  return { aggregate, files, supersededArchiveSha256: frozen.supersededArchiveSha256 };
}

export async function createFixtures({ archivePath, archiveSha256, directory, artifacts, runId, report }) {
  const archive = await readFile(archivePath);
  const actual = createHash('sha256').update(archive).digest('hex');
  assert.equal(actual, archiveSha256.toLowerCase(), '主代理正式 TGZ 与指定摘要不一致');
  assert.notEqual(actual.toUpperCase(), report.inputs_before.supersededArchiveSha256, '不得复用未修 EX-01/EX-04 的旧 TGZ');
  await writeFile(join(artifacts, 'browser-device-tools.tgz'), archive, { flag: 'wx' });
  const provider = await fixture('example_provider_' + runId.replace(/-/g, '').slice(0, 12), directory,
    { protocol: 3, devicesApiVersion: 3, platform: 'example_synthetic' });
  await writeFile(join(artifacts, 'provider.tgz'), provider.archive, { flag: 'wx' });
  const descriptor = { name: 'deviceforge-browser-device-tools-consumer', version: '1.0.0', type: 'module',
    deviceforge: { kind: 'browser', manifest: 'plugin.json',
      entrypoints: { any: { runtime: 'browser', path: 'src/index.mjs' } } } };
  const consumer = npmTgz([
    { path: 'package.json', bytes: JSON.stringify(descriptor) },
    { path: 'plugin.json', bytes: JSON.stringify({ id: consumerId, version: '1.0.0', api_version: 2 }) },
    { path: 'src/index.mjs', bytes: await readFile(new URL('./consumer.mjs', import.meta.url)) },
  ]);
  await writeFile(join(artifacts, 'consumer.tgz'), consumer, { flag: 'wx' });
  const packages = [{ id: browserId, kind: 'browser', name: 'example', archive, generator: '主代理标准 npm pack 原包' },
    { id: provider.id, kind: 'server', name: 'provider', archive: provider.archive,
      generator: 'scripts/unified-discovery/fixtures.mjs::fixture(API3/protocol3)' },
    { id: consumerId, kind: 'browser', name: 'consumer', archive: consumer, generator: '本目录公开 SDK 消费者 + 冻结 npmTgz' }];
  report.packages = packages.map(({ archive: bytes, ...item }) => ({ ...item, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') }));
  return { provider, packages, configuration: { browserId, consumerId, providerId: provider.id,
    discoverOperation: provider.discoverOperation, localId: provider.localId, capability: 'device_read', version: 1 } };
}

// 控制目录由管理员夹具创建；浏览器只能传有限场景标签，不能传本机路径或预算。
export function providerControl(item, report) {
  report.provider = { id: item.id, controls: [], cleanups: [], events: [] };
  return async (action, input) => {
    assert.ok(input && typeof input === 'object' && /^[a-z0-9_-]{1,80}$/.test(input.label));
    assert.ok(Object.keys(input).every((key) => ['label', 'hold', 'cancelled'].includes(key)));
    if (action === 'set') {
      const value = await control(item, { label: input.label, mode: input.hold === true ? 'hold' : 'valid',
        waitLimitMs: 15000, state: 'online', rawCase: 'valid', cancelMode: 'complete' });
      report.provider.controls.push({ label: value.label, mode: value.mode }); return { label: value.label };
    }
    if (action === 'started') return started(item, input.label, { timeout: 8000 });
    if (action === 'cleaned') {
      const value = await cleaned(item, input.label, { timeout: 8000, cancelled: input.cancelled === true });
      report.provider.cleanups.push(value); return value;
    }
    throw new Error('未知提供者验收控制');
  };
}

export async function preserveProvider(item, artifacts, report) {
  if (!item) return;
  report.provider ??= { id: item.id, controls: [], cleanups: [], events: [] };
  const records = await events(item);
  report.provider.events = records;
  await writeFile(join(artifacts, 'provider-events.jsonl'), records.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
}
