import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { packNativePlugins } from './native-plugin-package.mjs';

export async function installNativePlugins({ root, temporary, runNpx, prefix, dataDirectory }) {
  const packages = await packNativePlugins({ root, destination: temporary });
  assert.deepEqual(packages.map((pkg) => pkg.id).sort(), ['artifact_copy', 'echo', 'msgpack', 'performance_demo']);
  for (const pkg of packages) {
    const installed = await runNpx([...prefix, 'plugin', 'install', pkg.archive, '--data-dir', dataDirectory]);
    assert.ok(installed.stdout.includes(`${pkg.id}@${pkg.version} 安装完成`));
  }
  return packages;
}

export async function verifyNativePlugins({ base, mcp, headers }) {
  async function finished(id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await fetch(`${base}/api/v1/jobs/${id}`, { headers, signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const job = await response.json();
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        assert.equal(job.status, 'succeeded', job.error);
        return job.result;
      }
      await delay(25);
    }
    throw new Error('已安装原生插件任务未在期限内结束');
  }
  async function job(operation, input) {
    const response = await fetch(`${base}/api/v1/jobs`, {
      method: 'POST', headers, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 202);
    return finished((await response.json()).id);
  }
  let requestId = 10;
  async function mcpJob(name, input) {
    const response = await fetch(mcp, {
      method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream', origin: base },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: { name, arguments: input } }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.result.isError, false);
    return finished(reply.result.structuredContent.id);
  }
  async function content(artifact) {
    const response = await fetch(`${base}/api/v1/artifacts/${artifact.id}/content`, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, artifact.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    return bytes;
  }

  const echo = { message: '原生插件从 npx 包加载', value: 42 };
  assert.deepEqual(await job('plugin.echo.echo', echo), echo);
  const records = [{ id: 1, name: '设备甲' }, { id: 2, name: '设备乙' }, { id: 3, name: '其他' }];
  const bytes = Buffer.from(JSON.stringify(records));
  const upload = await fetch(`${base}/api/v1/artifacts?filename=npx-records.json`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(3000),
  });
  assert.equal(upload.status, 201);
  const source = await upload.json();
  const copied = await job('plugin.artifact_copy.copy', { artifact_id: source.id });
  assert.notEqual(copied.artifacts[0].id, source.id);
  assert.deepEqual(await content(copied.artifacts[0]), bytes);
  const encoded = await job('plugin.msgpack.encode', { artifact_id: source.id });
  const packed = encoded.artifacts[0];
  assert.equal((await content(packed))[0], 0x93);
  const decoded = await mcpJob('plugin.msgpack.decode', { artifact_id: packed.id });
  assert.deepEqual(JSON.parse((await content(decoded.artifacts[0])).toString('utf8')), records);
  const page = await mcpJob('plugin.msgpack.query', {
    artifact_id: packed.id, offset: 1, limit: 1, filter: { field: 'name', operator: 'contains', value: '设备' },
  });
  assert.equal(page.result.matched, 2);
  assert.deepEqual(page.result.records, [records[1]]);
  const sample = await job('plugin.performance_demo.sample', { device_id: 'synthetic-device', package: 'com.example.demo' });
  assert.equal(sample.result.frame_window.source, 'synthetic_demo');
  assert.equal(sample.result.frame_window.duration_ms, 1000);
}
