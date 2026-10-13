import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { assertPidGone, echo, held, poll, stopped, toolPid } from './terminal-interactive-smoke/cases.mjs';
import { recordOpen, verifyLogs } from './terminal-interactive-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv.slice(2).every(argument => argument === '--release'));
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const runId = randomUUID();
const directory = join(root, 'artifacts', `terminal-interactive-service-${profile}-${runId}`);
const data = join(directory, 'data');
const snapshot = join(directory, 'snapshot');
const suffix = process.platform === 'win32' ? '.exe' : '';
const report = { timestamp: new Date().toISOString(), profile, run_id: runId, passed: false,
    checks: [], sessions: [], opened: [], requests: [],
    scope: '真实Rust HTTP/MCP、独立终端插件和Node工具；不含PTY、真机、派生树、浏览器或正式分发' };
await mkdir(snapshot, { recursive: true });
await mkdir(data, { recursive: true });
let host;
try {
    const sourceHost = join(root, 'backend/target', profile, 'apk-server' + suffix);
    const sourcePlugin = join(root, 'backend/target', profile, 'deviceforge-terminal-plugin' + suffix);
    const sourceManifest = join(root, 'backend/plugins/terminal/manifest.json');
    const sourceFixture = join(root, 'scripts/terminal-interactive-smoke/fixture.cjs');
    const sources = [sourceHost, sourcePlugin, sourceManifest, sourceFixture,
        fileURLToPath(import.meta.url), join(root, 'scripts/terminal-interactive-smoke/cases.mjs'),
        join(root, 'scripts/terminal-interactive-smoke/evidence.mjs')];
    const names = ['apk-server' + suffix, 'deviceforge-terminal-plugin' + suffix, 'manifest.json', 'fixture.cjs',
        'terminal-interactive-smoke.mjs', 'cases.mjs', 'evidence.mjs'];
    report.inputs_before = await Promise.all(sources.map(fileIdentity));
    for (let index = 0; index < sources.length; index++) {
        await copyFile(sources[index], join(snapshot, names[index]));
        const copied = await fileIdentity(join(snapshot, names[index]));
        assert.equal(copied.sha256, report.inputs_before[index].sha256);
    }
    host = await prepareHost({ root, binary: join(snapshot, names[0]), directory: data,
        report, port: await reservePort() });
    await host.ready();
    const empty = await host.client.tools();
    assert.ok(!empty.includes('plugin.terminal.open'));
    assert.deepEqual(await host.client.json('/api/v2/session-definitions'), { revision: 0, sessions: [] });
    const pluginDirectory = join(host.plugins, 'terminal');
    await mkdir(pluginDirectory);
    const config = join(pluginDirectory, 'terminal.config.json');
    const profiles = {};
    for (const [name, mode] of [['echo_http', 'echo'], ['echo_mcp', 'echo'], ['bad_exit', 'nonzero'],
        ['hold_cancel', 'hang'], ['hold_unload', 'hang'], ['hold_shutdown', 'hang']]) {
        profiles[name] = { executable: process.execPath,
            args: [join(snapshot, 'fixture.cjs'), mode, join(directory, `${name}.pid`)],
            resource_scope: 'direct_process' };
    }
    await writeFile(config, JSON.stringify({ format_version: 1, profiles }), { flag: 'wx' });
    const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json')));
    manifest.executable = join(snapshot, names[1]);
    manifest.args = ['--config', config];
    await writeFile(join(pluginDirectory, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
    const loaded = await host.client.post('/api/v2/plugins/terminal/load');
    assert.deepEqual(loaded.operations, []);
    assert.deepEqual(loaded.sessions, ['plugin.terminal.open']);
    assert.ok((await host.client.tools()).includes('plugin.terminal.open'));
    const definitions = await host.client.json('/api/v2/session-definitions');
    assert.equal(definitions.sessions[0].execution.total_timeout_ms, 3600000);
    assert.deepEqual(await host.client.tool('deviceforge.list_session_definitions', {}), definitions);
    report.checks.push({ name: '纯会话插件动态HTTP/MCP注册', passed: true });
    for (const mcp of [false, true]) {
        const name = mcp ? 'echo_mcp' : 'echo_http';
        const opened = mcp ? await host.client.tool('plugin.terminal.open', { profile: name })
            : await host.client.post('/api/v2/sessions', { operation: 'plugin.terminal.open', input: { profile: name } }, { status: 202 });
        assert.equal(opened.status, 'opening');
        assert.equal(opened.generation, loaded.generation);
        recordOpen(host, opened, report);
        await echo(host, opened.id, join(directory, `${name}.pid`), mcp, report);
    }
    const failed = await host.client.tool('plugin.terminal.open', { profile: 'bad_exit' });
    recordOpen(host, failed, report);
    const failedPid = await toolPid(join(directory, 'bad_exit.pid'));
    const failure = await poll(() => host.client.json(`/api/v2/sessions/${failed.id}`), info => info.status === 'finished', '非零退出');
    assert.equal(failure.completion.cleanup, 'complete');
    assert.match(failure.completion.outcome.error, /7/);
    await assertPidGone(failedPid);
    report.sessions.push({ id: failed.id, entry: '非零退出', pid: failedPid, pid_absent: true,
        cleanup: failure.completion.cleanup, output_sequence: failure.output_sequence });
    report.checks.push({ name: '非零工具真实退出及清理完成分离', passed: true });
    const cancelling = await held(host, 'hold_cancel', join(directory, 'hold_cancel.pid'), report);
    await host.client.tool('deviceforge.cancel_session', { id: cancelling.id });
    await stopped(host, cancelling, report, '显式取消并确认工具PID消失');
    const unloading = await held(host, 'hold_unload', join(directory, 'hold_unload.pid'), report);
    const unloaded = await host.client.post('/api/v2/plugins/terminal/unload');
    assert.equal(unloaded.state, 'unloaded');
    await stopped(host, unloading, report, '卸载等待真实会话结束');
    assert.ok(!(await host.client.tools()).includes('plugin.terminal.open'));
    assert.deepEqual((await host.client.json('/api/v2/session-definitions')).sessions, []);
    const reloaded = await host.client.tool('deviceforge.load_plugin', { id: 'terminal' });
    assert.notEqual(reloaded.generation, loaded.generation);
    assert.equal((await host.client.json(`/api/v2/sessions/${unloading.id}`)).generation, loaded.generation);
    assert.deepEqual(await host.client.tool('deviceforge.list_sessions', {}), await host.client.json('/api/v2/sessions'));
    report.checks.push({ name: '动态撤销、重载新代及旧记录保留', passed: true });
    assert.deepEqual(await host.client.tool('deviceforge.remove_session', { id: failed.id }), { id: failed.id });
    const shutdown = await held(host, 'hold_shutdown', join(directory, 'hold_shutdown.pid'), report);
    await host.shutdown();
    await assertPidGone(shutdown.pid);
    await host.verifyIdentity();
    report.sessions.push({ ...shutdown, entry: '宿主关闭', pid_absent: true });
    report.checks.push({ name: '宿主关闭收敛活动会话、exit0及端口释放', passed: true });
    report.inputs_after = await Promise.all(sources.map(fileIdentity));
    assert.deepEqual(report.inputs_after, report.inputs_before);
    report.log_ids = [...host.client.logIds];
    assert.ok(report.log_ids.length > 0);
    await verifyLogs(directory, host, report);
    report.passed = true;
} catch (error) {
    report.failure = { name: error.name, code: error.code, message: error.message,
        locations: String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6) };
} finally {
    if (host) {
        try { await host.finish(); }
        catch (error) { report.passed = false; report.cleanup_failure = { name: error.name, code: error.code }; }
    }
    report.completed_at = new Date().toISOString();
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length,
        sessions: report.sessions.length, failure: report.failure }));
    if (!report.passed) process.exitCode = 1;
}
