// 本地合成配置与 ZIP 下载源；不连接外部服务、不记录原始请求头或正文。
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { hash, poll } from './six-business-support.ts';

export function zip(entries: { name: string; bytes: Buffer }[]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.bytes);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const table = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, table, end]);
}

export async function source() {
  let settingsMode: 'ok' | 'failed' | 'hold' = 'ok'; let archiveHold = false;
  let settingsValue: unknown = { label: '合成远端配置' }; let catalog: unknown = {};
  let archive: Buffer = Buffer.alloc(0); let heldSettings: ServerResponse | undefined;
  let heldArchive: ServerResponse | undefined; let remoteClosed = false; let downloadClosed = false;
  const calls: { kind: string; method: string; input_bytes: number; input_sha256: string; sentinel_header: boolean }[] = [];
  const respond = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
  };
  const remoteBody = () => ({ status: 200, data: { success: true, data: settingsValue } });
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []; let length = 0;
      for await (const part of request) { length += part.length; assert.ok(length <= 65536); parts.push(Buffer.from(part)); }
      const bytes = Buffer.concat(parts);
      const kind = request.url === '/get_config/deviceInfo' ? 'remote.load'
        : request.url === '/update_config/deviceInfo' ? 'remote.save'
        : request.url === '/catalog' ? 'catalog' : request.url === '/archive' ? 'archive' : 'unknown';
      calls.push({ kind, method: request.method ?? '', input_bytes: length, input_sha256: hash(bytes),
        sentinel_header: request.headers['x-fixture-key'] === 'synthetic-remote-key' });
      if (kind.startsWith('remote.')) {
        if (settingsMode === 'failed') { respond(response, { success: false }, 503); return; }
        if (kind === 'remote.save') settingsValue = JSON.parse(bytes.toString('utf8'));
        if (settingsMode === 'hold') {
          heldSettings = response; remoteClosed = false; response.on('close', () => { remoteClosed = true; }); return;
        }
        respond(response, remoteBody()); return;
      }
      if (kind === 'catalog') { respond(response, catalog); return; }
      if (kind === 'archive') {
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': archive.length });
        if (archiveHold) {
          heldArchive = response; downloadClosed = false;
          response.on('close', () => { downloadClosed = true; });
          response.write(archive.subarray(0, Math.min(32, archive.length))); return;
        }
        response.end(archive); return;
      }
      respond(response, { error: '未知夹具路由' }, 404);
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base, calls,
    settings(mode: typeof settingsMode, value?: unknown) { settingsMode = mode; heldSettings = undefined; if (value !== undefined) settingsValue = value; },
    releaseSettings() { assert.ok(heldSettings); heldSettings.end(JSON.stringify(remoteBody())); },
    async waitSettings() { await poll(async () => !!heldSettings, Boolean, '远端请求开始'); },
    async settingsClosed() { await poll(async () => remoteClosed, Boolean, '远端取消释放连接'); },
    package(bytes: Buffer, version: string, checksum = hash(bytes), hold = false) {
      archive = bytes; archiveHold = hold; heldArchive = undefined;
      catalog = { manifestVersion: `fixture-${version}`, generatedAt: '2026-10-10', modules: [{
        name: 'fixture-tool', type: 'tool', version, url: `${base}/archive`, sha256: checksum,
        size: bytes.length, required: false, archiveRoot: 'bundle', entryFile: 'entry.txt',
      }] };
    },
    async waitDownload() { await poll(async () => !!heldArchive, Boolean, '下载首块开始'); },
    async downloadClosed() { await poll(async () => downloadClosed, Boolean, '取消后下载连接释放'); },
    async close() { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); },
  };
}
export type Source = Awaited<ReturnType<typeof source>>;
