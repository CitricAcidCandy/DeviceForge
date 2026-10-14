import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { bounded } from '../unified-discovery-browser/lifecycle.mjs';

async function bytes(stream, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of stream) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > limit) throw new Error('本次代理字节超限');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const json = (response, value, status = 200) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
};

// 代理只转发真实业务响应；控制端点属于独立验收页，不进入生产API。
export async function createBridge({
  base,
  dist,
  fixtures,
  browserFixture,
  report,
  verifyDefault,
}) {
  const sockets = new Set();
  const active = new Set();
  let closing = false;
  report.bridge = { requests: [], errors: [] };
  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/__verification') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>普通期限消费验收</title><body></body></html>',
      );
      return;
    }
    if (request.method === 'GET' && path === '/__harness.mjs') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await readFile(new URL('./harness.mjs', import.meta.url)));
      return;
    }
    if (request.method === 'GET' && path === '/__config') {
      json(response, {
        fixtures: fixtures.map((fixture) => ({
          pluginId: fixture.pluginId,
          protocolVersion: fixture.protocolVersion,
          operations: fixture.operations,
          runId: fixture.runId,
          caseId: fixture.caseId,
        })),
      });
      return;
    }
    if (request.method === 'GET' && path.startsWith('/__fixture/')) {
      let archive;
      if (path === '/__fixture/browser.tgz') archive = browserFixture.archive;
      else {
        const fixture = fixtures.find(
          (fixture) => path === '/__fixture/server-' + fixture.protocolVersion + '.tgz',
        );
        if (fixture) archive = await readFile(fixture.archivePath);
      }
      if (!archive) {
        json(response, { error: 'fixture_not_found' }, 404);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store' });
      response.end(archive);
      return;
    }
    if (request.method === 'POST' && path === '/__control/verify-default') {
      const input = JSON.parse((await bytes(request, 8192)).toString('utf8'));
      json(response, await verifyDefault(input));
      return;
    }
    if (request.method === 'GET' && path.startsWith('/assets/')) {
      const file = resolve(dist, '.' + decodeURIComponent(path));
      const within = relative(dist, file);
      if (
        !within ||
        isAbsolute(within) ||
        within === '..' ||
        within.startsWith('..' + '/') ||
        within.startsWith('..' + '\\')
      ) {
        throw new Error('生产资源路径越界');
      }
      const mime = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[
        extname(file)
      ];
      if (!mime) throw new Error('生产资源类型未支持');
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
    const controller = new AbortController();
    active.add(controller);
    const disconnected = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', disconnected);
    try {
      const headers = new Headers({ 'accept-encoding': 'identity' });
      for (const name of ['accept', 'content-type', 'authorization']) {
        const value = request.headers[name];
        if (typeof value === 'string') headers.set(name, value);
      }
      const body = ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await bytes(request, 8 * 1024 * 1024);
      const entry = { method: request.method, path };
      if (path === '/api/v2/jobs' && request.method === 'POST') {
        const submit = JSON.parse(body.toString('utf8'));
        if (
          JSON.stringify(Object.keys(submit).sort()) !== JSON.stringify(['input', 'operation']) ||
          JSON.stringify(Object.keys(submit.input).sort()) !== JSON.stringify(['case_id'])
        )
          throw new Error('浏览器提交注入额外执行字段');
        const fixture = fixtures.find(
          (fixture) =>
            fixture.operations.default === submit.operation &&
            fixture.caseId === submit.input.case_id,
        );
        if (!fixture) throw new Error('浏览器请求不是本次有限default');
        entry.operation = submit.operation;
        entry.caseId = submit.input.case_id;
      }
      const upstream = await fetch(base + path + url.search, {
        method: request.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      });
      if (
        upstream.headers.has('content-encoding') &&
        upstream.headers.get('content-encoding') !== 'identity'
      )
        throw new Error('真实响应不得压缩替换');
      const content = await bytes(upstream.body ?? [], 8 * 1024 * 1024);
      const outgoing = {};
      upstream.headers.forEach((value, name) => {
        if (
          !['connection', 'content-length', 'transfer-encoding', 'content-encoding'].includes(name)
        )
          outgoing[name] = value;
      });
      entry.status = upstream.status;
      entry.logId = upstream.headers.get('x-deviceforge-log-id');
      // 先保存真实状态和响应头日志；解包失败也不能丢失原服务证据。
      report.bridge.requests.push(entry);
      const staticAsset = path.startsWith('/api/v2/browser-plugins/');
      if (!staticAsset) {
        const envelope = JSON.parse(content.toString('utf8'));
        if (!envelope.log_id || envelope.log_id !== entry.logId)
          throw new Error('实际HTTP日志ID不一致');
        if (!upstream.ok) entry.errorCode = envelope.error?.code ?? null;
      }
      if (!response.destroyed) {
        response.writeHead(upstream.status, outgoing);
        response.end(content);
      }
    } catch (error) {
      if (controller.signal.aborted && response.destroyed && !closing) {
        report.bridge.requests.push({ method: request.method, path, clientDisconnected: true });
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
      for (const controller of active) controller.abort();
      const closed = new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      for (const socket of sockets) socket.destroy();
      await bounded(closed, 5000, '本次验收代理关闭超时');
    },
  };
}
