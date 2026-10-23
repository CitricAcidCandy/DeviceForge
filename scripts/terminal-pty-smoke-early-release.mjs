import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { powershellArguments, prepareHost, reservePort } from './terminal-pty-smoke/host.mjs';
import { message, open, output } from './terminal-pty-smoke/cases.mjs';
import { poll } from './terminal-interactive-smoke/cases.mjs';
import { windowsObservation } from './terminal-pty-smoke/windows.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';

// 单个独占宿主中按短延时释放；首次失败即停止，不掩盖启动阶段的清理失败。
const root = fileURLToPath(new URL('../', import.meta.url));
const [sourceHost, sourcePlugin, mode = 'plain'] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.ok(sourceHost && sourcePlugin && isAbsolute(sourceHost) && isAbsolute(sourcePlugin));
assert.ok(['plain', 'resize'].includes(mode), '第三参数只允许plain或resize');
const directory = resolve(join(root, 'artifacts/terminal-pty-20261022', 'early-release-' + randomUUID()));
const snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = { started_at: new Date().toISOString(), directory, mode, passed: false, cases: [], requests: [],
  scope: '冻结独占宿主与PowerShell ConPTY，0/25/75/150ms公开release；不操作7031、设备或模型任务' };
let host;
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
async function completionLog(id) {
  const logs = join(directory, 'data', 'logs');
  const files = (await readdir(logs)).filter(name => name.endsWith('.jsonl'));
  const records = (await Promise.all(files.map(name => readFile(join(logs, name), 'utf8'))))
    .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
  return records.find(record => record.fields?.session_id === id && record.fields?.message === '交互会话已结束');
}
try {
  const sources = [sourceHost, sourcePlugin, join(root, 'backend/plugins/terminal/manifest.json')];
  report.inputs_before = await Promise.all(sources.map(fileIdentity));
  for (const [index, name] of ['apk-server.exe', 'deviceforge-terminal-plugin.exe', 'manifest.json'].entries()) {
    await copyFile(sources[index], join(snapshot, name));
    assert.equal((await fileIdentity(join(snapshot, name))).sha256, report.inputs_before[index].sha256);
  }
  host = await prepareHost({ root, binary: join(snapshot, 'apk-server.exe'), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready(); report.base = host.client.base;
  const plugin = join(host.plugins, 'terminal'), work = join(directory, 'workspace');
  await mkdir(plugin); await mkdir(work);
  const profiles = { powershell: { executable: 'powershell.exe', directory: work,
    args: powershellArguments(directory), resource_scope: 'direct_process' } };
  const config = join(plugin, 'terminal.config.json');
  await writeFile(config, JSON.stringify({ format_version: 1, profiles }), { flag: 'wx' });
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  manifest.executable = join(snapshot, 'deviceforge-terminal-plugin.exe'); manifest.args = ['--config', config];
  manifest.configuration.defaults = { format_version: 1, profiles };
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  await host.client.post('/api/v2/plugins/terminal/load');
  let generation;
  for (const waitMs of [0, 25, 75, 150]) {
    const entry = { delay_ms: waitMs, started_at: new Date().toISOString(), passed: false };
    report.cases.push(entry);
    entry.open_response = await open(host, 'powershell', { protocol: 'deviceforge.terminal.v1', cols: 80, rows: 24 });
    entry.id = entry.open_response.id;
    if (generation) assert.equal(entry.open_response.generation, generation, '连续准入须保持原插件代次');
    generation = entry.open_response.generation;
    const openReturned = performance.now();
    if (mode === 'resize') {
      entry.resize_response = await message(host, entry.id, { type: 'resize', cols: 134, rows: 26 });
      entry.resize_completed_after_open_ms = performance.now() - openReturned;
    }
    const elapsed = performance.now() - openReturned;
    if (elapsed < waitMs) await delay(waitMs - elapsed);
    entry.release_started_at = new Date().toISOString();
    entry.actual_release_after_open_ms = performance.now() - openReturned;
    entry.release_response = await host.client.post(`/api/v2/sessions/${entry.id}/release`, undefined, { status: 202 });
    await save();
    const ending = await poll(async () => {
      const reply = await host.client.call(`/api/v2/sessions/${entry.id}`);
      entry.last_session_response = reply;
      if (reply.status === 404) {
        assert.equal(reply.body.error?.code, 'not_found');
        entry.completion_log = await completionLog(entry.id);
        return entry.completion_log ? { removed: true } : null;
      }
      assert.equal(reply.status, 200);
      return reply.body.data?.status === 'finished' ? { final: reply.body.data } : null;
    }, Boolean, '早期释放终态或确认清理后的自动删除', 20000);
    entry.final = ending.final;
    entry.removed = ending.removed ?? false;
    // 完整终态先落盘，后续断言或诊断失败均不能丢失具体错误。
    await save();
    if (entry.removed) {
      // release公开契约是Complete后自动删除；不能伪造已不存在的完整completion。
      assert.equal(entry.completion_log.fields.cleanup, 'Some(Complete)', '自动删除必须对应同会话Complete日志');
      entry.sessions_after_release = await host.client.json('/api/v2/sessions');
      assert.ok(!entry.sessions_after_release.some(value => value.id === entry.id));
    } else {
      entry.output = await host.client.json(`/api/v2/sessions/${entry.id}/output?after=0&limit=100`);
      await save();
      assert.equal(entry.final.completion.cleanup, 'complete', '早期释放必须确认整个终端作用域已清理');
      assert.equal(entry.final.completion.process_exited, true);
    }
    entry.plugin_after_release = (await host.client.json('/api/v2/plugins')).find(value => value.id === 'terminal');
    assert.equal(entry.plugin_after_release?.generation, generation);
    assert.equal(entry.plugin_after_release?.state, 'loaded');
    assert.equal(entry.plugin_after_release?.cleanup_failed, false);
    assert.equal(entry.plugin_after_release?.protected, false);
    entry.passed = true;
    await save();
  }
  report.reuse_session = await open(host, 'powershell');
  assert.equal(report.reuse_session.generation, generation, '最后一次释放后同代次仍须可运行真实终端');
  const stream = output(host, report.reuse_session.id);
  await stream.until(text => /PS [^\r\n]*>/.test(text), '早期释放后的同代次真实PowerShell就绪');
  await host.client.post(`/api/v2/sessions/${report.reuse_session.id}/cancel`);
  report.reuse_final = await poll(() => host.client.json(`/api/v2/sessions/${report.reuse_session.id}`), value => value.status === 'finished', '同代次复用终端清理完成');
  await save();
  assert.equal(report.reuse_final.completion.cleanup, 'complete');
  assert.equal(report.reuse_final.completion.process_exited, true);
  report.processes_after_reuse = (await windowsObservation(host.child.pid)).processes;
  assert.ok(!report.processes_after_reuse.some(value => /^powershell\.exe$/i.test(value.executable)), '终端全部结束后不得保留PowerShell进程');
  report.passed = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: String(error.stack).split('\n').slice(0, 8) };
} finally {
  if (host) {
    try { await host.finish(); }
    catch (error) { report.cleanup_failure = { name: error.name, message: error.message }; report.passed = false; }
    try { report.remaining_processes = (await windowsObservation(host.child.pid)).processes; }
    catch (error) { report.process_observation_failure = error.message; report.passed = false; }
    if (report.remaining_processes?.length) report.passed = false;
    report.log_ids = [...host.client.logIds];
  }
  report.inputs_after = await Promise.all([sourceHost, sourcePlugin].map(fileIdentity));
  report.completed_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ directory, passed: report.passed, cases: report.cases.map(entry => ({ delay_ms: entry.delay_ms, id: entry.id, passed: entry.passed, completion: entry.final?.completion })), failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
