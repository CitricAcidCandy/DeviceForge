import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { bounded } from '../unified-discovery-browser/lifecycle.mjs';

async function body(stream, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error('验收代理请求超限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response, value, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
const modules = new Set(['harness', 'scenarios', 'evidence', 'lifecycle-scenarios']);

export async function createBridge({ base, dist, fixtures, report }) {
  const sockets = new Set();
  const active = new Set();
  let closing = false;
  report.bridge = { requests: [], errors: [], mcp: [] };
  async function proxy(request, response, path, url) {
    if (report.bridge.requests.length >= 500) throw new Error('真实业务请求数量超限');
    const controller = new AbortController();
    active.add(controller);
    const entry = {
      method: request.method,
      path: path + url.search,
      arrived_at: new Date().toISOString(),
    };
    report.bridge.requests.push(entry);
    try {
      const headers = new Headers({ 'accept-encoding': 'identity' });
      for (const name of ['accept', 'content-type', 'authorization'])
        if (typeof request.headers[name] === 'string') headers.set(name, request.headers[name]);
      if (path === '/mcp') headers.set('origin', base);
      const payload = ['GET', 'HEAD'].includes(request.method) ? undefined : await body(request);
      const upstream = await fetch(base + entry.path, {
        method: request.method,
        headers,
        body: payload,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (
        upstream.headers.get('content-encoding') &&
        upstream.headers.get('content-encoding') !== 'identity'
      )
        throw new Error('真实回执不允许压缩替换');
      const bytes = await body(upstream.body ?? []);
      entry.status = upstream.status;
      entry.logId = upstream.headers.get('x-deviceforge-log-id');
      entry.bytes = bytes.length;
      entry.sha256 = createHash('sha256').update(bytes).digest('hex');
      const staticAsset = /^\/api\/v2\/browser-plugins\/[^/]+\/runs\/[^/]+\/assets\//.test(path);
      const artifactContent = /^\/api\/v2\/artifacts\/[^/]+\/content$/.test(path) && upstream.ok;
      if (!staticAsset && !artifactContent && path !== '/mcp') {
        const envelope = JSON.parse(bytes.toString('utf8'));
        if (!envelope.log_id || envelope.log_id !== entry.logId)
          throw new Error('实际HTTP日志包装与头不一致');
        entry.errorCode = envelope.error?.code ?? null;
      }
      const outgoing = {};
      upstream.headers.forEach((value, name) => {
        if (
          !['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(name)
        )
          outgoing[name] = value;
      });
      if (path === '/mcp')
        report.bridge.mcp.push({
          method: request.method,
          status: upstream.status,
          logId: entry.logId,
          bytes: bytes.length,
        });
      response.writeHead(upstream.status, outgoing);
      response.end(bytes);
      entry.delivered = true;
    } finally {
      active.delete(controller);
    }
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    const run = async () => {
      if (request.method === 'GET' && path === '/__verification') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>安卓产物验收</title><body></body></html>',
        );
        return;
      }
      if (request.method === 'GET' && path === '/__config') {
        json(response, {
          runId: report.run_id,
          apkSha256: fixtures.apkSha256,
          pixelSha256: fixtures.pixelSha256,
          pixelBytes: [...fixtures.pixel],
          browserId: 'android_artifacts_browser_probe',
          panelIds: {
            left: 'android_artifacts_browser_probe.left',
            right: 'android_artifacts_browser_probe.right',
          },
        });
        return;
      }
      if (request.method === 'GET' && path === '/__fixture/browser.tgz') {
        response.writeHead(200, { 'content-type': 'application/gzip' });
        response.end(fixtures.browser.archive);
        return;
      }
      if (request.method === 'GET' && path.startsWith('/__modules/')) {
        const name = path.slice('/__modules/'.length).replace(/\.mjs$/, '');
        if (!modules.has(name)) throw new Error('未知验收模块');
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(await readFile(new URL('./' + name + '.mjs', import.meta.url)));
        return;
      }
      if (request.method === 'GET' && path === '/__fixture/apk') {
        response.writeHead(200, { 'content-type': 'application/vnd.android.package-archive' });
        response.end(fixtures.apk);
        return;
      }
      if (request.method === 'GET' && path.startsWith('/assets/')) {
        const file = resolve(dist, '.' + decodeURIComponent(path));
        const within = relative(dist, file);
        if (
          !within ||
          isAbsolute(within) ||
          within === '..' ||
          within.startsWith('../') ||
          within.startsWith('..\\')
        )
          throw new Error('生产资源越界');
        const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[
          extname(file)
        ];
        if (!mime) throw new Error('未知资源类型');
        response.writeHead(200, {
          'content-type': mime + '; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(await readFile(file));
        return;
      }
      if (path === '/mcp' || path.startsWith('/api/v2/')) {
        await proxy(request, response, path, url);
        return;
      }
      json(response, { error: 'not_found' }, 404);
    };
    run().catch((error) => {
      report.bridge.errors.push({ path, message: String(error.message).slice(0, 500) });
      if (!response.destroyed && !response.headersSent)
        json(response, { error: 'verification_bridge_failed' }, 500);
      else response.destroy();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    async close() {
      if (closing) return;
      closing = true;
      for (const controller of active) controller.abort();
      const closed = new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      for (const socket of sockets) socket.destroy();
      await bounded(closed, 5000, '验收代理关闭超时');
    },
  };
}
