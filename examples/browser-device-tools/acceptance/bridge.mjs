import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { bounded } from '../../../scripts/unified-discovery-browser/lifecycle.mjs';

async function bytes(stream, maximum) {
  const parts = []; let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk); size += part.length;
    if (size > maximum) throw new Error('验收桥字节超限');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
};

// 页面真实使用本机 LAN IPv4；只接受该主机自身连接，控制桥不用于同事客户端或产品功能。
export async function createBridge({ base, lanHost, dist, fixtures, configuration, control, report }) {
  const sockets = new Set(); const active = new Set();
  let closing = false; let gate = { phase: 'idle' }; let held;
  report.bridge = { requests: [], gates: [], errors: [] };
  const mark = () => report.bridge.gates.push({ ...gate, at: new Date().toISOString() });
  async function handle(request, response) {
    if (request.socket.remoteAddress !== lanHost) { json(response, { error: 'local_acceptance_only' }, 403); return; }
    const url = new URL(request.url, 'http://' + lanHost); const path = url.pathname;
    if (path === '/__verification' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>第三方浏览器插件验收</title><body></body></html>'); return;
    }
    if (path === '/__configuration' && request.method === 'GET') { json(response, configuration); return; }
    const modules = new Set(['harness.mjs', 'browser-checks.mjs', 'probe-context.mjs']);
    if (path.startsWith('/__acceptance/') && request.method === 'GET') {
      const name = path.slice('/__acceptance/'.length);
      if (!modules.has(name)) { json(response, { error: 'module_not_found' }, 404); return; }
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(new URL('./' + name, import.meta.url))); return;
    }
    if (path.startsWith('/__fixture/') && request.method === 'GET') {
      const fixture = fixtures.find((item) => path === '/__fixture/' + item.name + '.tgz');
      if (!fixture) { json(response, { error: 'fixture_not_found' }, 404); return; }
      response.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store' });
      response.end(fixture.archive); return;
    }
    if (path.startsWith('/__control/')) {
      if (path === '/__control/stats' && request.method === 'GET') { json(response, report.bridge.requests); return; }
      if (path === '/__control/gate/state' && request.method === 'GET') { json(response, gate); return; }
      if (request.method !== 'POST') { json(response, { error: 'method_not_allowed' }, 405); return; }
      const input = JSON.parse((await bytes(request, 4096)).toString('utf8'));
      const providerAction = path.match(/^\/__control\/provider\/(set|started|cleaned)$/);
      if (providerAction) { json(response, await control(providerAction[1], input)); return; }
      if (path === '/__control/gate/arm') {
        if (!['idle', 'released'].includes(gate.phase)) throw new Error('前一响应门闩尚未释放');
        if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.jobId)) throw new Error('门闩只接受实际 Job ID');
        gate = { phase: 'armed', path: '/api/v2/jobs/' + input.jobId }; mark(); json(response, gate); return;
      }
      if (path === '/__control/gate/release') {
        if (!held) throw new Error('没有已取得的真实响应可交付');
        const pending = held; held = undefined;
        gate = { ...gate, phase: 'released', consumerDisconnected: pending.response.destroyed }; mark();
        if (!pending.response.destroyed) { pending.response.writeHead(pending.status, pending.headers); pending.response.end(pending.body); }
        json(response, gate); return;
      }
      json(response, { error: 'control_not_found' }, 404); return;
    }
    if (path.startsWith('/assets/') && request.method === 'GET') {
      const file = resolve(dist, '.' + decodeURIComponent(path)); const within = relative(dist, file);
      if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + '/') || within.startsWith('..' + '\\')) throw new Error('生产资源越界');
      const type = extname(file) === '.css' ? 'text/css' : 'text/javascript';
      response.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(file)); return;
    }
    if (!path.startsWith('/api/v2/')) { json(response, { error: 'route_not_found' }, 404); return; }
    const takeGate = gate.phase === 'armed' && request.method === 'GET' && path === gate.path;
    if (takeGate) { gate = { ...gate, phase: 'waiting' }; mark(); }
    const controller = new AbortController(); active.add(controller);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnected);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(name)) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      headers.set('accept-encoding', 'identity');
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await bytes(request, 12 * 1024 * 1024);
      const upstream = await fetch(base + path + url.search, { method: request.method, headers, body, redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]) });
      if (upstream.headers.has('content-encoding') && upstream.headers.get('content-encoding') !== 'identity') throw new Error('验收桥只转发未压缩原响应');
      const content = await bytes(upstream.body ?? [], 12 * 1024 * 1024);
      const outgoing = {};
      upstream.headers.forEach((value, name) => {
        if (!['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(name)) outgoing[name] = value;
      });
      const entry = { method: request.method, path, status: upstream.status,
        logId: upstream.headers.get('x-deviceforge-log-id'), bytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex') };
      if (entry.logId && upstream.headers.get('content-type')?.includes('application/json')) {
        const envelope = JSON.parse(content.toString('utf8'));
        if (envelope.log_id !== entry.logId) throw new Error('真实 HTTP 包装与日志头不一致');
        if (!upstream.ok) entry.errorCode = envelope.error?.code ?? null;
      }
      if (report.bridge.requests.length >= 800) throw new Error('验收请求记录超限');
      report.bridge.requests.push(entry);
      if (takeGate) {
        if (upstream.status !== 200 || !entry.logId) throw new Error('门闩没有取得真实 Job 成功响应');
        gate = { ...gate, phase: 'held', logId: entry.logId, sha256: entry.sha256 }; mark();
        held = { response, status: upstream.status, headers: outgoing, body: content }; return;
      }
      if (!response.destroyed) { response.writeHead(upstream.status, outgoing); response.end(content); }
    } catch (error) {
      if (controller.signal.aborted && response.destroyed && !closing) {
        report.bridge.requests.push({ method: request.method, path, consumerDisconnected: true }); return;
      }
      throw error;
    } finally { active.delete(controller); response.off('close', disconnected); }
  }
  const server = createServer((request, response) => {
    if (closing) { response.destroy(); return; }
    handle(request, response).catch((error) => {
      report.bridge.errors.push({ path: new URL(request.url, 'http://' + lanHost).pathname, message: error.message.slice(0, 500) });
      if (!response.destroyed && !response.headersSent) json(response, { error: 'acceptance_bridge_failed' }, 500);
      else response.destroy();
    });
  });
  server.requestTimeout = 40000;
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, lanHost, done); });
  return { origin: 'http://' + lanHost + ':' + server.address().port, async close() {
    if (closing) return; closing = true;
    if (held) { held.response.destroy(); held = undefined; }
    for (const controller of active) controller.abort();
    const closed = new Promise((done, failed) => server.close((error) => error ? failed(error) : done()));
    for (const socket of sockets) socket.destroy();
    await bounded(closed, 5000, '验收桥关闭超时');
  } };
}
