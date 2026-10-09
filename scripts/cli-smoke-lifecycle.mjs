import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 真实 npx 在宿主运行中安装插件，HTTP 与独立 MCP 共用同一生命周期。
export async function verifyLiveInstallation({ runNpx, prefix, fixture, dataDirectory, pluginDirectory, base, mcp, headers }) {
  async function call(path, options = {}) {
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10000), ...options });
    const body = await response.json();
    assert.equal(body.log_id, response.headers.get('x-deviceforge-log-id'));
    return { response, body };
  }
  async function rpc(name, arguments_) {
    const response = await fetch(mcp, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { ...headers, accept: 'application/json, text/event-stream', origin: base },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.isError, false);
    assert.equal(body.result._meta['deviceforge/log_id'], response.headers.get('x-deviceforge-log-id'));
    return body.result.structuredContent;
  }
  assert.ok(!(await call('/api/v2/plugins')).body.data.some((plugin) => plugin.id === 'npx_demo'));
  const installed = await runNpx([...prefix, 'plugin', 'install', fixture, '--data-dir', dataDirectory]);
  assert.match(installed.stdout, /npx_demo@1.0.0 安装完成/);
  const deployed = join(pluginDirectory, 'npx_demo/node_modules/test-deviceforge-npx-plugin');
  assert.ok(!(await readdir(deployed)).includes('INSTALL_SCRIPT_RAN'));
  const first = await call('/api/v2/plugins/npx_demo/load', { method: 'POST' });
  assert.equal(first.response.status, 200);
  const submitted = await call('/api/v2/jobs', { method: 'POST',
    body: JSON.stringify({ operation: 'plugin.npx_demo.echo', input: { message: '启动后 npx 安装' } }) });
  assert.equal(submitted.response.status, 202);
  const id = submitted.body.data.id;
  let completed;
  for (let attempt = 0; attempt < 200; attempt++) {
    completed = (await call(`/api/v2/jobs/${id}`)).body.data;
    if (['succeeded', 'failed', 'cancelled'].includes(completed.status)) break;
    await delay(25);
  }
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.message, 'npm 包依赖可用');
  const detached = await rpc('deviceforge.unload_plugin', { id: 'npx_demo' });
  assert.equal(detached.state, 'unloaded');
  assert.equal(detached.generation, first.body.data.generation);
  const unavailable = await call('/api/v2/jobs', { method: 'POST',
    body: JSON.stringify({ operation: 'plugin.npx_demo.echo', input: { message: '已卸载' } }) });
  assert.equal(unavailable.response.status, 404);
  assert.equal((await call(`/api/v2/jobs/${id}`)).body.data.status, 'succeeded');
  const reloaded = await rpc('deviceforge.load_plugin', { id: 'npx_demo' });
  assert.notEqual(reloaded.generation, first.body.data.generation);
  assert.ok((await rpc('deviceforge.list_plugins', {})).some((plugin) => plugin.id === 'npx_demo'));
}
