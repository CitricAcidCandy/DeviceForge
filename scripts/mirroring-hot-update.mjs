import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const argumentsList = process.argv.slice(2);
const allowed = ['--plugin=', '--manifest=', '--deployment=', '--base-url='];
assert.ok(argumentsList.every((argument) => allowed.some((prefix) => argument.startsWith(prefix))));
for (const prefix of allowed) assert.ok(argumentsList.filter((argument) => argument.startsWith(prefix)).length <= 1);
const option = (prefix) => argumentsList.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const plugin = resolve(option('--plugin=') ?? 'backend/target/debug/deviceforge-mirroring-plugin.exe');
const manifestSource = resolve(option('--manifest=') ?? 'backend/plugins/mirroring/manifest.json');
const deployment = await realpath(resolve(option('--deployment=') ?? 'artifacts/device-workspace-preview-20261014/plugins/mirroring'));
const origin = new URL(option('--base-url=') ?? 'http://127.0.0.1:7031');
assert.equal(origin.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(origin.hostname));
const port = Number(origin.port || 80);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
assert.equal(process.platform, 'win32');
const reportDirectory = resolve('artifacts', `mirroring-hot-update-${randomUUID()}`);
await mkdir(reportDirectory, { recursive: true });
const report = { timestamp: new Date().toISOString(), passed: false, requests: [], checks: [], deployment, backups: reportDirectory };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
async function hostPid() {
  const result = await execute('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${port}).OwningProcess | Select-Object -Unique`], { windowsHide: true, timeout: 15000 });
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, '必须取得唯一监听宿主进程');
  return pid;
}
async function request(path, method = 'GET') {
  const response = await fetch(new URL(path, origin), { method, signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  report.requests.push({ path, method, status: response.status, log_id: value.log_id ?? null });
  if (!response.ok) throw new Error(`${path}: ${value.error?.message ?? response.status}`);
  return value.data;
}
async function unchangedHost() {
  assert.equal(await hostPid(), report.host_pid_before, '热更新不得重启宿主');
}
let unloaded = false;
let replaced = false;
let target;
let manifestPath;
let stagedBinary;
let stagedManifest;
try {
  report.host_pid_before = await hostPid();
  const plugins = await request('/api/v2/plugins');
  const current = plugins.find((entry) => entry.id === 'mirroring');
  assert.equal(current?.state, 'loaded');
  assert.equal(current.cleanup_failed, false);
  assert.equal(current.protected, false);
  report.generation_before = current.generation;
  const sessions = await request('/api/v2/sessions');
  assert.ok(!sessions.some((session) => session.plugin_id === 'mirroring' && session.status !== 'finished'), '活动投屏必须先释放');
  manifestPath = join(deployment, 'manifest.json');
  const previousBytes = await readFile(manifestPath);
  const previous = JSON.parse(previousBytes.toString('utf8'));
  assert.equal(previous.id, 'mirroring');
  target = await realpath(previous.executable);
  assert.ok(target.toLowerCase().startsWith((deployment + '\\').toLowerCase()), '仅允许更新当前部署目录内的插件入口');
  assert.equal(dirname(target).toLowerCase(), join(deployment, 'bin').toLowerCase());
  const updated = JSON.parse(await readFile(manifestSource, 'utf8'));
  assert.equal(updated.id, 'mirroring');
  assert.ok(updated.sessions.operations.some((entry) => entry.name === 'open_webrtc'));
  assert.ok(updated.sessions.operations.some((entry) => entry.name === 'open'));
  updated.executable = previous.executable;
  updated.args = previous.args;
  const binary = await readFile(plugin);
  assert.equal(binary.subarray(0, 2).toString(), 'MZ');
  report.plugin_sha256 = digest(binary);
  report.previous_plugin_sha256 = digest(await readFile(target));
  await copyFile(target, join(reportDirectory, 'previous-plugin.exe'));
  await copyFile(manifestPath, join(reportDirectory, 'previous-manifest.json'));
  stagedBinary = join(dirname(target), `mirroring-${randomUUID()}.pending`);
  stagedManifest = join(deployment, `manifest-${randomUUID()}.pending`);
  await writeFile(stagedBinary, binary, { flag: 'wx' });
  await writeFile(stagedManifest, JSON.stringify(updated, null, 2) + '\n', { flag: 'wx' });
  const stopped = await request('/api/v2/plugins/mirroring/unload', 'POST');
  assert.equal(stopped.state, 'unloaded');
  assert.equal(stopped.cleanup_failed, false);
  unloaded = true;
  await unchangedHost();
  await rename(stagedBinary, target);
  replaced = true;
  await rename(stagedManifest, manifestPath);
  const loaded = await request('/api/v2/plugins/mirroring/load', 'POST');
  unloaded = false;
  assert.equal(loaded.state, 'loaded');
  assert.equal(loaded.cleanup_failed, false);
  assert.notEqual(loaded.generation, report.generation_before);
  assert.ok(loaded.sessions.includes('plugin.mirroring.open_webrtc'));
  assert.ok(loaded.sessions.includes('plugin.mirroring.open'));
  assert.equal(digest(await readFile(target)), report.plugin_sha256);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')), updated);
  report.generation_after = loaded.generation;
  await unchangedHost();
  assert.equal((await request('/api/v2/health')).status, 'ok');
  report.host_pid_after = await hostPid();
  report.checks.push('旧入口保留', '新增WebRTC贡献', '代次更新', '清理无失败', '宿主PID不变', '健康接口正常');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : '热更新失败';
  report.unloaded = unloaded;
  report.replaced = replaced;
  if (unloaded || replaced) {
    try {
      await unchangedHost();
      const current = (await request('/api/v2/plugins')).find((entry) => entry.id === 'mirroring');
      assert.equal(current?.cleanup_failed, false);
      assert.notEqual(current.state, 'draining');
      if (current.state === 'loaded') {
        const stopped = await request('/api/v2/plugins/mirroring/unload', 'POST');
        assert.equal(stopped.state, 'unloaded');
        assert.equal(stopped.cleanup_failed, false);
      }
      assert.ok(target && manifestPath);
      await copyFile(join(reportDirectory, 'previous-plugin.exe'), target);
      await copyFile(join(reportDirectory, 'previous-manifest.json'), manifestPath);
      const restored = await request('/api/v2/plugins/mirroring/load', 'POST');
      assert.equal(restored.state, 'loaded');
      assert.equal(restored.cleanup_failed, false);
      await unchangedHost();
      report.previous_deployment_restored = true;
    } catch (restoreError) {
      report.restore_error = restoreError instanceof Error ? restoreError.message : '旧插件恢复失败';
    }
  }
  process.exitCode = 1;
} finally {
  for (const staged of [stagedBinary, stagedManifest]) {
    if (staged) {
      try {
        await unlink(staged);
      } catch (error) {
        if (error.code !== 'ENOENT') report.staging_cleanup_error = error.message;
      }
    }
  }
  await writeFile(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, report: join(reportDirectory, 'report.json'), error: report.error ?? null }));
}
