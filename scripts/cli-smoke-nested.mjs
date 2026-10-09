import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from './device-provider/client.mjs';
import { clientFor, terminal } from './nested-device-artifacts/client.mjs';
import { fixture, action, events, pointer, processEvidence, sourceBytes, started } from './nested-device-artifacts/fixtures.mjs';
import { discover } from './nested-device-artifacts/installation.mjs';
import { businessInput, verifyArtifacts, writeArtifact } from './nested-device-artifacts/artifacts.mjs';

// 使用实际 CLI 安装，不以在线上传或旧回显示例代替新契约的分发证据。
export async function verifyNpxNestedArtifacts({ root, temporary, runNpx, prefix, dataDirectory, pluginDirectory, base, mcp }) {
  const report = { timestamp: new Date().toISOString(), profile: 'npx', passed: false, checks: [],
    scope: '同一真实 npx 分发包、CLI 安装协议 2/3 模拟提供者、HTTP/独立 MCP 嵌套产物及热装卸；不含真机或常驻连接' };
  const host = clientFor(base, report, { mcp });
  const fixtures = [];
  const context = { host, fixtures, report, history: new Map() };
  const historyEvents = new Map();
  try {
    const markerRoot = join(temporary, 'nested-markers');
    await mkdir(markerRoot, { recursive: true });
    for (const protocol of [2, 3]) {
      const item = await fixture(protocol, markerRoot);
      fixtures.push(item);
      const archive = join(temporary, `${item.id}.tgz`);
      await writeFile(archive, item.archive);
      const installed = await runNpx([...prefix, 'plugin', 'install', archive, '--data-dir', dataDirectory]);
      assert.ok(installed.stdout.includes(`${item.id}@1.0.0 安装完成`));
      const manifest = JSON.parse(await readFile(join(pluginDirectory, item.id, 'manifest.json'), 'utf8'));
      assert.equal(manifest.protocol_version, protocol);
      assert.deepEqual(manifest.artifacts.input_pointers, [pointer]);
      assert.equal(manifest.artifacts.outputs, true);
      assert.deepEqual(await events(item), [], 'CLI 安装及校验不能执行插件');
      await host.client.manage(item.id, 'load', protocol === 2 ? 'http' : 'mcp');
      item.provider = (await host.client.json('/api/v2/device-providers')).find((value) => value.id === item.id);
      assert.ok(item.provider);
      await discover(host.client, item, protocol === 2 ? 'http' : 'mcp');
    }
    report.checks.push({ name: '真实 npx CLI 安装保留两协议嵌套产物声明', passed: true });
    await verifyArtifacts(context);
    for (const id of context.history.keys()) historyEvents.set(id, await host.client.json(`/api/v2/jobs/${id}/events`));
    for (const item of fixtures) await verifyReload(context, item);
    for (const [id, original] of context.history) {
      assert.deepEqual(await terminal(host.client, id, original.status), original);
      if (historyEvents.has(id)) {
        assert.deepEqual(await host.client.json(`/api/v2/jobs/${id}/events`), historyEvents.get(id));
        assert.deepEqual(await host.client.tool('deviceforge.job_events', { id }), historyEvents.get(id));
      }
      for (const artifact of original.result?.artifacts ?? []) await host.download(artifact, sourceBytes);
    }
    for (const item of fixtures) await host.client.manage(item.id, 'unload');
    report.history_jobs = [...context.history.keys()];
    report.passed = true;
  } catch (error) {
    report.failed_request ??= report.last_request;
    report.error_name = error.name;
    throw error;
  } finally {
    report.completed_at = new Date().toISOString();
    await writeFile(join(root, 'artifacts', 'nested-device-artifacts-smoke-npx.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
}

async function verifyReload(context, item) {
  const { client } = context.host;
  const old = item.provider;
  const label = `npx-unload-v${item.protocol}`;
  const active = await client.action(action(item, businessInput(context, label, 'blocked')));
  const start = await started(item, label);
  await poll(() => events(item), (all) => all.some((event) => event.kind === 'copy_verified'
    && event.request_id === start.request_id), 'npx 在途任务真实读副本', 10000);
  const unloaded = await client.manage(item.id, 'unload', item.protocol === 2 ? 'http' : 'mcp');
  assert.equal(unloaded.state, 'unloaded');
  assert.equal(unloaded.cleanup_failed, false);
  const evidence = await processEvidence(item, label, { atReturn: true, cooperative: item.protocol === 3 });
  context.history.set(active.id, await terminal(client, active.id, 'cancelled'));
  assert.ok(!(await client.json('/api/v2/device-providers')).some((value) => value.id === item.id));
  assert.ok(!(await client.json('/api/v2/devices')).some((value) => value.provider.id === item.id));
  const loaded = await client.manage(item.id, 'load', item.protocol === 2 ? 'mcp' : 'http');
  assert.equal(loaded.state, 'loaded');
  assert.notEqual(loaded.generation, old.generation);
  item.provider = (await client.json('/api/v2/device-providers')).find((value) => value.id === item.id);
  assert.ok(item.provider);
  const stale = action(item, businessInput(context, `npx-stale-v${item.protocol}`), 'device.write', old);
  await client.post('/api/v2/device-actions', stale, { status: 409, code: 'conflict' });
  await client.tool('deviceforge.invoke_device', stale, 'conflict');
  await discover(client, item, 'mcp');
  await writeArtifact(context, item, 'http', `npx-reloaded-v${item.protocol}`);
  context.report.checks.push({ name: `协议 ${item.protocol} npx 在途卸载、真实退出、新代与旧代拒绝`,
    passed: true, evidence, old_generation: old.generation, new_generation: loaded.generation });
}
