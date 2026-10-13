import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { hash, poll, portReleased, type JsonObject } from './six-business-support.ts';
import { zip } from './ordinary-business-source.ts';

export type CachePackage = {
  module_id: string; feature_key: string; kind: 'runtime' | 'tool'; version: string;
  entry: Buffer; archive: Buffer; checksum: string;
};
export type CacheSourceCall = {
  sequence: number; kind: string; module_id: string | null; mode: string; method: string;
  status: number; input_bytes: number; input_sha256: string; response_bytes: number;
  response_sha256: string; sent_bytes: number; finished: boolean; closed: boolean;
  started_at: string; closed_at: string | null;
};
export type CacheSourceMode = 'live' | 'http' | 'disconnect' | 'json' | 'schema' | 'hold';

export function cachePackage(moduleId: string, featureKey: string, content: string, kind: 'runtime' | 'tool' = 'runtime'): CachePackage {
  const entry = Buffer.from(`合成缓存模块：${moduleId}\n${content}\n`, 'utf8');
  const archive = zip([{ name: 'bundle/entry.txt', bytes: entry }]);
  return { module_id: moduleId, feature_key: featureKey, kind, version: '1.0.0', entry, archive, checksum: hash(archive) };
}

export async function toolCacheSource(root: string) {
  const calls: CacheSourceCall[] = []; const faults: JsonObject[] = []; const inputs: JsonObject[] = [];
  const archives = new Map<string, CachePackage>();
  let base = ''; let bytes = Buffer.from('{}'); let mode: CacheSourceMode = 'live';
  let archiveAvailable = true; let closed = false;
  let held: { call: CacheSourceCall; response: ServerResponse } | undefined;
  const originals = join(root, 'source-originals'); await mkdir(originals, { recursive: true });
  const fault = (error: unknown) => {
    const record = error instanceof Error ? error : new Error('合成来源非标准异常');
    faults.push({ type: record.name, message_sha256: hash(record.message) });
  };
  const archivePath = (item: CachePackage) => `/archives/${item.module_id}-${item.checksum}.zip`;
  const server = createServer((request, response) => {
    const path = request.url ?? ''; const item = archives.get(path); const selectedMode = mode;
    const selectedBytes = bytes; const selectedAvailable = archiveAvailable;
    const call: CacheSourceCall = { sequence: calls.length + 1, kind: path === '/catalog' ? 'catalog' : item ? 'archive' : 'unknown',
      module_id: item?.module_id ?? null, mode: path === '/catalog' ? selectedMode : selectedAvailable ? 'live' : 'http',
      method: request.method ?? '', status: 0, input_bytes: 0, input_sha256: hash(''), response_bytes: 0,
      response_sha256: hash(''), sent_bytes: 0, finished: false, closed: false,
      started_at: new Date().toISOString(), closed_at: null };
    calls.push(call);
    response.once('finish', () => { call.finished = true; });
    response.once('close', () => { call.closed = true; call.closed_at = new Date().toISOString(); });
    response.once('error', fault);
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) {
        const input = Buffer.from(part); call.input_bytes += input.length;
        assert.ok(call.input_bytes <= 1024); parts.push(input);
      }
      call.input_sha256 = hash(Buffer.concat(parts)); assert.equal(request.method, 'GET');
      let output: Buffer; let status = 200;
      if (path === '/catalog') {
        output = selectedMode === 'http' ? Buffer.from('{"error":"synthetic-cache-marker"}')
          : selectedMode === 'json' ? Buffer.from('synthetic-cache-marker:非JSON')
          : selectedMode === 'schema' ? Buffer.from('{"manifestVersion":"","modules":[]}') : selectedBytes;
        if (selectedMode === 'http') status = 503;
      } else if (item) {
        output = selectedAvailable ? item.archive : Buffer.from('synthetic-cache-marker');
        if (!selectedAvailable) status = 503;
      } else { throw new Error('合成缓存来源收到未知路由'); }
      call.status = status; call.response_bytes = output.length; call.response_sha256 = hash(output);
      response.writeHead(status, { 'content-type': path === '/catalog' ? 'application/json' : 'application/zip', 'content-length': output.length });
      if (path === '/catalog' && ['hold', 'disconnect'].includes(selectedMode)) {
        const first = output.subarray(0, Math.min(16, output.length));
        call.sent_bytes = first.length; response.write(first);
        if (selectedMode === 'hold') { held = { call, response }; }
        else { response.flushHeaders(); setImmediate(() => response.destroy()); }
      } else { call.sent_bytes = output.length; response.end(output); }
    })().catch((error) => { fault(error); response.destroy(); });
  });
  server.on('error', fault);
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  return {
    base, calls, faults, inputs,
    async catalog(version: string, modules: CachePackage[]) {
      assert.equal(closed, false); assert.ok(!held || held.call.closed, '不能覆盖在途门闩'); held = undefined;
      for (const item of modules) {
        archives.set(archivePath(item), item);
        const archiveFile = join(originals, `${item.checksum}.zip`); await writeFile(archiveFile, item.archive);
        const entryFile = join(originals, `${hash(item.entry)}.txt`); await writeFile(entryFile, item.entry);
        inputs.push({ kind: 'archive', module_id: item.module_id, version: item.version,
          bytes: item.archive.length, sha256: hash(item.archive), entry_bytes: item.entry.length, entry_sha256: hash(item.entry),
          preserved_archive: relative(root, archiveFile).replaceAll('\\', '/'), preserved_entry: relative(root, entryFile).replaceAll('\\', '/') });
      }
      bytes = Buffer.from(JSON.stringify({ manifestVersion: version, generatedAt: '2026-10-12', modules: modules.map((item) => ({
        name: item.module_id, type: item.kind, featureKey: item.feature_key, version: item.version,
        url: base + archivePath(item), sha256: item.checksum, size: item.archive.length,
        required: false, archiveRoot: 'bundle', entryFile: 'entry.txt',
      })) }));
      mode = 'live'; archiveAvailable = true;
      const manifestFile = join(originals, `${hash(bytes)}.json`); await writeFile(manifestFile, bytes);
      inputs.push({ kind: 'catalog', manifest_version: version, bytes: bytes.length, response_body_sha256: hash(bytes),
        preserved_path: relative(root, manifestFile).replaceAll('\\', '/'),
        modules: modules.map((item) => ({ module_id: item.module_id, sha256: item.checksum })) });
    },
    async localManifest(path: string) {
      assert.equal(closed, false); assert.ok(!held || held.call.closed, '不能在来源响应未收口时复制本地清单');
      await writeFile(path, bytes);
      return { path, bytes: Buffer.from(bytes), sha256: hash(bytes) };
    },
    mode(selected: CacheSourceMode) { assert.equal(closed, false); assert.ok(!held || held.call.closed); held = undefined; mode = selected; },
    archivesAvailable(available: boolean) { archiveAvailable = available; },
    async gate(after: number) {
      const selected = await poll(async () => held, (item) => !!item && item.call.sequence > after, '清单首块响应门闩');
      assert.ok(selected); return selected.call;
    },
    async connectionClosed(sequence: number) {
      return poll(async () => calls.find((call) => call.sequence === sequence), (call) => call?.closed === true, '来源连接释放');
    },
    async settled(after: number) {
      await poll(async () => calls.slice(after).every((call) => call.closed), Boolean, '本项来源响应收口');
    },
    async close() {
      if (!closed) {
        closed = true;
        await new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); server.closeAllConnections(); });
      }
      return { port: address.port, port_released: await portReleased(address.port), fault_count: faults.length,
        open_responses: calls.filter((call) => !call.closed).length };
    },
  };
}

export type ToolCacheSource = Awaited<ReturnType<typeof toolCacheSource>>;
