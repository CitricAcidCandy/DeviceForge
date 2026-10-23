import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileIdentity } from './evidence.mjs';

// 只核对插件实际创建的台账，不向生产台账注入或重写记录。
export async function ledgerSnapshot(context) {
  const root = join(context.report.deployment.independent_plugin_directory, '.mirroring-resources');
  const control = join(context.report.deployment.independent_plugin_directory, '.mirroring-control');
  let names;
  try { names = await readdir(root); }
  catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  assert.ok(names.length <= 8192);
  const records = [];
  for (const name of names.filter((item) => /^[a-f0-9]{32}\.json$/.test(item))) {
    const path = join(root, name);
    assert.ok((await stat(path)).size <= 32 * 1024);
    const record = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(record.version, 1);
    assert.equal(name, record.token + '.json');
    assert.equal(record.directory, '/data/local/tmp/deviceforge_' + record.token);
    assert.ok([context.fixture.device, context.fixture.nextDevice].includes(record.device_id));
    assert.ok(Number.isInteger(record.owner.pid) && record.owner.pid > 0);
    assert.ok(typeof record.owner.birth === 'string' && record.owner.birth.length > 0);
    for (const field of ['directory_stage', 'upload_stage', 'forward_stage', 'server_stage'])
      assert.ok(['planned', 'attempting', 'confirmed', 'released'].includes(record[field]));
    if (record.remote) assert.deepEqual(record.remote, {
      pid: 7001, start: '9001', boot: '11111111-2222-4333-8444-555555555555',
    });
    records.push({ file: await fileIdentity(path), device_id: record.device_id,
      token: record.token, owner_pid: record.owner.pid,
      directory_stage: record.directory_stage, forward_stage: record.forward_stage,
      server_stage: record.server_stage, remote_identity_recorded: record.remote !== null });
  }
  const value = { observed_at: new Date().toISOString(), root, control_root: control, records };
  (context.report.ledger_observations ??= []).push(value);
  return value;
}
