// 复用 CLI 生命周期，只管理本轮私有服务与端口，不接触现有预览进程。
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { start } from '../../cli/src/start.mjs';
import { client } from './client.mjs';

export const cleanEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(APK_|DEVICEFORGE_)/i.test(key)),
  );

export async function freePort(port = 0) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  const selected = server.address().port;
  await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return selected;
}

async function logs(data) {
  const files = (await readdir(join(data, 'logs'))).filter((name) => name.endsWith('.jsonl'));
  assert.ok(files.length > 0, '真实宿主应产生日志文件');
  const records = [];
  for (const file of files) {
    const text = await readFile(join(data, 'logs', file), 'utf8');
    records.push(
      ...text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
  return records;
}

export async function launch(options, runtime, environment, report) {
  const controller = new AbortController();
  let notify;
  const ready = new Promise((done) => {
    notify = done;
  });
  const entry = {
    round: report.runs.length + 1,
    web_port: options.port,
    mcp_port: options.mcpPort,
    normal_shutdown: false,
    ports_released: false,
  };
  report.runs.push(entry);
  const running = start(options, {
    runtime,
    environment,
    signal: controller.signal,
    onReady: notify,
  });
  const stopped = running.then(
    () => ({ stopped: true }),
    (error) => ({ error }),
  );
  async function stop() {
    controller.abort();
    const result = await stopped;
    if (result.error) throw result.error;
    const records = await logs(options.dataDirectory);
    const completed = records.filter(
      (record) => record.fields?.message === '宿主运行已结束' && record.fields.success === true,
    );
    assert.ok(completed.length >= entry.round, '本轮宿主必须正常结束，不能用强杀代替');
    entry.normal_shutdown = true;
    const starts = records.filter((record) => record.fields?.message === '浏览器服务已启动');
    const backendPorts = [
      ...new Set(
        starts.map((record) => {
          assert.equal(typeof record.fields.address, 'string');
          const port = Number(record.fields.address.split(':').at(-1));
          assert.ok(Number.isInteger(port) && port > 0);
          return port;
        }),
      ),
    ];
    assert.ok(backendPorts.length > 0);
    entry.observed_backend_ports = backendPorts;
    for (const port of new Set([options.port, options.mcpPort, ...backendPorts]))
      await freePort(port);
    entry.ports_released = true;
  }
  try {
    await Promise.race([
      ready,
      stopped.then((result) => {
        throw result.error ?? new Error('CLI 就绪前退出');
      }),
    ]);
    const base = `http://127.0.0.1:${options.port}`;
    const api = client(base, `http://127.0.0.1:${options.mcpPort}/mcp`, report);
    assert.equal((await api.api('/api/v2/health')).status, 'ok');
    const page = await fetch(base, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<!doctype html/i);
    return { client: api, stop };
  } catch (error) {
    controller.abort();
    await stopped;
    throw error;
  }
}
