// 配置业务验收仅调用真实宿主公开任务入口，远端数据全部为合成夹具。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, object, poll, value, type Host } from './six-business-support.ts';
import type { Source } from './ordinary-business-source.ts';
import type { Reporter } from './ordinary-business-report.ts';
import { settingsBackupCases } from './ordinary-settings-backup-cases.ts';

export async function settingsCases(host: Host, remote: Source, audit: Reporter, storage: string, extended = false) {
  const owner = { scope: 'user', owner_id: 'fixture' };
  const run = async (name: string, input: unknown, viaMcp = false, expected = 'succeeded') => {
    const operation = `plugin.settings.${name}`; const job = await host.run(operation, input, viaMcp);
    await audit.recordJob(host, job, expected, operation); assert.equal(job.status, expected); return job;
  };
  await audit.check('settings：本地 CRUD、显式 null、用户与工作区分离', async () => {
    assert.equal(value(await run('list', owner)).revision, '0');
    const written = value(await run('set', { ...owner, section: 'theme', expected_revision: '0', value: null }, true));
    assert.equal(written.revision, '1'); assert.equal(object(written.sections).theme, null);
    assert.equal(value(await run('get', { ...owner, section: 'theme' })).value, null);
    assert.equal(value(await run('list', { ...owner, scope: 'workspace' }, true)).revision, '0');
    const imported = value(await run('import', { ...owner, expected_revision: '1', sections: { deviceInfo: [], permissions: {} } }));
    assert.equal(imported.revision, '2'); assert.deepEqual(object(imported.sections).deviceInfo, []);
    const deleted = value(await run('delete', { ...owner, section: 'theme', expected_revision: '2' }, true));
    assert.equal(deleted.revision, '3'); assert.equal('theme' in object(deleted.sections), false);
  });
  await audit.check('settings：过期 CAS 原件保留及跨插件进程唯一胜者', async () => {
    const path = join(storage, 'users/fixture/settings.json'); const before = hash(await readFile(path));
    await run('set', { ...owner, section: 'theme', expected_revision: '0', value: '过期合成配置' }, true, 'failed');
    assert.equal(hash(await readFile(path)), before);
    const request = { ...owner, expected_revision: '3', section: 'winner', value: '并发合成配置' };
    const submitted = await Promise.all([host.submit('plugin.settings.set', request), host.submit('plugin.settings.set', request, true)]);
    const jobs = await Promise.all(submitted.map((job) => host.finished(String(object(job).id))));
    for (const job of jobs) await audit.recordJob(host, job, String(job.status), 'plugin.settings.set');
    assert.deepEqual(jobs.map((job) => job.status).sort(), ['failed', 'succeeded']);
    assert.equal(value(await run('list', owner)).revision, '4');
  });
  if (!extended) return;
  const input = { scope: 'workspace', owner_id: 'remote', section: 'deviceInfo' };
  await audit.check('settings：远端读取备份、保存、失联回退及失败无损', async () => {
    remote.settings('ok', { label: '第一份合成配置' });
    const loaded = value(await run('remote.load', { ...input, expected_revision: '0' }, true));
    assert.equal(loaded.source, 'remote'); assert.equal(loaded.backup_updated, true); assert.equal(loaded.revision, '1');
    remote.settings('failed');
    const cached = value(await run('remote.load', { ...input, expected_revision: '1' }));
    assert.equal(cached.source, 'local'); assert.equal(cached.backup_updated, false); assert.equal(cached.revision, '1');
    assert.deepEqual(cached.value, { label: '第一份合成配置' });
    remote.settings('ok');
    const saved = value(await run('remote.save', { ...input, expected_revision: '1', value: { label: '第二份合成配置' } }, true));
    assert.equal(saved.remote_committed, true); assert.equal(saved.backup_updated, true); assert.equal(saved.revision, '2');
    const count = remote.calls.length;
    await run('remote.save', { ...input, expected_revision: '1', value: null }, false, 'failed');
    assert.equal(remote.calls.length, count, '过期修订不得向远端写入');
    remote.settings('failed');
    await run('remote.save', { ...input, expected_revision: '2', value: null }, true, 'failed');
    assert.equal(value(await run('get', input)).revision, '2');
    assert.ok(remote.calls.filter((call) => call.kind.startsWith('remote.')).every((call) => call.sentinel_header));
  });
  await audit.check('settings：远端保存持锁覆盖提交与备份，同归属旧 CAS 排队后拒绝', async () => {
    remote.settings('hold');
    const pending = object(await host.submit('plugin.settings.remote.save', { ...input, expected_revision: '2', value: { label: '远端已提交' } }));
    await remote.waitSettings();
    const competing = object(await host.submit('plugin.settings.set', { ...input, expected_revision: '2', value: { label: '并发本地配置' } }, true));
    await poll(async () => object((await host.request(`/api/v2/jobs/${String(competing.id)}`)).json),
      (job) => job.status === 'running', '同归属本地写入进入锁等待');
    const document = JSON.parse((await readFile(join(storage, 'workspaces/remote/settings.json'))).toString('utf8')) as unknown;
    assert.equal(object(document).revision, '2');
    remote.releaseSettings(); const job = await host.finished(String(pending.id));
    await audit.recordJob(host, job, 'succeeded', 'plugin.settings.remote.save');
    const result = value(job); assert.equal(result.remote_committed, true); assert.equal(result.backup_updated, true); assert.equal(result.revision, '3');
    const conflict = await host.finished(String(competing.id));
    await audit.recordJob(host, conflict, 'failed', 'plugin.settings.set'); assert.equal(conflict.status, 'failed');
    assert.deepEqual(value(await run('get', input)).value, { label: '远端已提交' });
  });
  await audit.check('settings：远端读取与本地备份 CAS 竞争，如实返回远端内容', async () => {
    remote.settings('hold');
    const pending = object(await host.submit('plugin.settings.remote.load', { ...input, expected_revision: '3' }));
    await remote.waitSettings();
    assert.equal(value(await run('set', { ...input, expected_revision: '3', value: { label: '并发本地配置' } }, true)).revision, '4');
    remote.releaseSettings(); const job = await host.finished(String(pending.id));
    await audit.recordJob(host, job, 'succeeded', 'plugin.settings.remote.load');
    const result = value(job); assert.equal(result.remote_committed, false); assert.equal(result.backup_updated, false); assert.equal(result.revision, null);
    assert.deepEqual(result.value, { label: '远端已提交' });
    assert.deepEqual(value(await run('get', input)).value, { label: '并发本地配置' });
  });
  await audit.check('settings：远端在途取消不得伪装本地备份成功', async () => {
    remote.settings('hold');
    const pending = object(await host.submit('plugin.settings.remote.load', { ...input, expected_revision: '4' }, true));
    await remote.waitSettings(); await host.cancel(String(pending.id));
    const job = await host.finished(String(pending.id)); await audit.recordJob(host, job, 'cancelled', 'plugin.settings.remote.load');
    assert.equal(job.status, 'cancelled'); await remote.settingsClosed();
    assert.equal(value(await run('get', input)).revision, '4'); remote.settings('ok');
  });
  await settingsBackupCases(host, remote, audit, storage);
}
