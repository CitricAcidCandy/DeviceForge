import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createBrowserEvidence } from '../plugin-installations-browser-smoke/evidence.mjs';
import { assertListenerReleased } from '../unified-discovery-smoke/host.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' };

export async function launchRecoveryBridge({ dist, host, profile, directory, report }) {
  const upstreamBase = new URL(host.client.base);
  assert.equal(upstreamBase.hostname, '127.0.0.1');
  assert.ok(!['7031', '5173'].includes(upstreamBase.port));
  const assets = new Map(); report.production_inputs = []; report.product_proxy = [];
  const capture = async (path, prefix = '') => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false, '生产冻结目录不接受符号链接');
      const name = prefix + '/' + item.name;
      if (item.isDirectory()) await capture(join(path, item.name), name);
      else if (item.isFile() && types[extname(item.name)]) {
        const bytes = await readFile(join(path, item.name));
        assets.set(name, bytes);
        report.production_inputs.push({ path: join(path, item.name), bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  };
  await capture(dist);
  assert.ok(assets.has('/index.html') && assets.has('/assets/app.js'), '须提供包含恢复面板的真实生产构建');
  let origin;
  const images = createBrowserEvidence({ profile, directory, report, origin: () => origin });
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, origin);
    try {
      if (url.pathname.startsWith('/api/')) {
        const entry = { method: incoming.method, path: url.pathname, started_at: new Date().toISOString() };
        report.product_proxy.push(entry);
        const upstream = request(new URL(incoming.url, upstreamBase), { method: incoming.method,
          headers: { ...incoming.headers, host: upstreamBase.host } }, (response) => {
          entry.status = response.statusCode;
          entry.log_id = response.headers['x-deviceforge-log-id'] ?? null;
          outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
        });
        upstream.setTimeout(40000, () => upstream.destroy());
        upstream.on('error', () => { entry.proxy_failed = true; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
        incoming.on('aborted', () => upstream.destroy());
        outgoing.on('close', () => upstream.destroy()); incoming.pipe(upstream); return;
      }
      if (url.pathname === '/__recovery/capture') {
        const name = url.searchParams.get('name');
        assert.ok(['01-recovery-risk', '02-recovery-confirmed', '03-recovery-details', '03-recovery-failure'].includes(name));
        const value = await images.screenshot(name);
        outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        outgoing.end(JSON.stringify(value)); return;
      }
      if (url.pathname === '/favicon.ico') { outgoing.writeHead(204); outgoing.end(); return; }
      const path = url.pathname === '/' ? '/index.html' : url.pathname, bytes = assets.get(path);
      outgoing.writeHead(bytes ? 200 : 404, { 'content-type': types[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store' }); outgoing.end(bytes ?? '本轮构建中没有该资源');
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end('本轮产品代理或截图失败');
    }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  assert.ok(![7031, 5173].includes(port)); origin = `http://127.0.0.1:${port}`;
  report.product_origin = origin;
  return { origin, async finish() {
    images.close(); server.closeAllConnections();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    await assertListenerReleased(port); report.bridge_listener = { port, released: true };
  } };
}
