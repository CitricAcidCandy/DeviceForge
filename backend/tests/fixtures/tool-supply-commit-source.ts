// 本批自行定义合成 ZIP/HTTP 源；固定两版文本，不复用或修改普通业务来源。
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { hash, poll, portReleased } from './six-business-support.ts';

export const moduleId = 'commit-fixture';
export const entries = [Buffer.from('合成提交恢复包第一版\n'), Buffer.from('合成提交恢复包第二版\n')];
function archive(entry: Buffer): Buffer {
  const name = Buffer.from('bundle/entry.txt'); let crc = 0xffffffff;
  for (const byte of entry) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.length, 18);
  local.writeUInt32LE(entry.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(entry.length, 20); central.writeUInt32LE(entry.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + entry.length, 16);
  return Buffer.concat([local, name, entry, central, name, end]);
}
export const packages = entries.map(archive);
export async function commitSource() {
  let selected = 0; let hold = false; let held: ServerResponse | undefined; let sequence = 0;
  const faults: string[] = [];
  const events: { sequence: number; event: string; at: string; generation: number }[] = [];
  const calls: { sequence: number; kind: string; generation: number; ordinal: number; bytes: number; sha256: string; closed: boolean }[] = [];
  const event = (name: string, generation = selected) => events.push({ sequence: ++sequence, event: name, at: new Date().toISOString(), generation });
  const server = createServer((request, response) => {
    const generation = selected; const bytes = packages[generation];
    if (request.method !== 'GET' || (request.url !== '/catalog' && request.url !== '/archive')) {
      faults.push('未知请求'); response.writeHead(404); response.end(); return;
    }
    const kind = request.url.slice(1); const call = { sequence: ++sequence, kind, generation,
      ordinal: calls.filter((item) => item.kind === kind && item.generation === generation).length + 1,
      bytes: 0, sha256: '', closed: false };
    calls.push(call); response.once('close', () => { call.closed = true; event(`${kind}.closed`, generation); });
    if (kind === 'catalog') {
      const body = Buffer.from(JSON.stringify({ manifestVersion: `commit-fixture-${generation + 1}`, generatedAt: '2026-10-10',
        modules: [{ name: moduleId, type: 'tool', version: `${generation + 1}.0.0`, url: `${base}/archive`,
          sha256: hash(bytes), size: bytes.length, required: false, archiveRoot: 'bundle', entryFile: 'entry.txt' }] }));
      call.bytes = body.length; call.sha256 = hash(body);
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length }); response.end(body); return;
    }
    call.bytes = bytes.length; call.sha256 = hash(bytes);
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length });
    if (hold) {
      if (held) { faults.push('重复暂停下载'); response.destroy(); return; }
      held = response; response.write(bytes.subarray(0, 32)); event('download.gate', generation); return;
    }
    response.end(bytes); event('download.complete', generation);
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  return {
    base, calls, events, faults,
    select(generation: 0 | 1, paused = false) { assert.ok(!held); selected = generation; hold = paused; },
    async waitGate() { await poll(async () => !!held, Boolean, '本轮升级下载首块门闩'); },
    release() { assert.ok(held && !held.destroyed); event('download.release'); held.end(packages[selected].subarray(32)); held = undefined; hold = false; },
    async closed() { await poll(async () => calls.filter((call) => call.kind === 'archive').every((call) => call.closed), Boolean, '下载响应释放'); },
    async close() {
      server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
      return { port_released: await portReleased(address.port), faults: faults.length };
    },
  };
}
export type CommitSource = Awaited<ReturnType<typeof commitSource>>;
