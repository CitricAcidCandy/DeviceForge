import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const root = resolve(source, '../../../../..');
const args = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.equal(args.length, 1);
assert.ok(args[0].startsWith('--binary='));
const originalBinary = resolve(args[0].slice(9));
const runId = randomUUID(), directory = join(root, 'artifacts', 'scoped-process-selfcheck-' + runId);
const snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const originalProbe = join(root, 'artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe');
const binary = join(snapshot, 'scoped-tool.exe'), probeBinary = join(snapshot, 'process-probe.exe');
const report = { schema: 1, timestamp: new Date().toISOString(), run_id: runId, passed: false,
  public_scope_verified: false, cases: [], scope: '原生真实多代夹具定点自检，不调用尚未实现的公共scoped API',
  limitations: ['独立回收器的test_kill:true不证明公共取消或Future丢弃清理',
    '管道证据为本机实际标准管道继承及EOF，不证明任意第三方程序的句柄策略',
    '仅本机Windows，不证明Unix/macOS、真机、插件服务或正式分发'] };

const canonical = value => toNamespacedPath(resolve(value)).toLowerCase();
async function identity(path) {
  const bytes = await readFile(path);
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function poll(run, label, maximum = 5000) {
  const started = performance.now();
  while (performance.now() - started < maximum) {
    const value = await run();
    if (value) return value;
    await delay(10);
  }
  throw new Error(label + '超时');
}
async function existsJson(path) {
  try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function processFor(executable, argumentsList) {
  const child = spawn(executable, argumentsList, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const value = { child, exited: null, closed: null, stdout: '', stderr: '' };
  child.stdout.on('data', bytes => { value.stdout += bytes.toString('utf8'); });
  child.stderr.on('data', bytes => { value.stderr += bytes.toString('utf8'); });
  child.once('exit', (code, signal) => { value.exited = { code, signal }; });
  value.done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { value.closed = { code, signal }; accept(value.closed); });
  });
  value.done.catch(() => {});
  return value;
}
async function closed(value, label) {
  await poll(() => value.closed, label, 7000);
  assert.ok(Buffer.byteLength(value.stdout) <= 65536 && Buffer.byteLength(value.stderr) <= 65536);
  return value.closed;
}
async function atomic(path, bytes = '1') {
  const pending = path + '.pending';
  await writeFile(pending, bytes, { flag: 'wx' }); await rename(pending, path);
}
async function release(context, role) {
  context.entry.releases.push({ role, timestamp: new Date().toISOString() });
  await atomic(join(context.directory, 'release-' + role));
}
async function observed(context, role) {
  const probe = context.probes.get(role);
  await atomic(probe.prefix + '.request');
  const value = await poll(() => existsJson(probe.prefix + '.observed.json'), '原生句柄状态快照');
  assert.equal(value.test_kill, false);
  context.entry.observations.push({ role, value });
  return value;
}
async function finishProbes(context, expectedCode = 0) {
  for (const [role, probe] of context.probes) {
    assert.deepEqual(await closed(probe.process, '原生观察器退出'), { code: 0, signal: null });
    const value = await json(probe.prefix + '.exit.json');
    assert.equal(value.test_kill, false);
    for (const item of [value.target, value.parent]) {
      assert.equal(item.state, 'exited'); assert.equal(item.wait_status, 0);
      assert.equal(item.exit_code, typeof expectedCode === 'number' ? expectedCode : expectedCode[item.pid]);
    }
    context.entry.process_exits.push({ role, value });
  }
  const launcherCode = typeof expectedCode === 'number' ? expectedCode : expectedCode[context.identities.get('launcher').pid];
  assert.deepEqual(await closed(context.launcher, '自检启动器退出及EOF'), { code: launcherCode, signal: null });
  context.entry.launcher_exit = context.launcher.exited;
  context.entry.launcher_close = context.launcher.closed;
  context.entry.stdout = context.launcher.stdout;
  context.entry.stderr = context.launcher.stderr;
}
async function recover(context) {
  const records = [...context.identities.values()];
  await writeFile(join(context.directory, 'owned.tsv'), records.map(value =>
    [value.pid, value.creation_time_100ns, value.role].join('\t')).join('\n'), { flag: 'wx' });
  const process = processFor(binary, ['--evidence', context.directory, '--nonce', context.nonce, '--role', 'recover']);
  const outcome = await closed(process, '独立精确身份回收器');
  context.entry.recovery_attempts ??= [];
  context.entry.recovery_attempts.push({ pid: process.child.pid, outcome, stdout: process.stdout, stderr: process.stderr });
  assert.deepEqual(outcome, { code: 0, signal: null });
  context.entry.recovery = await json(join(context.directory, 'recovery.json'));
  assert.equal(context.entry.recovery.public_scope_verified, false);
}
async function prepare(name, { pipe = 'closed', delayMs = 0, scenario = 'tree', rootExitCode = 0 } = {}) {
  const caseDirectory = join(directory, name); await mkdir(caseDirectory);
  const nonce = randomUUID(); await writeFile(join(caseDirectory, 'owner'), nonce, { flag: 'wx' });
  const entry = { name, nonce, directory: caseDirectory, passed: false, releases: [], identities: [],
    probe_ready: [], observations: [], process_exits: [], public_scope_verified: false };
  report.cases.push(entry);
  const context = { entry, directory: caseDirectory, nonce, identities: new Map(), probes: new Map() };
  context.launcher = processFor(binary, ['--evidence', caseDirectory, '--nonce', nonce, '--role', 'launcher',
    '--parent-pid', String(process.pid), '--scenario', scenario, '--pipe', pipe, '--delay-ms', String(delayMs),
    '--root-exit-code', String(rootExitCode)]);
  context.roles = scenario === 'tree' ? ['launcher', 'root', 'child', 'grandchild'] : ['launcher', 'root'];
  report.active_case = name;
  activeContext = context;
  for (const role of context.roles) {
    const value = await poll(() => existsJson(join(caseDirectory, 'ready-' + role + '.json')), '真实角色就绪');
    assert.equal(value.nonce, nonce); assert.equal(value.role, role);
    assert.equal(canonical(value.exe), canonical(binary)); assert.match(value.creation_time_100ns, /^\d{16,20}$/);
    assert.ok(value.pid > 0 && Number.isSafeInteger(value.pid));
    assert.ok(!entry.identities.some(item => item.pid === value.pid));
    context.identities.set(role, value); entry.identities.push(value);
  }
  for (let index = 1; index < context.roles.length; index++) {
    const role = context.roles[index], parent = context.identities.get(context.roles[index - 1]);
    const target = context.identities.get(role);
    assert.equal(target.parent_pid, parent.pid); assert.deepEqual(parent.children, [target.pid]);
    const prefix = join(caseDirectory, 'probe-' + role);
    const process = processFor(probeBinary, ['--pid', String(target.pid), '--evidence', prefix,
      '--parent-pid', String(parent.pid), '--expected-parent', binary]);
    const probe = { prefix, process }; context.probes.set(role, probe);
    const value = await poll(() => existsJson(prefix + '.ready.json'), '真实目标及父句柄就绪');
    for (const [actual, expected] of [[value.target, target], [value.parent, parent]]) {
      assert.equal(actual.pid, expected.pid); assert.equal(actual.creation_time_100ns, expected.creation_time_100ns);
      assert.equal(canonical(actual.exe), canonical(binary)); assert.equal(actual.state, 'running');
    }
    assert.equal(value.parent_pid_checked, true); assert.equal(value.parent_path_checked, true);
    entry.probe_ready.push({ role, value });
  }
  return context;
}

