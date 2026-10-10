import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// 使用交付清单部署真实插件，避免测试与管理员配置模式各写一套。
export async function deployMessagePackPlugin(temporary, suffix, profile = 'debug') {
  const manifest = JSON.parse(await readFile(resolve('plugins/msgpack/manifest.example.json'), 'utf8'));
  manifest.executable = resolve('target', profile, `deviceforge-msgpack-plugin${suffix}`);
  const directory = join(temporary, 'plugins', 'msgpack');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
}

export async function verifyMessagePack({ base, headers, mcpHeaders, operations, mcp, deviceJob, finished }) {
  for (const name of ['encode', 'decode', 'query']) {
    const id = `plugin.msgpack.${name}`;
    assert.ok(operations.some((operation) => operation.id === id));
    assert.ok(mcp.result.tools.some((tool) => tool.name === id));
  }
  async function upload(filename, bytes, status = 201) {
    const response = await fetch(`${base}/api/v1/artifacts?filename=${filename}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: bytes,
    });
    assert.equal(response.status, status);
    return response.json();
  }
  async function content(artifact, mediaType) {
    const response = await fetch(`${base}/api/v1/artifacts/${artifact.id}/content`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mediaType);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, artifact.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    return bytes;
  }
  async function mcpJob(name, input, id) {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST', headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: `plugin.msgpack.${name}`, arguments: input } }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.result.isError, false);
    const job = await finished(reply.result.structuredContent.id);
    assert.equal(job.status, 'succeeded', job.error);
    return job.result;
  }
  const records = [{ id: 1, name: '设备甲' }, { id: 2, name: '设备乙' }, { id: 3, name: '其他' }];
  const source = await upload('records.json', Buffer.from(JSON.stringify(records)));
  assert.equal(source.media_type, 'application/json');
  const encoded = await deviceJob('plugin.msgpack.encode', { artifact_id: source.id });
  assert.equal(encoded.status, 'succeeded', encoded.error);
  const packed = encoded.result.artifacts[0];
  assert.equal(encoded.result.result.source_artifact_id, source.id);
  assert.notEqual(packed.id, source.id);
  assert.equal((await content(packed, 'application/msgpack'))[0], 0x93);
  const decoded = await mcpJob('decode', { artifact_id: packed.id }, 50);
  assert.deepEqual(JSON.parse((await content(decoded.artifacts[0], 'application/json')).toString('utf8')), records);
  const page = await mcpJob('query', { artifact_id: packed.id, offset: 1, limit: 1, filter: { field: 'name', operator: 'contains', value: '设备' } }, 51);
  assert.equal(page.result.total, 3);
  assert.equal(page.result.matched, 2);
  assert.deepEqual(page.result.records, [records[1]]);
  assert.equal(page.result.next_offset, null);
  assert.deepEqual(page.artifacts, []);
  const lookup = await deviceJob('plugin.msgpack.query', { artifact_id: packed.id, limit: 1, filter: { field: 'id', operator: 'equals', value: 3 } });
  assert.equal(lookup.status, 'succeeded', lookup.error);
  assert.deepEqual(lookup.result.result.records, [records[2]]);
  assert.equal((await fetch(`${base}/api/v1/artifacts/${packed.id}/entries`, { headers })).status, 400);
  assert.equal((await deviceJob('plugin.msgpack.decode', { artifact_id: source.id })).status, 'failed');
  const binary = await upload('binary.msgpack', Buffer.from([0xc4, 1, 0]));
  assert.equal((await deviceJob('plugin.msgpack.decode', { artifact_id: binary.id })).status, 'failed');
  await upload('bad.json', Buffer.from('{"x":1,"x":2}'), 400);
  await upload('bad.msgpack', Buffer.from([0xc1]), 400);
  await upload('large.msgpack', Buffer.alloc(16 * 1024 * 1024 + 1), 413);
  const invalid = await fetch(`${base}/api/v1/jobs`, {
    method: 'POST', headers,
    body: JSON.stringify({ operation: 'plugin.msgpack.encode', input: { artifact_id: source.id, path: 'request-path' } }),
  });
  assert.equal(invalid.status, 400);
  console.log('标准 MessagePack 真实进程插件：HTTP 编码、MCP 解码 / 分页筛选、产物摘要与拒绝边界验证通过');
}
