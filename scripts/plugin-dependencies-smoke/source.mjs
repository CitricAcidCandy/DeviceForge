// 本地 HTTP 源提供真实文件字节；不替换宿主网络适配器或依赖执行器。
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createListener } from 'node:net';
import { pipeline } from 'node:stream/promises';

export async function listenerReleased(port) {
  const server = createListener();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
}

export async function sourceServer(report) {
  const files = new Map(), requests = [];
  const failures = new Set();
  const entry = { pid: process.pid, owner: '本轮驱动内 HTTP 源', requests, started_at: new Date().toISOString() };
  report.source = entry;
  const server = createServer(async (request, response) => {
    const record = { method: request.method, path: request.url, at: new Date().toISOString(), bytes: 0, finished: false };
    requests.push(record);
    const file = files.get(request.url);
    if (failures.has(request.url)) {
      record.status = 503; record.finished = true;
      response.writeHead(503, { 'content-length': '0', 'connection': 'close' }).end(); return;
    }
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      record.status = 404; record.finished = true; response.writeHead(404).end(); return;
    }
    record.status = 200;
    response.writeHead(200, { 'content-length': file.size, 'content-type': 'application/octet-stream', 'connection': 'close' });
    if (request.method === 'HEAD') { response.end(); record.finished = true; return; }
    const stream = createReadStream(file.path);
    stream.on('data', (bytes) => { record.bytes += bytes.length; });
    try { await pipeline(stream, response); record.finished = true; }
    catch (error) { record.error = error.message; response.destroy(); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  entry.port = server.address().port;
  entry.base = `http://127.0.0.1:${entry.port}`;
  let stopped = false;
  return {
    base: entry.base, requests,
    add(path, file) { assert.ok(!files.has(path), '源路径不得重复'); files.set(path, file); },
    fail(path) { failures.add(path); },
    restore(path) { failures.delete(path); },
    snapshot() { return requests.length; },
    async stop() {
      if (stopped) return;
      stopped = true;
      let timer;
      try {
        await Promise.race([
          new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
          new Promise((_, reject) => { timer = setTimeout(() => { server.closeAllConnections(); reject(new Error('下载源关闭超时')); }, 5000); }),
        ]);
      } finally { clearTimeout(timer); server.closeIdleConnections(); }
      await listenerReleased(entry.port);
      entry.closed_at = new Date().toISOString(); entry.listener_released = true;
    },
  };
}
