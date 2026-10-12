// 合成文本工具包只验证真实下载与安装事务，不构建或执行任何安全工具。
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, object, value, type Host } from './six-business-support.ts';
import { zip, type Source } from './ordinary-business-source.ts';
import type { Reporter } from './ordinary-business-report.ts';

export async function supplyCases(host: Host, remote: Source, audit: Reporter, installRoot: string, extended = false) {
  const input = { module_id: 'fixture-tool' }; const target = join(installRoot, 'fixture-tool');
  const entry = Buffer.from('合成工具包第一版\n');
  const archive = zip([{ name: 'bundle/entry.txt', bytes: entry }]);
  const run = async (name: string, data: unknown, viaMcp = false, expected = 'succeeded') => {
    const operation = `plugin.tool-supply.${name}`; const job = await host.run(operation, data, viaMcp);
    await audit.recordJob(host, job, expected, operation); assert.equal(job.status, expected); return job;
  };
  const transactionClean = async () => {
    try { await stat(join(installRoot, '.transactions/fixture-tool')); assert.fail('事务目录未清理'); }
    catch (error) { if (object(error).code !== 'ENOENT') throw error; }
  };
  const installed = async () => ({ entry: hash(await readFile(join(target, 'entry.txt'))),
    state: hash(await readFile(join(target, '.tool-supply-state.json'))) });
  let original: Awaited<ReturnType<typeof installed>>;
  await audit.check('tool-supply：catalog/plan、真实 ZIP 安装及无需下载的 current', async () => {
    remote.package(archive, '1.0.0');
    const catalog = value(await run('catalog', {})); assert.equal(catalog.source_error, null);
    assert.equal(object((catalog.modules as unknown[])[0]).action, 'install');
    const plan = value(await run('plan', { module_ids: ['fixture-tool'] }, true));
    assert.equal(plan.download_bytes, archive.length);
    const result = value(await run('install', input)); assert.equal(result.changed, true); assert.equal(result.sha256, hash(archive));
    assert.deepEqual(await readFile(join(target, 'entry.txt')), entry);
    const state = object(JSON.parse(await readFile(join(target, '.tool-supply-state.json'), 'utf8')));
    assert.equal(state.version, '1.0.0'); assert.equal(state.sha256, hash(archive));
    assert.equal(value(await run('plan', {}, true)).download_bytes, 0);
    const calls = remote.calls.filter((call) => call.kind === 'archive').length;
    assert.equal(value(await run('install', input, true)).changed, false);
    assert.equal(remote.calls.filter((call) => call.kind === 'archive').length, calls);
    await transactionClean(); original = await installed();
  });
  if (!extended) {
    await audit.check('tool-supply：MCP remove 与重复移除', async () => {
      assert.equal(value(await run('remove', input, true)).removed, true);
      assert.equal(value(await run('remove', input)).removed, false); await transactionClean();
      assert.equal((await readdir(installRoot)).includes('fixture-tool'), false);
    });
    return;
  }
  await audit.check('tool-supply：SHA256、ZIP 路径和入口失败保留旧版本与清理', async () => {
    const failures = [
      { name: '摘要不符', bytes: archive, checksum: '0'.repeat(64) },
      { name: '无效 ZIP', bytes: Buffer.from('synthetic-invalid-zip') },
      { name: '路径越界', bytes: zip([{ name: '../escaped.txt', bytes: Buffer.from('合成越界') }]) },
      { name: '缺少入口', bytes: zip([{ name: 'bundle/missing.txt', bytes: Buffer.from('合成缺失入口') }]) },
    ];
    for (const [index, item] of failures.entries()) {
      remote.package(item.bytes, '2.0.0', item.checksum ?? hash(item.bytes));
      await run('install', input, index % 2 === 0, 'failed');
      assert.deepEqual(await installed(), original, item.name); await transactionClean();
    }
    assert.equal((await readdir(installRoot)).includes('escaped.txt'), false);
  });
  const next = zip([{ name: 'bundle/entry.txt', bytes: Buffer.from('合成工具包第二版\n') }]);
  await audit.check('tool-supply：下载首块后取消、释放连接、原版本及事务清理', async () => {
    remote.package(next, '2.0.0', hash(next), true);
    const pending = object(await host.submit('plugin.tool-supply.install', input, true));
    await remote.waitDownload(); await host.cancel(String(pending.id));
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'cancelled', 'plugin.tool-supply.install');
    assert.equal(job.status, 'cancelled'); await remote.downloadClosed();
    // 终态与插件清理独立：卸载成功才继续检查安装目录。
    await host.manage('tool-supply', 'unload', true); await transactionClean(); assert.deepEqual(await installed(), original);
    await host.manage('tool-supply', 'load');
  });
  await audit.check('tool-supply：在途下载卸载取消、撤销操作及重载', async () => {
    remote.package(next, '2.0.0', hash(next), true);
    const pending = object(await host.submit('plugin.tool-supply.install', input));
    await remote.waitDownload(); await host.manage('tool-supply', 'unload');
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'cancelled', 'plugin.tool-supply.install');
    assert.equal(job.status, 'cancelled'); await remote.downloadClosed(); await transactionClean();
    assert.deepEqual(await installed(), original);
    const rejected = await host.request('/api/v2/jobs', { operation: 'plugin.tool-supply.install', input });
    assert.equal(rejected.response.status, 404); await host.manage('tool-supply', 'load', true);
  });
  await audit.check('tool-supply：成功升级、MCP remove 与重复移除', async () => {
    remote.package(next, '2.0.0');
    const updated = value(await run('install', input, true)); assert.equal(updated.version, '2.0.0'); assert.equal(updated.changed, true);
    await transactionClean(); assert.equal(value(await run('remove', input, true)).removed, true);
    assert.equal(value(await run('remove', input)).removed, false); await transactionClean();
    assert.equal((await readdir(installRoot)).includes('fixture-tool'), false);
  });
}
