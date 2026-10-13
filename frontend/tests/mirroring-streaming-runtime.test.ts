import assert from 'node:assert/strict';
import test from 'node:test';
import { createFrontendRuntime } from '../src/app/index.ts';
import { HostError } from '../src/plugin-sdk/index.ts';
import type { HostContext, JsonValue } from '../src/plugin-sdk/index.ts';
import { deferred, requestUrl, signal, success } from './fixtures.ts';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const operation = 'plugin.mirroring.open';
function definitions() { return { revision: 1, sessions: [{ id: operation, title: '投屏直播', input_schema: { type: 'object' }, execution: { api_version: 1, source: 'declared', total_timeout_ms: 3600000 } }] }; }
function info(status = 'opening', output_sequence = 0) { return { id: sessionId, operation, plugin_id: 'mirroring', generation: 'generation-1', created_at: 1, status, output_sequence,
  ...(status === 'finished' ? { completion: { cleanup: 'complete', process_exited: true } } : {}) }; }
function wire(kind: number, value: unknown, flags = 0): number[] {
  const payload = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(24 + payload.length); bytes.set([68, 70, 77, 76, 1, kind]);
  const view = new DataView(bytes.buffer); view.setUint16(6, flags); view.setUint32(16, payload.length); view.setUint32(20, 1); bytes.set(payload, 24); return Array.from(bytes);
}
const media = [wire(5, { state: 'streaming', attempt: 0 }), wire(1, { codec: 'h264', format: 'annexb', width: 640, height: 480 }),
  wire(2, new Uint8Array([0, 0, 0, 1, 103, 100, 0, 31]), 2), wire(2, new Uint8Array([0, 255, 128, 10]), 1)];
function fixtureTransport(sent: unknown[] = []): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input); const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (url.pathname.endsWith('/session-definitions')) return success(definitions(), 'definitions-log');
    if (url.pathname === '/api/v2/sessions') return success(info(), 'open-log', 202);
    if (url.pathname.endsWith('/output')) {
      const after = Number(url.searchParams.get('after') ?? 0);
      return success({ session: info('running', media.length), next_sequence: media.length,
        chunks: media.slice(after).map((bytes, index) => ({ sequence: after + index + 1, stream: 'stdout', bytes })) }, 'output-log');
    }
    if (url.pathname.endsWith('/input')) { sent.push(body); return success({ id: sessionId, accepted: true }, 'input-log'); }
    if (url.pathname.endsWith('/eof')) return success({ id: sessionId, accepted: true }, 'eof-log');
    if (url.pathname.endsWith('/cancel')) return success(info('stopping', media.length), 'cancel-log');
    if (url.pathname.endsWith(sessionId)) return success(info('running', media.length), 'resume-log');
    throw new Error('未声明请求');
  };
}
function object(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('预期 JSON 对象'); return value;
}
function runtime(transport: typeof fetch = fixtureTransport()) { return createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport }); }
async function service(instance: ReturnType<typeof runtime>, input: JsonValue, active = signal()) {
  const access = instance.host.extensions; assert.ok(access); return access.callService('host.mirroring.stream', '1', input, active);
}

test('runtime公开服务和插件上下文返回本批媒体原字节，计数读取共用游标不重放', async () => {
  const sent: unknown[] = []; const instance = runtime(fixtureTransport(sent)); const access = instance.host.extensions; assert.ok(access);
  assert.ok(access.catalog().services.some((entry) => entry.id === 'host.mirroring.stream' && entry.version === '1'));
  const holder: { context: HostContext | null } = { context: null };
  instance.webPlugins.register({ id: 'mirror-consumer', trusted: true, plugin: { id: 'mirror-consumer', version: '1', apiVersion: 2, panels: [], activate: async (context) => { holder.context = context; } } });
  await instance.webPlugins.load('mirror-consumer'); const plugin = holder.context; assert.ok(plugin); const extensions = plugin.extensions; assert.ok(extensions);
  const available = await extensions.callService('host.mirroring.stream', '1', { action: 'definitions' }, signal()); assert.equal(available.logId, 'definitions-log');
  await service(instance, { action: 'open', input: { device_id: 'emulator-5554' } });
  const result = await extensions.callService('host.mirroring.stream', '1', { action: 'packets', limit: 100 }, signal());
  assert.equal(result.logId, 'output-log'); const batch = object(result.data); assert.equal(batch.cursor, 4); assert.equal(batch.packets, 4);
  assert.ok(Array.isArray(batch.mediaPackets)); const packet = batch.mediaPackets[3]; assert.ok(packet); assert.deepEqual(object(packet).bytes, [0, 255, 128, 10]);
  const counted = await service(instance, { action: 'output' }); assert.equal(object(counted.data).cursor, 4); assert.equal(Object.hasOwn(object(counted.data), 'mediaPackets'), false);
  const empty = await service(instance, { action: 'packets' }); assert.deepEqual(object(empty.data).mediaPackets, []);
  const control = await service(instance, { action: 'control', input: { type: 'text', text: '中文🙂' } }); assert.equal(control.logId, 'input-log');
  const posted = sent[0]; assert.ok(posted !== null && typeof posted === 'object' && 'bytes' in posted && Array.isArray(posted.bytes));
  assert.equal(new TextDecoder().decode(new Uint8Array(posted.bytes)), '{"type":"text","text":"中文🙂","epoch":1}\n');
  await service(instance, { action: 'resume', id: sessionId }); await service(instance, { action: 'eof' }); await service(instance, { action: 'cancel' });
  const snapshot = object((await service(instance, { action: 'snapshot' })).data); assert.equal(object(snapshot.session ?? null).status, 'stopping');
  await instance.webPlugins.unload('mirror-consumer'); await instance.dispose();
});

