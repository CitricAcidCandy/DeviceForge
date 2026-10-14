import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { uuid, within } from '../ordinary-deadline-http/control.mjs';

// 只走真实CLI安装；不能用HTTP在线上传替代本批分发证据。
export async function installPackages(host, items, temporary, report) {
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.protocolVersion).sort(), [2, 3]);
  assert.equal(new Set(items.map((item) => item.pluginId)).size, 2);
  assert.equal(new Set(items.map((item) => item.runId)).size, 1);
  report.packages = [];
  for (const item of items) {
    assert.match(item.runId, uuid);
    assert.match(item.archiveSha256, /^[a-f\d]{64}$/);
    assert.equal(item.shortTimeoutMs, 10000);
    within(temporary, item.archivePath);
    within(temporary, item.controlRoot);
    assert.ok((await stat(item.archivePath)).size <= 2 * 1024 * 1024);
    const archive = await fileIdentity(item.archivePath);
    assert.equal(archive.sha256, item.archiveSha256);
    assert.deepEqual(await readdir(item.controlRoot), []);
    const entry = {
      plugin_id: item.pluginId,
      protocol_version: item.protocolVersion,
      run_id: item.runId,
      archive,
      control_root: item.controlRoot,
      operations: item.operations,
      short_timeout_ms: item.shortTimeoutMs,
    };
    report.packages.push(entry);
    const result = await host.runNpx(
      [...host.prefix, 'plugin', 'install', item.archivePath, '--data-dir', host.directory],
      `install:${item.pluginId}`,
    );
    assert.equal(result.code, 0);
    assert.ok(result.stdout.includes(`${item.pluginId}@1.0.0 安装完成`));
    assert.equal((await fileIdentity(item.archivePath)).sha256, archive.sha256);
    assert.deepEqual(await readdir(item.controlRoot), [], '真实CLI安装不得执行本次插件');
    entry.install = { path: '真实npx plugin install', code: 0, package_sha256: archive.sha256 };
    const loaded =
      item.protocolVersion === 2
        ? await host.client.post(`/api/v2/plugins/${item.pluginId}/load`)
        : await host.client.tool('deviceforge.load_plugin', { id: item.pluginId });
    assert.equal(loaded.state, 'loaded');
    assert.equal(loaded.cleanup_failed, false);
    entry.load = {
      transport: item.protocolVersion === 2 ? 'http' : 'mcp',
      generation: loaded.generation,
    };
    assert.deepEqual(await readdir(item.controlRoot), [], '加载只注册操作，不自动执行');
  }
  const listed = await host.runNpx(
    [...host.prefix, 'plugin', 'list', '--data-dir', host.directory],
    'plugin-list',
  );
  const ids = JSON.parse(listed.stdout).map((item) => item.id);
  for (const item of items) assert.equal(ids.filter((id) => id === item.pluginId).length, 1);
  report.cli_listed_plugin_ids = ids;
  const http = await host.client.json('/api/v2/operations');
  const mcp = await host.client.tool('deviceforge.list_operations');
  assert.deepEqual(mcp, http);
  report.operation_budgets = [];
  for (const item of items)
    for (const [kind, operation] of Object.entries(item.operations)) {
      const found = http.filter((entry) => entry.id === operation);
      assert.equal(found.length, 1);
      const expected = {
        api_version: 1,
        total_timeout_ms: kind === 'long' ? 120000 : kind === 'short' ? 10000 : 60000,
        source: kind === 'default' ? 'default' : 'declared',
      };
      assert.deepEqual(found[0].execution, expected);
      report.operation_budgets.push({
        plugin_id: item.pluginId,
        protocol_version: item.protocolVersion,
        operation,
        ...expected,
      });
    }
}
