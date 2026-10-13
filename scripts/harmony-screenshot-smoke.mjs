import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { catalog } from './harmony-screenshot-smoke/contracts.mjs';
import { prepareDeployment, publishAndValidate, verifyDeployment } from './harmony-screenshot-smoke/deployment.mjs';
import { discover, inputErrors, knownFailure, normalEntries, ordinaryOutput } from './harmony-screenshot-smoke/cases.mjs';
import { cleanReload, controlStage, lateResource, leftoverResource, owner, plugins, queuedUnload, sharedLocks } from './harmony-screenshot-smoke/lifecycle.mjs';
import { finishPendingProbes } from './harmony-screenshot-smoke/fixtures.mjs';
import { failure, inputManifest, reportFor, retain, verifyLogs, writeReport } from './harmony-screenshot-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), entry = fileURLToPath(import.meta.url);
const parameters = new Map(); let profile = 'debug', selected = 'all';
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === '--release') { assert.equal(profile, 'debug'); profile = 'release'; }
  else if (name === '--case') {
    selected = args[++index]; assert.ok(['normal', 'cancel', 'deadline', 'late', 'leftover', 'queued', 'all'].includes(selected));
  } else {
    assert.ok(['--snapshot-root', '--tool-binary', '--probe-binary'].includes(name));
    const value = args[++index]; assert.ok(value && isAbsolute(value) && !parameters.has(name)); parameters.set(name, resolve(value));
  }
}
for (const name of ['--snapshot-root', '--tool-binary', '--probe-binary']) assert.ok(parameters.has(name), '缺少冻结输入 ' + name);
const snapshot = parameters.get('--snapshot-root'), toolBinary = parameters.get('--tool-binary'), probeBinary = parameters.get('--probe-binary');
const source = join(snapshot, 'backend/plugins/harmony-device');
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = join(snapshot, 'backend/target', profile, 'apk-server' + suffix);
const report = reportFor(profile);
report.selection = selected; report.snapshot_root = snapshot;
const inputs = [binary, join(snapshot, 'backend/target', profile, 'deviceforge-harmony-device-plugin' + suffix),
  join(snapshot, 'backend/target', profile, 'validate-plugin' + suffix), toolBinary, probeBinary, process.execPath,
  ...['manifest.json', 'manifest.example.json', 'aliases.example.json', 'README.md'].map((name) => join(source, name)),
  join(root, 'backend/plugins/harmony-device/tests/fixtures/hdc.rs'),
  join(root, 'backend/plugins/harmony-device/tests/fixtures/screenshot.rs'),
  join(root, 'scripts/harmony-screenshot-smoke/process-probe.rs')];
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-harmony-screenshot-')); report.temporary_root = temporary;
let completed = false;

async function round(name, run) {
  const current = reportFor(profile); current.round = name; report.rounds.push(current);
  const directory = join(temporary, name); await mkdir(directory);
  const options = { directory, toolBinary, probeBinary };
  let host, deployment, ready = false;
  console.log(JSON.stringify({ phase: '开始', round: name }));
  try {
    current.stage = '冻结版本独占部署及空宿主';
    deployment = await prepareDeployment({ root: snapshot, directory, profile, report: current, source });
    host = await prepareHost({ root, binary, directory: join(directory, 'data'),
      bindingsPath: deployment.bindingsPath, report: current, port: await reservePort() });
    await host.ready(); ready = true; await plugins(host);
    await catalog(host, deployment, current, '空宿主', false);
    await publishAndValidate(deployment, current);
    const loaded = owner(await host.client.post('/api/v2/plugins/harmony-device/load'), deployment, undefined, 'loaded');
    await plugins(host, loaded); await catalog(host, deployment, current, '首代加载', true, loaded);
    current.stage = '发现两设备及八availability'; await discover(host, deployment, current, options);
    current.stage = name; await run(host, deployment, current, options);
    current.stage = '正常退出、关联日志与冻结部署稳定';
    await host.shutdown(); await host.verifyIdentity(); await verifyLogs(directory, host, current);
    await verifyDeployment(deployment, current); current.passed = true; current.stage = '完成';
  } catch (error) {
    failure(current, error);
  } finally {
    if (host) try { await host.finish(); } catch (error) { failure(current, error, '自有宿主退出'); }
    try { await finishPendingProbes(current); } catch (error) { failure(current, error, '自有探针收尾'); }
    current.ready = ready; current.completed_at = new Date().toISOString();
    console.log(JSON.stringify({ phase: '终态', round: name, passed: current.passed, jobs: current.jobs.length,
      metadata_jobs: current.metadata_jobs.length, failure: current.failure }));
  }
}

try {
  report.stage = '冻结输入'; report.inputs_before = await inputManifest(entry, inputs);
  if (['normal', 'all'].includes(selected)) await round('normal', async (host, deployment, current, options) => {
    await normalEntries(host, deployment, current, options);
    await inputErrors(host, deployment, current, options);
    await sharedLocks(host, deployment, current, options);
    await knownFailure(host, deployment, current, options);
    await ordinaryOutput(host, deployment, current, options);
    await cleanReload(host, deployment, current, options);
  });
  if (['cancel', 'all'].includes(selected)) for (let ordinal = 1; ordinal <= 5; ordinal++) {
    await round('cancel-' + ordinal, (host, deployment, current, options) => controlStage(host, deployment, current, options, ordinal));
  }
  if (['deadline', 'all'].includes(selected)) for (let ordinal = 1; ordinal <= 5; ordinal++) {
    await round('deadline-' + ordinal, (host, deployment, current, options) => controlStage(host, deployment, current, options, ordinal, true));
  }
  if (['late', 'all'].includes(selected)) for (const mode of ['directory', 'writer', 'reader']) {
    await round('late-' + mode, (host, deployment, current, options) => lateResource(host, deployment, current, options, mode));
  }
  if (['leftover', 'all'].includes(selected)) {
    await round('leftover', (host, deployment, current, options) => leftoverResource(host, deployment, current, options));
  }
  if (['queued', 'all'].includes(selected)) {
    await round('queued-unload', (host, deployment, current, options) => queuedUnload(host, deployment, current, options));
  }
  report.inputs_after = await inputManifest(entry, inputs); assert.deepEqual(report.inputs_after, report.inputs_before);
  report.inputs_stable = true; completed = report.rounds.length > 0 && report.rounds.every((current) => current.passed);
} catch (error) {
  failure(report, error);
} finally {
  try { await retain(temporary, report); } catch (error) { failure(report, error, '原件索引'); }
  report.passed = completed && !report.failure; report.stage = report.passed ? '完成' : '按各独立轮次失败汇总';
  report.jobs_count = report.rounds.reduce((count, current) => count + current.jobs.length, 0);
  report.metadata_jobs_count = report.rounds.reduce((count, current) => count + current.metadata_jobs.length, 0);
  report.tools_count = report.rounds.reduce((count, current) => count + current.jobs.reduce((sum, job) => sum + (job.tools?.length ?? 0), 0), 0);
  const path = await writeReport(root, report);
  console.log(JSON.stringify({ passed: report.passed, report: path, rounds: report.rounds.length,
    jobs: report.jobs_count, tools: report.tools_count, failures: report.rounds.filter((current) => !current.passed).map((current) => current.failure) }));
  if (!report.passed) process.exitCode = 1;
}