test('宿主服务拒绝未知动作、媒体替换、额外字段、伪造epoch与超限JSON', async () => {
  const instance = runtime();
  for (const input of [
    { action: 'unknown' }, { action: 'definitions', extra: 'x' }, { action: 'snapshot', sink: {} }, { action: 'open', input: { device_id: '../device' } },
    { action: 'control', input: { type: 'rotate', epoch: 1 } }, { action: 'packets', limit: 101 }, { action: 'resume', id: 'invalid' },
    { action: 'open', input: { device_id: 'a'.repeat(17000) } },
  ]) await assert.rejects(service(instance, input), (error: unknown) => error instanceof HostError && error.kind === 'protocol' && error.logId === null);
  await instance.dispose();
});

test('HTTP日志与结构化错误映射为公开错误，快照保持纯JSON', async () => {
  const instance = runtime(async () => new Response(JSON.stringify({ log_id: 'catalog-error-log', error: { code: 'catalog_unavailable', message: '目录暂不可用' } }), { status: 503, headers: { 'content-type': 'application/json', 'x-deviceforge-log-id': 'catalog-error-log' } }));
  await assert.rejects(service(instance, { action: 'definitions' }), (error: unknown) => error instanceof HostError && error.code === 'catalog_unavailable' && error.logId === 'catalog-error-log');
  const snapshot = object((await service(instance, { action: 'snapshot' })).data); const errors = object(snapshot.errors ?? null); const failed = object(errors.definitions ?? null);
  assert.equal(failed.logId, 'catalog-error-log'); assert.equal(failed.kind, 'http'); await instance.dispose();
});

test('插件卸载撤销服务等待，runtime销毁释放宿主媒体处理器并拒绝旧入口', async () => {
  const delayed = deferred<Response>(); const started = deferred<void>();
  const instance = runtime(async () => { started.resolve(); return delayed.promise; }); const holder: { context: HostContext | null } = { context: null };
  instance.webPlugins.register({ id: 'mirror-consumer', trusted: true, plugin: { id: 'mirror-consumer', version: '1', apiVersion: 2, panels: [], activate: async (context) => { holder.context = context; } } });
  await instance.webPlugins.load('mirror-consumer'); const plugin = holder.context; assert.ok(plugin); const access = plugin.extensions; assert.ok(access);
  const waiting = access.callService('host.mirroring.stream', '1', { action: 'definitions' }, signal()); await started.promise; await instance.webPlugins.unload('mirror-consumer');
  await assert.rejects(waiting, (error: unknown) => error instanceof HostError && error.kind === 'cancelled'); delayed.resolve(success(definitions(), 'late-log'));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(instance.mirroringStreaming.snapshot().definitions, null); await instance.dispose();
  await assert.rejects(service(instance, { action: 'snapshot' }), (error: unknown) => error instanceof HostError && error.code === 'registry_closed');
  let packets = 0; let disposals = 0;
  const owned = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: fixtureTransport(), mirroringSink: { packet: (packet) => { ++packets; if (packet.kind === 'video') packet.bytes.fill(0); }, dispose: () => { ++disposals; } } });
  await service(owned, { action: 'definitions' }); await service(owned, { action: 'open', input: { device_id: 'emulator-5554' } });
  const raw = object((await service(owned, { action: 'packets' })).data); assert.ok(Array.isArray(raw.mediaPackets)); const original = raw.mediaPackets[3]; assert.ok(original); assert.deepEqual(object(original).bytes, [0, 255, 128, 10]);
  assert.equal(packets, 4); await owned.dispose(); await owned.dispose(); assert.equal(disposals, 1);
});

test('媒体处理器清理失败仍收敛注册表与其他runtime资源', async () => {
  const instance = createFrontendRuntime({ baseUrl: 'http://localhost:7031', panelTarget: () => null, transport: fixtureTransport(), mirroringSink: { packet: () => {}, dispose: () => { throw new Error('清理失败'); } } });
  await assert.rejects(instance.dispose(), AggregateError);
  await assert.rejects(service(instance, { action: 'snapshot' }), (error: unknown) => error instanceof HostError && error.code === 'registry_closed');
  assert.throws(() => instance.mirroringStreaming.refreshDefinitions(signal()), (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'cancelled');
});
