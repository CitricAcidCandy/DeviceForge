// 生产前端按本轮读取的原字节提供，业务请求只转发到隔离的真实宿主。
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createBrowserEvidence } from './evidence.mjs';

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

export async function launchProductBridge({ dist, host, market, profile, directory, report, publishUpdate,
  bindAddress = '127.0.0.1', publicAddress = '127.0.0.1' }) {
  const assets = new Map(); report.production_inputs = []; report.product_proxy = [];
  async function capture(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await capture(join(path, entry.name), name);
      else if (entry.isFile() && contentTypes[extname(entry.name)]) {
        const bytes = await readFile(join(path, entry.name));
        assets.set(name, bytes);
        report.production_inputs.push({ path: join(path, entry.name), bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await capture(dist);
  if (!assets.has('/index.html') || !assets.has('/assets/app.js')) throw new Error('生产前端构建不完整');
  let origin;
  const evidence = createBrowserEvidence({ profile, directory, report, origin: () => origin });
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, origin);
    try {
      if (url.pathname.startsWith('/api/')) {
        const entry = { method: incoming.method, path: url.pathname, query: url.search,
          plugin_release: incoming.headers['x-deviceforge-plugin-release'] ?? null };
        report.product_proxy.push(entry);
        const upstream = request(new URL(incoming.url, host.base), { method: incoming.method,
          headers: { ...incoming.headers, host: new URL(host.base).host } }, (response) => {
          entry.status = response.statusCode; entry.log_id = response.headers['x-deviceforge-log-id'] ?? null;
          outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
        });
        upstream.on('error', (error) => { entry.error = error.code ?? 'proxy_failed'; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
        incoming.on('aborted', () => upstream.destroy()); outgoing.on('close', () => upstream.destroy());
        incoming.pipe(upstream); return;
      }
      let value;
      if (url.pathname === '/__smoke/start') {
        await evidence.attach();
        value = { market: market.base, lanHost: report.local_lan?.server_origin ?? null,
          releaseId: 'third_party_feature', serverId: 'third_party_feature_server',
          browserId: 'third_party_feature_browser' };
      } else if (url.pathname === '/__smoke/capture') value = await evidence.screenshot(url.searchParams.get('name'));
      else if (url.pathname === '/__smoke/publish-update' && incoming.method === 'POST') {
        await publishUpdate(); value = { published: true };
      } else if (url.pathname === '/__smoke/stage' && incoming.method === 'POST') {
        report.stage = url.searchParams.get('name'); value = { recorded: true };
      } else if (url.pathname === '/__smoke/scenarios.mjs') {
        outgoing.writeHead(200, { 'content-type': contentTypes['.js'] });
        outgoing.end(await readFile(new URL('./scenarios.mjs', import.meta.url))); return;
      } else if (url.pathname === '/favicon.ico') { outgoing.writeHead(204); outgoing.end(); return; }
      else {
        const path = url.pathname === '/' ? '/index.html' : url.pathname;
        const bytes = assets.get(path);
        outgoing.writeHead(bytes ? 200 : 404, { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
        outgoing.end(bytes ?? '本轮生产前端不存在该资源'); return;
      }
      outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); outgoing.end(JSON.stringify(value));
    } catch (error) {
      report.bridge_errors ??= []; report.bridge_errors.push({ path: url.pathname, message: error.message });
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, bindAddress, done); });
  origin = `http://${publicAddress}:${server.address().port}`; report.product_origin = origin;
  return { origin, async stop() {
    evidence.close(); server.closeAllConnections(); await new Promise((done) => server.close(done));
  } };
}
