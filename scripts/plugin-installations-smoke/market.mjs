// 代理只统计真实资源服务请求，不改写资源内容或代替市场实现。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { port, poll, fileIdentity } from './host.mjs';

export async function launchMarket({ binary, cwd, data, report, beforeRequest = async () => {} }) {
  const identity = await fileIdentity(binary);
  const selected = await port(),
    target = `http://127.0.0.1:${selected}`;
  const child = spawn(binary, ['--bind', `127.0.0.1:${selected}`, '--data-dir', data], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '',
    spawnError;
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-12000);
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  const counts = new Map();
  const proxy = createServer(async (incoming, outgoing) => {
    const key = `${incoming.method} ${incoming.url}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    try {
      await beforeRequest(incoming.method, incoming.url);
    } catch {
      outgoing.writeHead(503);
      outgoing.end();
      return;
    }
    if (outgoing.destroyed) return;
    const upstream = request(
      new URL(incoming.url, target),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  try {
    await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error(stderr);
        try {
          return (await fetch(target + '/api/v1/health', { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      Boolean,
      '真实市场健康',
    );
    await new Promise((done, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', done);
    });
  } catch (error) {
    proxy.close();
    child.kill();
    await closed;
    throw error;
  }
  const base = `http://127.0.0.1:${proxy.address().port}`;
  report.market = { pid: child.pid, binary: identity, port: selected, proxy: base, data };
  let stopped = false;
  return {
    base,
    counts,
    async stop() {
      if (stopped) return;
      stopped = true;
      proxy.closeAllConnections();
      await new Promise((done) => proxy.close(done));
      if (child.exitCode === null) child.kill();
      report.market.exit = await closed;
      report.market.requests = Object.fromEntries(counts);
      assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    },
  };
}
