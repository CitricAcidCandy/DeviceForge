import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { providerId } from './fixtures.mjs';
import { bounded } from './lifecycle.mjs';

const requestLimit = 8 * 1024 * 1024;
const responseLimit = 8 * 1024 * 1024;
async function bytes(stream, maximum) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > maximum) throw new Error('验收代理字节超限');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const controlJson = (response, value, status = 200) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
};

// 独立 loopback 代理仅保留真实状态、响应头及原字节；不制造业务 DTO。
export async function createBridge({
  base,
  dist,
  fixtures,
  report,
  collectProcessEvidence,
  rawNodeControl,
}) {
  let gate = { phase: 'idle' };
  let held;
  let closing = false;
  const sockets = new Set();
  const active = new Set();
  report.bridge = { requests: [], gates: [], errors: [] };
  const recordGate = () => {
    report.bridge.gates.push({ ...gate, at: new Date().toISOString() });
  };
  const release = () => {
    if (!held) throw new Error('没有待交付的真实响应');
    const pending = held;
    held = undefined;
    gate = { ...gate, phase: 'released' };
    recordGate();
    if (!pending.response.destroyed) {
      pending.response.writeHead(pending.status, pending.headers);
      pending.response.end(pending.body);
    } else report.bridge.gates.push({ phase: 'consumer_disconnected', jobId: gate.jobId });
  };
  async function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (path === '/__verification' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>统一发现行为验收</title><body></body></html>',
      );
      return;
    }
    if (path === '/__harness.mjs' && request.method === 'GET') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await readFile(new URL('./harness.mjs', import.meta.url)));
      return;
    }
    if (path.startsWith('/__fixture/') && request.method === 'GET') {
      const fixture = fixtures.find(
        (item) => path === `/__fixture/${item.fixtureName ?? item.kind}.tgz`,
      );
      if (!fixture) {
        controlJson(response, { error: 'fixture_not_found' }, 404);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store' });
      response.end(fixture.archive);
      return;
    }
    if (path.startsWith('/__control/')) {
      if (path === '/__control/gate/state' && request.method === 'GET') {
        controlJson(response, gate);
        return;
      }
      if (request.method !== 'POST') {
        controlJson(response, { error: 'method_not_allowed' }, 405);
        return;
      }
      const controlBytes = await bytes(request, 4096);
      if (path.startsWith('/__control/raw-node/')) {
        const input = JSON.parse(controlBytes.toString('utf8'));
        controlJson(response, await rawNodeControl.handle(path, input));
        return;
      }
      if (path === '/__control/gate/arm') {
        if (!['idle', 'released'].includes(gate.phase)) throw new Error('上一响应门闩尚未收敛');
        gate = { phase: 'armed' };
        recordGate();
        controlJson(response, gate);
        return;
      }
      if (path === '/__control/gate/release') {
        release();
        controlJson(response, gate);
        return;
      }
      if (path === '/__control/process-evidence') {
        controlJson(response, await collectProcessEvidence(true));
        return;
      }
      controlJson(response, { error: 'control_not_found' }, 404);
      return;
    }
    if (path.startsWith('/assets/') && request.method === 'GET') {
      const file = resolve(dist, `.${decodeURIComponent(path)}`);
      const within = relative(dist, file);
      if (!within || isAbsolute(within) || within.startsWith('..')) throw new Error('静态资源越界');
      const content = await readFile(file);
      const type = extname(file) === '.css' ? 'text/css' : 'text/javascript';
      response.writeHead(200, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'no-store',
      });
      response.end(content);
      return;
    }
    if (!path.startsWith('/api/v2/')) {
      controlJson(response, { error: 'route_not_found' }, 404);
      return;
    }
    const takeGate =
      gate.phase === 'armed' &&
      request.method === 'POST' &&
      path === `/api/v2/device-providers/${providerId}/refresh`;
    if (takeGate) {
      gate = { phase: 'waiting' };
      recordGate();
    }
    const controller = new AbortController();
    active.add(controller);
    const onDisconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', onDisconnect);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          ![
            'host',
            'connection',
            'content-length',
            'transfer-encoding',
            'accept-encoding',
          ].includes(name) &&
          value !== undefined
        ) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }
      headers.set('accept-encoding', 'identity');
      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await bytes(request, requestLimit);
      const upstream = await fetch(`${base}${path}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      });
      if (
        upstream.headers.has('content-encoding') &&
        upstream.headers.get('content-encoding') !== 'identity'
      ) {
        throw new Error('验收代理要求未压缩的真实响应字节');
      }
      const content = await bytes(upstream.body ?? [], responseLimit);
      const outgoing = {};
      upstream.headers.forEach((value, name) => {
        if (
          !['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(name)
        )
          outgoing[name] = value;
      });
      let errorCode;
      if (!upstream.ok && path.startsWith('/api/')) {
        const envelope = JSON.parse(content.toString('utf8'));
        if (envelope.log_id !== upstream.headers.get('x-deviceforge-log-id'))
          throw new Error('失败响应日志ID不一致');
        errorCode = envelope.error?.code;
      }
      report.bridge.requests.push({
        method: request.method,
        path,
        status: upstream.status,
        logId: upstream.headers.get('x-deviceforge-log-id'),
        ...(errorCode ? { errorCode } : {}),
      });
      if (takeGate) {
        const envelope = JSON.parse(content.toString('utf8'));
        if (
          upstream.status !== 200 ||
          envelope.data?.provider?.id !== providerId ||
          !envelope.data.discovery_job_id ||
          !envelope.log_id ||
          envelope.log_id !== upstream.headers.get('x-deviceforge-log-id')
        ) {
          throw new Error('门闩没有取得完整的真实成功发现响应');
        }
        gate = {
          phase: 'held',
          jobId: envelope.data.discovery_job_id,
          generation: envelope.data.provider.generation,
          logId: envelope.log_id,
          status: upstream.status,
        };
        recordGate();
        held = { response, status: upstream.status, headers: outgoing, body: content };
        return;
      }
      if (!response.destroyed) {
        response.writeHead(upstream.status, outgoing);
        response.end(content);
      }
    } catch (error) {
      if (controller.signal.aborted && response.destroyed && !closing) {
        report.bridge.requests.push({ method: request.method, path, client_disconnected: true });
        return;
      }
      throw error;
    } finally {
      active.delete(controller);
      response.off('close', onDisconnect);
    }
  }
  const server = createServer((request, response) => {
    if (closing) {
      response.destroy();
      return;
    }
    handle(request, response).catch((error) => {
      report.bridge.errors.push({
        path: new URL(request.url, 'http://127.0.0.1').pathname,
        message: error.message.slice(0, 300),
      });
      if (!response.destroyed && !response.headersSent)
        controlJson(response, { error: 'verification_bridge_failed' }, 500);
      else response.destroy();
    });
  });
  server.requestTimeout = 40000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      if (closing) return;
      closing = true;
      if (held) {
        held.response.destroy();
        held = undefined;
        recordGate();
      }
      for (const controller of active) controller.abort();
      const closed = new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      for (const socket of sockets) socket.destroy();
      await bounded(closed, 5000, '本次代理关闭超时');
    },
  };
}
