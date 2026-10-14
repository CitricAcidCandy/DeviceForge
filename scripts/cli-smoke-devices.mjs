import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { npmCommand } from '../cli/src/processes.mjs';

// 使用公开示例与实际 npx 安装器，验证分发包没有丢失设备声明。
export async function verifyNpxDeviceProvider({
  root,
  temporary,
  runNpx,
  prefix,
  dataDirectory,
  base,
  mcp,
}) {
  const npm = npmCommand();
  const packed = await promisify(execFile)(
    npm.command,
    [...npm.prefix, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary],
    {
      cwd: join(root, 'backend/examples/device-provider-node'),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 120000,
    },
  );
  const archive = join(temporary, JSON.parse(packed.stdout)[0].filename);
  const installed = await runNpx([
    ...prefix,
    'plugin',
    'install',
    archive,
    '--data-dir',
    dataDirectory,
  ]);
  assert.match(installed.stdout, /device_node_example@0\.1\.0 安装完成/);
  const headers = { 'content-type': 'application/json' };
  async function call(path, { status = 200, code, ...options } = {}) {
    const response = await fetch(`${base}${path}`, {
      headers,
      signal: AbortSignal.timeout(15000),
      ...options,
    });
    const body = await response.json();
    assert.equal(response.status, status);
    assert.match(body.log_id, /^[\da-f-]{36}$/);
    assert.equal(body.log_id, response.headers.get('x-deviceforge-log-id'));
    if (code) assert.equal(body.error.code, code);
    return body.data;
  }
  async function rpc(name, arguments_, errorCode) {
    const response = await fetch(mcp, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { ...headers, accept: 'application/json, text/event-stream', origin: base },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name, arguments: arguments_ },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.isError, Boolean(errorCode));
    assert.match(body.result._meta['deviceforge/log_id'], /^[\da-f-]{36}$/);
    assert.equal(
      body.result._meta['deviceforge/log_id'],
      response.headers.get('x-deviceforge-log-id'),
    );
    if (errorCode) assert.equal(body.result.structuredContent.code, errorCode);
    return body.result.structuredContent;
  }
  async function finished(id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const job = await call(`/api/v2/jobs/${id}`);
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'succeeded');
        return job;
      }
      await delay(25);
    }
    throw new Error('npx 设备能力任务未按期限完成');
  }
  await verify({ call, rpc, finished });
}

async function verify({ call, rpc, finished }) {
  const id = 'device_node_example';
  assert.ok(!(await call('/api/v2/device-providers')).some((provider) => provider.id === id));
  const loaded = await call(`/api/v2/plugins/${id}/load`, { method: 'POST' });
  assert.equal(loaded.state, 'loaded');
  const provider = (await call('/api/v2/device-providers')).find((item) => item.id === id);
  assert.ok(provider);
  assert.equal(provider.generation, loaded.generation);
  assert.equal(provider.definition.platform, 'synthetic_demo');
  assert.equal(provider.definition.api_version, 2);
  assert.equal(
    provider.definition.capabilities.find((capability) => capability.id === 'device.echo')
      ?.execution_timeout_ms,
    120000,
  );
  assert.equal(
    provider.definition.capabilities.find((capability) => capability.id === 'provider.describe')
      ?.execution_timeout_ms,
    undefined,
  );
  assert.deepEqual(
    await rpc('deviceforge.list_device_providers', {}),
    await call('/api/v2/device-providers'),
  );
  const directory = await rpc('deviceforge.refresh_devices', {
    id,
    generation: provider.generation,
  });
  assert.equal(directory.devices.length, 1);
  const reference = directory.devices[0].reference;
  assert.deepEqual(reference, {
    provider_id: id,
    generation: provider.generation,
    local_id: 'demo-device',
  });
  assert.ok((await call('/api/v2/devices')).some((item) => item.provider.id === id));
  const action = {
    provider_id: id,
    generation: provider.generation,
    device_id: reference.local_id,
    capability: 'device.echo',
    version: 1,
    input: { source: '实际 npx 默认免鉴权' },
  };
  const submitted = await call('/api/v2/device-actions', {
    method: 'POST',
    status: 202,
    body: JSON.stringify(action),
  });
  assert.deepEqual((await finished(submitted.id)).result, {
    synthetic_demo: true,
    device_id: reference.local_id,
    value: action.input,
  });
  const originalJob = await call(`/api/v2/jobs/${submitted.id}`);
  const originalEvents = await call(`/api/v2/jobs/${submitted.id}/events`);
  assert.deepEqual(
    originalEvents.map((event) => event.status),
    ['queued', 'running', 'succeeded'],
  );
  const described = await rpc('deviceforge.invoke_device', {
    ...action,
    device_id: null,
    capability: 'provider.describe',
    input: {},
  });
  assert.deepEqual((await finished(described.id)).result, {
    synthetic_demo: true,
    platform: 'synthetic_demo',
    persistent_session: false,
  });
  assert.equal((await rpc('deviceforge.unload_plugin', { id })).state, 'unloaded');
  assert.ok(!(await call('/api/v2/device-providers')).some((item) => item.id === id));
  assert.ok(!(await call('/api/v2/devices')).some((item) => item.provider.id === id));
  const reloaded = await rpc('deviceforge.load_plugin', { id });
  assert.notEqual(reloaded.generation, provider.generation);
  await call('/api/v2/device-actions', {
    method: 'POST',
    status: 409,
    code: 'conflict',
    body: JSON.stringify(action),
  });
  await rpc('deviceforge.invoke_device', action, 'conflict');
  const fresh = await call(`/api/v2/device-providers/${id}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ generation: reloaded.generation }),
  });
  assert.equal(fresh.provider.generation, reloaded.generation);
  const next = await rpc('deviceforge.invoke_device', {
    ...action,
    generation: reloaded.generation,
  });
  assert.equal((await finished(next.id)).result.synthetic_demo, true);
  assert.deepEqual(await call(`/api/v2/jobs/${submitted.id}`), originalJob);
  assert.deepEqual(await rpc('deviceforge.get_job', { id: submitted.id }), originalJob);
  assert.deepEqual(await call(`/api/v2/jobs/${submitted.id}/events`), originalEvents);
  assert.deepEqual(await rpc('deviceforge.job_events', { id: submitted.id }), originalEvents);
  assert.equal((await rpc('deviceforge.unload_plugin', { id })).state, 'unloaded');
}
