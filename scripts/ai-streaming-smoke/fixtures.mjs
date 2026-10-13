import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { poll } from '../device-provider/client.mjs';
import { fileIdentity } from '../unified-discovery-smoke/evidence.mjs';
import { finishPendingProbes, finishProbe, observeProbe, startProbe } from '../harmony-screenshot-smoke/fixtures.mjs';
import { deploymentCanary, prompt } from './contracts.mjs';

export { finishPendingProbes };

export async function prepareFixture(directory, source, label, threadId, mode = 'normal') {
  const root = join(directory, 'projects', label);
  await mkdir(root, { recursive: true });
  const actual = join(root, 'exec');
  await copyFile(source, actual);
  const plan = { thread_id: threadId, canary: deploymentCanary, mode };
  const planPath = join(root, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan), { flag: 'wx' });
  const packagePath = join(root, 'package.json');
  await writeFile(packagePath, JSON.stringify({ private: true, type: 'commonjs' }), { flag: 'wx' });
  const before = await fileIdentity(source), copied = await fileIdentity(actual);
  assert.equal(before.sha256, copied.sha256);
  return { root, label, threadId, mode, calls: [], files: [copied, await fileIdentity(planPath), await fileIdentity(packagePath)] };
}

export async function readyCall(context, fixture, ordinal = 1, resumed = false, entry) {
  const directory = join(fixture.root, 'call-' + String(ordinal).padStart(2, '0'));
  const ready = await poll(async () => {
    try { return JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (entry) {
        const session = await context.host.client.json(`/api/v2/sessions/${entry.id}`);
        if (session.status === 'finished') {
          entry.pretool_failure = session;
          throw new Error('AI工具未启动即结束：' + (session.completion.outcome?.error ?? session.completion.failure?.code));
        }
      }
      return null;
    }
  }, Boolean, 'AI工具进程就绪');
  assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0);
  assert.ok(Number.isSafeInteger(ready.parent_pid) && ready.parent_pid > 0);
  assert.equal(normalize(ready.cwd).toLowerCase(), normalize(fixture.root).toLowerCase());
  assert.deepEqual(ready.argv, [join(fixture.root, 'exec'), ...(resumed
    ? ['resume', '--json', fixture.threadId] : ['--json']), '--public-fixture-arg', '-']);
  assert.equal(ready.deployment_present, true);
  assert.equal(ready.host_canary_present, false);
  assert.equal(ready.host_api_key_present, false);
  await poll(async () => {
    try { return (await lstat(join(directory, 'stdin-eof'))).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, Boolean, 'Open提示词发送后关闭工具stdin');
  assert.deepEqual(await readFile(join(directory, 'prompt.bin')), Buffer.from(prompt));
  const probe = await startProbe(context.probeBinary, ready.pid, join(directory, 'process'), context.pluginBinary);
  assert.equal(probe.ready.parent.pid, ready.parent_pid);
  assert.equal(probe.ready.target.state, 'running');
  assert.equal(probe.ready.parent.state, 'running');
  const call = { directory, ready, probe, fixture };
  fixture.calls.push(call);
  context.report.tools.push({ project_id: fixture.label, ordinal, ...ready,
    prompt: await fileIdentity(join(directory, 'prompt.bin')), probe_ready: probe.ready });
  return call;
}

export async function release(call, name) {
  assert.ok(['start', 'continue', 'exit'].includes(name));
  await writeFile(join(call.directory, name), '1', { flag: 'wx' });
}

export async function observeRunning(call) {
  const observed = await observeProbe(call.probe);
  assert.equal(observed.target.state, 'running');
  assert.equal(observed.parent.state, 'running');
  return observed;
}

export async function finishCall(context, call, expectedCode) {
  let timeout;
  try {
    const processEvidence = await Promise.race([finishProbe(call.probe), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('AI直接工具与插件退出确认超时')), 8000);
    })]);
    assert.equal(processEvidence.exit.target.state, 'exited');
    assert.equal(processEvidence.exit.parent.state, 'exited');
    assert.equal(processEvidence.exit.parent.exit_code, 0);
    if (expectedCode !== undefined) assert.equal(processEvidence.exit.target.exit_code, expectedCode);
    const entry = context.report.tools.find(value => value.pid === call.ready.pid);
    entry.process = processEvidence;
    entry.actual_files = await Promise.all(['ready.json', 'prompt.bin', 'stdin-eof'].map(name => fileIdentity(join(call.directory, name))));
    return processEvidence;
  } finally { clearTimeout(timeout); }
}

export async function assertNoCalls(fixture) {
  assert.deepEqual((await readdir(fixture.root)).filter(name => /^call-\d+$/.test(name)), []);
}

export async function snapshot(fixture, stateRoot) {
  return JSON.parse(await readFile(join(stateRoot, 'threads', fixture.threadId + '.json'), 'utf8'));
}

export async function assertSnapshot(fixture, stateRoot, { turns, uncertain, closed = false }) {
  const value = await snapshot(fixture, stateRoot);
  assert.equal(value.format_version, 1);
  assert.equal(value.project_id, fixture.label);
  assert.equal(value.thread_id, fixture.threadId);
  assert.equal(value.turns, turns);
  assert.equal(value.uncertain, uncertain);
  assert.equal(value.closed, closed);
  return value;
}