let activeContext;

try {
  const inputPaths = [originalBinary, originalProbe, process.execPath, fileURLToPath(import.meta.url),
    join(root, 'scripts/harmony-screenshot-smoke/process-probe.rs'),
    ...(await readdir(source)).filter(name => name.endsWith('.rs')).map(name => join(source, name))];
  report.inputs_before = await Promise.all(inputPaths.map(identity));
  for (const [original, target] of [[originalBinary, binary], [originalProbe, probeBinary]]) {
    await copyFile(original, target);
    assert.equal((await identity(original)).sha256, (await identity(target)).sha256);
  }
  report.snapshots = await Promise.all([binary, probeBinary].map(identity));

  const parentFirst = await prepare('parent-first');
  await release(parentFirst, 'root'); await release(parentFirst, 'launcher');
  assert.deepEqual(await closed(parentFirst.probes.get('root').process, '父先退出原生确认'), { code: 0, signal: null });
  const childLive = await observed(parentFirst, 'child');
  assert.equal(childLive.target.state, 'running'); assert.equal(childLive.parent.state, 'exited');
  const grandchildLive = await observed(parentFirst, 'grandchild');
  assert.equal(grandchildLive.target.state, 'running'); assert.equal(grandchildLive.parent.state, 'running');
  await release(parentFirst, 'grandchild'); await release(parentFirst, 'child');
  await finishProbes(parentFirst); parentFirst.entry.passed = true; activeContext = null;

  const orphaned = await prepare('recover-after-parent-exit');
  await release(orphaned, 'root'); await release(orphaned, 'launcher');
  assert.deepEqual(await closed(orphaned.probes.get('root').process, '回收前父退出真实确认'), { code: 0, signal: null });
  await recover(orphaned);
  const codes = Object.fromEntries(orphaned.entry.identities.map(value =>
    [value.pid, ['child', 'grandchild'].includes(value.role) ? 73 : 0]));
  for (const value of orphaned.entry.recovery.processes) {
    if (['child', 'grandchild'].includes(value.role)) {
      assert.equal(value.handle_acquired, true); assert.equal(value.test_kill, true); assert.equal(value.exit_code, 73);
    } else {
      assert.equal(value.test_kill, false);
      if (value.handle_acquired) assert.equal(value.exit_code, 0); else assert.equal(value.os_exit_confirmed, false);
    }
  }
  await finishProbes(orphaned, codes); orphaned.entry.passed = true; activeContext = null;

  const generations = await prepare('two-generations');
  for (const role of ['grandchild', 'child', 'root', 'launcher']) await release(generations, role);
  await finishProbes(generations); generations.entry.passed = true; activeContext = null;

  const nonzero = await prepare('nonzero-root', { rootExitCode: 7 });
  for (const role of ['grandchild', 'child', 'root', 'launcher']) await release(nonzero, role);
  await finishProbes(nonzero, Object.fromEntries(nonzero.entry.identities.map(value => [value.pid, value.role === 'root' ? 7 : 0])));
  nonzero.entry.passed = true; activeContext = null;

  for (const name of ['cancel-ready', 'drop-ready']) {
    const context = await prepare(name);
    context.entry.pending_public_validation = name === 'cancel-ready' ? '公共API取消清理待接线' : '公共API丢弃Future清理待接线';
    await recover(context);
    assert.equal(context.entry.recovery.processes.length, 4);
    for (const value of context.entry.recovery.processes) {
      assert.equal(value.handle_acquired, true); assert.equal(value.test_kill, true); assert.equal(value.exit_code, 73);
    }
    await finishProbes(context, 73); context.entry.passed = true; activeContext = null;
  }

  const late = await prepare('late-exit', { delayMs: 500 });
  for (const role of ['grandchild', 'child', 'root', 'launcher']) await release(late, role);
  assert.deepEqual(await closed(late.probes.get('root').process, '迟到场景父退出'), { code: 0, signal: null });
  const pendingLeaf = await observed(late, 'grandchild');
  assert.equal(pendingLeaf.target.state, 'running'); assert.equal(pendingLeaf.parent.state, 'exited');
  await finishProbes(late);
  const leaf = late.entry.process_exits.find(value => value.role === 'grandchild').value.target;
  const releasedLeaf = late.entry.releases.find(value => value.role === 'grandchild');
  assert.ok(Date.parse(leaf.exit_timestamp) - Date.parse(releasedLeaf.timestamp) >= 450);
  late.entry.passed = true; activeContext = null;

  const pipes = await prepare('inherited-pipes', { pipe: 'inherit' });
  for (const role of pipes.roles) {
    const handles = await json(join(pipes.directory, 'handles-' + role + '.json'));
    assert.equal(handles.find(value => value.name === 'stdout').type, 3);
    pipes.entry.standard_handles ??= []; pipes.entry.standard_handles.push({ role, handles });
  }
  await release(pipes, 'root'); await release(pipes, 'launcher');
  await poll(() => pipes.launcher.exited, '管道场景启动器实际退出');
  await delay(150); assert.equal(pipes.launcher.closed, null);
  pipes.entry.eof_delayed_after_parent_exit_ms = 150;
  const heldPipe = await observed(pipes, 'grandchild');
  assert.equal(heldPipe.target.state, 'running'); assert.equal(heldPipe.parent.state, 'running');
  await release(pipes, 'grandchild'); await release(pipes, 'child');
  await finishProbes(pipes);
  assert.deepEqual(pipes.launcher.stdout.trim().split('\n').sort(), pipes.roles.map(role =>
    'DF_SCOPED:' + role + ':' + pipes.nonce).sort());
  assert.equal(pipes.launcher.stderr, ''); pipes.entry.passed = true; activeContext = null;

  const breakaway = await prepare('breakaway-denied', { scenario: 'breakaway' });
  breakaway.entry.breakaway = await json(join(breakaway.directory, 'breakaway.json'));
  assert.deepEqual(breakaway.entry.breakaway, { schema: 1, explicit_job_member: true, creation_flags: 16777216,
    private_job_added: true, ambient_job_member: true,
    create_process_succeeded: false, raw_os_error: 5, unexpected_child_pid: null,
    unexpected_child_reaped: false, public_scope_verified: false });
  await release(breakaway, 'root'); await release(breakaway, 'launcher');
  await finishProbes(breakaway); breakaway.entry.passed = true; activeContext = null;

  report.inputs_after = await Promise.all(inputPaths.map(identity));
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.snapshots_after = await Promise.all([binary, probeBinary].map(identity));
  assert.deepEqual(report.snapshots_after, report.snapshots);
  assert.equal(report.cases.length, 9); assert.ok(report.cases.every(value => value.passed));
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, code: error.code, message: error.message,
    locations: error.stack?.split('\n').filter(line => line.includes(' at ')).slice(0, 4) };
} finally {
  if (activeContext) {
    try {
      await recover(activeContext);
      await finishProbes(activeContext, 73);
      report.failure_recovery_completed = true;
    } catch (error) {
      report.failure_recovery = { name: error.name, message: error.message };
      for (const role of activeContext.roles) {
        try { await release(activeContext, role); } catch {}
      }
      for (const probe of activeContext.probes.values()) await closed(probe.process, '失败回收后原生观察器收口').catch(() => {});
      await closed(activeContext.launcher, '失败回收后启动器收口').catch(() => {});
    }
  }
  report.completed_at = new Date().toISOString();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: join(directory, 'report.json'), passed: report.passed,
    cases: report.cases.length, native_roles: report.cases.reduce((total, value) => total + value.identities.length, 0) }));
}
if (!report.passed) process.exitCode = 1;
