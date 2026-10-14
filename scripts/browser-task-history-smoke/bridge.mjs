import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { bounded } from '../unified-discovery-browser/lifecycle.mjs';
import { createGates } from './gates.mjs';

async function bytes(stream, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > limit) throw new Error('验收代理字节超限');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
function json(response, value, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}
const browserModules = new Set([
  'harness',
  'browser-evidence',
  'history-scenarios',
  'cancellation-scenarios',
]);

// 业务路径透明转发真实后端；独立控制路径只负责本次验收的响应门闩。
export async function createBridge({ base, dist, fixtures, report }) {
  const sockets = new Set();
  const active = new Set();
  let closing = false;
  report.bridge = { requests: [], errors: [] };
  const gates = createGates(report.bridge);
  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/__verification') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>任务历史生产浏览器验收</title><body></body></html>',
      );
      return;
    }
    if (request.method === 'GET' && path.startsWith('/__modules/')) {
      const name = path.slice('/__modules/'.length).replace(/\.mjs$/, '');
      if (!browserModules.has(name)) throw new Error('未知浏览器验收模块');
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await readFile(new URL('./' + name + '.mjs', import.meta.url)));
      return;
    }
    if (request.method === 'GET' && path === '/__config') {
      json(response, fixtures.config);
      return;
    }
    if (
      request.method === 'GET' &&
      ['/__fixture/server.tgz', '/__fixture/browser.tgz'].includes(path)
    ) {
      response.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store' });
      response.end(
        path.endsWith('/server.tgz') ? fixtures.server.archive : fixtures.browser.archive,
      );
      return;
    }
    if (request.method === 'POST' && path === '/__control/gates') {
      const input = JSON.parse((await bytes(request, 2048)).toString('utf8'));
      json(response, gates.arm(input.path));
      return;
    }
    const control = /^\/__control\/gates\/(gate-\d+)(\/release)?$/.exec(path);
    if (control && request.method === (control[2] ? 'POST' : 'GET')) {
      json(response, control[2] ? gates.release(control[1]) : gates.status(control[1]));
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
      ) {
        throw new Error('生产资源路径越界');
      }
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[
        extname(file)
      ];
      if (!mime) throw new Error('未知生产资源类型');
      response.writeHead(200, {
        'content-type': mime + '; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await readFile(file));
      return;
    }
    if (!path.startsWith('/api/v2/')) {
      json(response, { error: 'not_found' }, 404);
      return;
    }
    if (report.bridge.requests.length >= 500) throw new Error('本次真实业务请求数量超限');
    const controller = new AbortController();
    active.add(controller);
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', disconnected);
    const entry = {
      method: request.method,
      path: path + url.search,
      arrived_at: new Date().toISOString(),
    };
    report.bridge.requests.push(entry);
    try {
      const headers = new Headers({ 'accept-encoding': 'identity' });
      for (const name of ['accept', 'content-type']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await bytes(request, 8 * 1024 * 1024);
      const upstream = await fetch(base + entry.path, {
        method: request.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (
        upstream.headers.has('content-encoding') &&
        upstream.headers.get('content-encoding') !== 'identity'
      ) {
        throw new Error('真实回执不允许压缩替换');
      }
      const content = await bytes(upstream.body ?? [], 8 * 1024 * 1024);
      const outgoing = {};
      upstream.headers.forEach((value, name) => {
        if (
          !['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(name)
        )
          outgoing[name] = value;
      });
      Object.assign(entry, {
        status: upstream.status,
        logId: upstream.headers.get('x-deviceforge-log-id'),
        response_bytes: content.length,
        response_sha256: createHash('sha256').update(content).digest('hex'),
      });
      const staticAsset = /^\/api\/v2\/browser-plugins\/[^/]+\/runs\/[^/]+\/assets\//.test(path);
      if (!staticAsset) {
        const envelope = JSON.parse(content.toString('utf8'));
        if (
          typeof envelope.log_id !== 'string' ||
          !envelope.log_id ||
          envelope.log_id !== entry.logId
        ) {
          throw new Error('真实HTTP包装与响应头日志ID不一致');
        }
        if (!upstream.ok) entry.errorCode = envelope.error?.code ?? null;
      }
      const gateId = request.headers['x-deviceforge-verification-gate'];
      const mark =
        typeof gateId === 'string' ? await gates.hold(gateId, entry.path, entry, response) : null;
      if (!response.destroyed) {
        response.writeHead(upstream.status, outgoing);
        response.end(content);
        mark?.();
      }
      entry.delivered = !response.destroyed;
    } catch (error) {
      if (controller.signal.aborted && response.destroyed) {
        entry.clientDisconnected = true;
        return;
      }
      throw error;
    } finally {
      active.delete(controller);
      response.off('close', disconnected);
    }
  };
  const server = createServer((request, response) => {
    if (closing) {
      response.destroy();
      return;
    }
    handle(request, response).catch((error) => {
      report.bridge.errors.push({
        path: new URL(request.url, 'http://127.0.0.1').pathname,
        message: String(error.message).slice(0, 600),
      });
      if (!response.destroyed && !response.headersSent)
        json(response, { error: 'verification_bridge_failed' }, 500);
      else response.destroy();
    });
  });
  server.requestTimeout = 20000;
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
      gates.close();
      for (const controller of active) controller.abort();
      const closed = new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      for (const socket of sockets) socket.destroy();
      await bounded(closed, 5000, '本次任务历史代理关闭超时');
    },
  };
}
