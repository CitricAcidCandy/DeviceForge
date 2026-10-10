import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { uuid, within } from './control.mjs';

// 压缩包摘要来自上传的原字节，不重新打包，也不从安装目录反推包身份。
export async function installFixtures(host, items, directory, report) {
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.protocolVersion).sort(), [2, 3]);
  assert.equal(new Set(items.map((item) => item.pluginId)).size, 2);
  assert.equal(new Set(items.map((item) => item.runId)).size, 1);
  report.packages = [];
  for (const item of items) {
    assert.match(item.pluginId, /^[A-Za-z0-9_-]{1,80}$/);
    assert.match(item.archiveSha256, /^[a-f\d]{64}$/);
    assert.match(item.runId, uuid);
    assert.equal(item.shortTimeoutMs, 10000);
    within(directory, item.archivePath);
    within(directory, item.controlRoot);
    assert.deepEqual(Object.keys(item.operations).sort(), ['default', 'long', 'short']);
    for (const operation of Object.values(item.operations)) {
      assert.ok(operation.startsWith(`plugin.${item.pluginId}.`));
    }
    const metadata = await stat(item.archivePath);
    assert.ok(metadata.isFile() && metadata.size <= 2 * 1024 * 1024);
    const archive = await readFile(item.archivePath);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    assert.equal(sha256, item.archiveSha256);
    const identity = { plugin_id: item.pluginId, protocol_version: item.protocolVersion,
      run_id: item.runId, archive: { path: item.archivePath, bytes: archive.length, sha256 },
      control_root: item.controlRoot, operations: item.operations, short_timeout_ms: item.shortTimeoutMs };
    report.packages.push(identity);
    const installed = await host.client.json('/api/v2/plugin-packages/server?format=tgz', {
      method: 'POST', status: 201, headers: { 'content-type': 'application/gzip' }, body: archive });
    assert.equal(installed.id, item.pluginId);
    identity.install_status = 201;
    const loaded = item.protocolVersion === 2
      ? await host.client.post(`/api/v2/plugins/${item.pluginId}/load`)
      : await host.client.tool('deviceforge.load_plugin', { id: item.pluginId });
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    identity.load_transport = item.protocolVersion === 2 ? 'http' : 'mcp';
  }
  const deployments = await host.client.json('/api/v2/plugin-packages/server');
  assert.deepEqual(deployments.map((item) => item.id).sort(), items.map((item) => item.pluginId).sort());
  const http = await host.client.json('/api/v2/operations');
  const mcp = await host.client.tool('deviceforge.list_operations');
  assert.deepEqual(mcp, http, 'HTTP/MCP 必须公布相同操作和有效预算');
  report.operation_budgets = [];
  for (const item of items) {
    for (const [kind, id] of Object.entries(item.operations)) {
      const found = http.filter((operation) => operation.id === id);
      assert.equal(found.length, 1);
      const expected = { api_version: 1, total_timeout_ms: kind === 'long' ? 120000
        : kind === 'short' ? 10000 : 60000, source: kind === 'default' ? 'default' : 'declared' };
      assert.deepEqual(found[0].execution, expected);
      report.operation_budgets.push({ plugin_id: item.pluginId, protocol_version: item.protocolVersion,
        operation: id, ...expected });
    }
  }
}

export async function verifyPackageBytes(report) {
  for (const item of report.packages) {
    const final = await fileIdentity(item.archive.path);
    assert.equal(final.sha256, item.archive.sha256);
    assert.equal(final.bytes, item.archive.bytes);
    item.archive_identity_after = final;
  }
}
