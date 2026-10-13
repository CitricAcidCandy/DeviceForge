import assert from 'node:assert/strict';
import { join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startProbe, finishProbe, observeProbe, finishPendingProbes } from '../harmony-screenshot-smoke/fixtures.mjs';

export { finishPendingProbes };
const normalized = value => win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();

export function consoleHostPath(systemRoot = process.env.SystemRoot) {
  assert.equal(typeof systemRoot, 'string', 'Windows进程族验收必须取得SystemRoot');
  return normalized(win32.join(systemRoot, 'System32', 'conhost.exe'));
}

export function isConsoleHost(identity, members, approved, systemRoot = process.env.SystemRoot) {
  if (normalized(identity.executable) !== consoleHostPath(systemRoot)) return false;
  const parent = members.get(identity.parent_pid);
  return parent !== undefined && approved.has(normalized(parent.executable));
}

export async function startFamily(context, ready, directory, label) {
  const members = new Map(ready.family.map(entry => [entry.pid, entry]));
  const owner = members.get(ready.identity.parent_pid);
  assert.ok(owner, '本轮真实CLI直接父身份必须在原生快照中');
  assert.equal(normalized(owner.executable), normalized(context.pluginBinary));
  const approved = new Set([context.pluginBinary, context.nodeBinary, context.cliBinary].map(normalized));
  const expectedConsoleHost = consoleHostPath();
  const probes = [];
  for (const identity of ready.family) {
    if (identity.pid === owner.pid) continue;
    const consoleHost = isConsoleHost(identity, members, approved);
    assert.ok(consoleHost || approved.has(normalized(identity.executable)), '本轮进程族不得含未冻结的程序入口');
    const parent = members.get(identity.parent_pid);
    assert.ok(parent, '每个被观察角色必须有真实直接父身份');
    if (consoleHost) assert.ok(approved.has(normalized(parent.executable)), '系统控制台宿主的直接父必须是冻结成员');
    const role = consoleHost ? 'os-console-host' : identity.pid === ready.identity.pid ? 'cli' : normalized(identity.executable) === normalized(context.cliBinary)
      ? 'cli-descendant' : normalized(identity.executable) === normalized(context.nodeBinary) ? 'sdk-node' : 'plugin-helper';
    const probe = await startProbe(context.probeBinary, identity.pid, join(directory, 'os-' + identity.pid), parent.executable);
    for (const [actual, expected] of [[probe.ready.target, identity], [probe.ready.parent, parent]]) {
      assert.equal(actual.pid, expected.pid);
      assert.equal(actual.creation_time_100ns, expected.creation_time_100ns);
      assert.equal(normalized(actual.exe), normalized(expected.executable));
      assert.equal(actual.state, 'running');
    }
    probes.push({ identity, parent, role, probe });
  }
  assert.ok(probes.some(entry => entry.role === 'sdk-node'), '必须实际持有官方SDK Node进程句柄');
  assert.equal(probes.filter(entry => entry.role === 'cli-descendant').length, 2);
  assert.ok(probes.some(entry => entry.role === 'plugin-helper'), '必须观察真实监督与代理族');
  const record = { label, owner, console_host_policy: {
    executable: expectedConsoleHost,
    exact_path_only: true,
    direct_parent_must_be_frozen_member: true,
    os_probe_required: true,
    included_in_exit_confirmation: true
  }, members: probes.map(entry => ({ role: entry.role,
    identity: entry.identity, parent: entry.parent, probe_ready: entry.probe.ready })) };
  context.report.process_families.push(record);
  return { probes, record };
}

export async function observeFamily(family) {
  const observations = [];
  for (const entry of family.probes) {
    const observed = await observeProbe(entry.probe);
    assert.equal(observed.target.state, 'running');
    assert.equal(observed.parent.state, 'running');
    observations.push({ role: entry.role, identity: entry.identity, observed });
  }
  family.record.provider_candidate_observation = observations;
  return observations;
}

export async function finishFamily(family, expectedCliCode) {
  const controller = new AbortController();
  const deadline = delay(18000, undefined, { signal: controller.signal }).then(() => {
    throw new Error('SDK完整进程族真实退出确认超时');
  });
  deadline.catch(() => {});
  try {
    return await Promise.race([finishMembers(family, expectedCliCode), deadline]);
  } finally { controller.abort(); }
}

async function finishMembers(family, expectedCliCode) {
  const records = [];
  for (const entry of family.probes) {
    const record = await finishProbe(entry.probe);
    for (const target of ['target', 'parent']) {
      assert.equal(record.exit[target].state, 'exited');
      assert.equal(record.exit[target].wait_status, 0);
      assert.equal(record.exit[target].creation_time_100ns, target === 'target' ? entry.identity.creation_time_100ns : entry.parent.creation_time_100ns);
    }
    if (entry.role === 'cli' && expectedCliCode !== undefined) assert.equal(record.exit.target.exit_code, expectedCliCode);
    records.push({ role: entry.role, process: record });
  }
  family.record.actual_exits = records;
  family.record.all_observed_members_exited = true;
  family.record.peripheral_target_cleanup_used = false;
  return records;
}
