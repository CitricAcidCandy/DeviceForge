// 透明转发真实市场；故障只存在于本次独占验收网关，原生产请求正文保持不变。
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { publicFixtures } from './fixtures.mjs';
import { ownedBrowserProcesses } from './verification.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
  'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
const modes = new Set(['normal', 'legacy', 'resource-error', 'cancel']);
const parse = (bytes) => { try { return JSON.parse(bytes); } catch { return undefined; } };

async function body(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('本次小型验收夹具请求超过2MiB边界');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response, status, value) {
  response.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function launchPublicationGateway({ market, fixtures, report }) {
  let mode = 'normal', phase = 'initial';
  const ledger = [];
  const streams = new Set();
  const held = new Set();
  report.publication_requests = ledger;
  report.publication_injections = [];
  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    if (incoming.method === 'OPTIONS') {
      outgoing.writeHead(204, cors); outgoing.end(); return;
    }
    try {
      if (url.pathname === '/__publication/config') {
        report.owned_browser_processes ??= await ownedBrowserProcesses(report.browser_profile_directory);
        json(outgoing, 200, { fixtures: publicFixtures(fixtures) }); return;
      }
      if (url.pathname === '/__publication/control' && incoming.method === 'POST') {
        const next = parse(await body(incoming));
        if (!modes.has(next?.mode) || typeof next.phase !== 'string' || next.phase.length > 80)
          throw new Error('故障控制参数无效');
        mode = next.mode; phase = next.phase;
        report.publication_injections.push({ at: new Date().toISOString(), mode, phase });
        json(outgoing, 200, { mode, phase }); return;
      }
      if (url.pathname === '/__publication/snapshot') {
        json(outgoing, 200, { mode, phase, requests: ledger }); return;
      }
      const fixture = /^\/__publication\/fixtures\/(first|shared|conflict)$/.exec(url.pathname);
      if (fixture && incoming.method === 'GET') {
        const bytes = await readFile(fixtures[fixture[1]].archive);
        outgoing.writeHead(200, { ...cors, 'content-type': 'application/zip', 'content-length': bytes.length });
        outgoing.end(bytes); return;
      }
      const module = /^\/__publication\/(scenarios|controls)\.mjs$/.exec(url.pathname);
      if (module && incoming.method === 'GET') {
        outgoing.writeHead(200, { ...cors, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        outgoing.end(await readFile(new URL(`./${module[1]}.mjs`, import.meta.url))); return;
      }
      if (!url.pathname.startsWith('/api/v1/')) { json(outgoing, 404, { error: { message: '本轮网关无此路由' } }); return; }
      const entry = { sequence: ledger.length + 1, at: new Date().toISOString(), mode, phase,
        method: incoming.method, path: url.pathname, query: url.search };
      ledger.push(entry);
      outgoing.once('close', () => {
        if (!outgoing.writableFinished) entry.client_aborted = true;
        if (entry.held) { entry.finished_at = new Date().toISOString(); held.delete(outgoing); }
      });
      if (mode === 'legacy' && incoming.method === 'GET' && url.pathname === '/api/v1/capabilities') {
        entry.injected = 'legacy-capabilities-404'; entry.status = 404; entry.finished_at = new Date().toISOString();
        json(outgoing, 404, { error: { message: '受控旧市场没有完整功能发布能力接口' } }); return;
      }
      const bytes = await body(incoming);
      if (bytes.length) {
        entry.body_bytes = bytes.length; entry.body_sha256 = sha(bytes);
        const value = parse(bytes);
        if (value !== undefined) entry.json_body = value;
      }
      if (url.pathname === '/api/v1/resources' && incoming.method === 'POST') {
        entry.filename = incoming.headers['x-resource-filename'] ?? null;
        entry.kind = incoming.headers['x-resource-kind'] ?? null;
        if (mode === 'resource-error') {
          entry.injected = 'resource-post-503'; entry.status = 503; entry.finished_at = new Date().toISOString();
          json(outgoing, 503, { error: { message: '受控资源上传失败，请重试发布' } }); return;
        }
        if (mode === 'cancel') {
          entry.injected = 'hold-resource-post-until-client-abort'; entry.held = true; held.add(outgoing); return;
        }
      }
      await forward(incoming, outgoing, bytes, entry);
    } catch (error) {
      report.publication_gateway_errors ??= [];
      report.publication_gateway_errors.push({ path: url.pathname, message: error.message });
      if (!outgoing.headersSent) json(outgoing, 502, { error: { message: error.message } });
      else outgoing.end();
    }
  });

  async function forward(incoming, outgoing, bytes, entry) {
    await new Promise((done, fail) => {
      const target = new URL(incoming.url, market.base);
      const upstream = request(target, { method: incoming.method,
        headers: { ...incoming.headers, host: target.host } }, async (response) => {
        try {
          const received = await body(response);
          entry.status = response.statusCode;
          entry.response_headers = { etag: response.headers.etag ?? null,
            content_length: response.headers['content-length'] ?? null };
          entry.finished_at = new Date().toISOString();
          const value = parse(received);
          if (value !== undefined) entry.json_response = value;
          outgoing.writeHead(response.statusCode, { ...response.headers, ...cors });
          outgoing.end(received); done();
        } catch (error) { fail(error); }
      });
      streams.add(upstream);
      upstream.setTimeout(15000, () => upstream.destroy(new Error('真实市场转发十五秒内未完成')));
      upstream.once('close', () => streams.delete(upstream));
      upstream.once('error', (error) => {
        if (outgoing.destroyed) { entry.upstream_closed_after_abort = true; done(); }
        else fail(error);
      });
      outgoing.once('close', () => upstream.destroy());
      incoming.once('aborted', () => upstream.destroy());
      upstream.end(bytes);
    });
  }
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const base = `http://127.0.0.1:${server.address().port}`;
  report.publication_gateway = { base, scope: '独占市场透明转发及显式故障注入，不修改生产服务' };
  return { base, ledger, async stop() {
    for (const response of held) response.destroy();
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  } };
}
