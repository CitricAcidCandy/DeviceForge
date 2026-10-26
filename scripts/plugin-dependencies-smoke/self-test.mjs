// 仅验证夹具本身；本地下载源测试不是产品 HTTP/MCP 验收证据。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { archiveMembers } from '../plugin-releases/archive.mjs';
import { checkFixtures } from './check.mjs';
import './client-self-test.mjs';
import { targetPath } from './client.mjs';
import { assertView, digest, identity, tree } from './evidence.mjs';
import { component, dependency, prepareFixtures } from './fixtures.mjs';
import { environment } from './host.mjs';
import { options } from './options.mjs';
import { belongsToRun, listenerOwners, ownedProcesses, reclaim, sameProcess } from './processes.mjs';
import { listenerReleased, sourceServer } from './source.mjs';

async function temporary(run) {
  const root = await mkdtemp(join(tmpdir(), 'deviceforge-dependencies-self-test-'));
  try { await run(root); }
  finally {
    const absolute = await realpath(root), temporaryRoot = await realpath(tmpdir()), offset = relative(temporaryRoot, absolute);
    assert.ok(offset && !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)
      && basename(absolute).startsWith('deviceforge-dependencies-self-test-'), '自检清理路径必须位于明确临时根内');
    await rm(absolute, { recursive: true });
  }
}

test('参数不隐式消费共享 target，准备模式不要求宿主，重复或未知参数被拒绝', () => {
  assert.throws(() => options([]));
  assert.equal(options(['--prepare-only']).prepareOnly, true);
  assert.equal(options(['--binary-directory', '.']).binaryDirectory, process.cwd());
  assert.ok(options(['--binary-path', 'host.exe']).binaryPath.endsWith('host.exe'));
  assert.throws(() => options(['--binary-path', 'host.exe', '--binary-directory', '.']));
  assert.throws(() => options(['--prepare-only', '--binary-path', 'host.exe']));
  assert.throws(() => options(['--release']));
  assert.throws(() => options(['--binary-directory']));
  assert.throws(() => options(['--prepare-only', '--prepare-only']));
  assert.throws(() => options(['--output-directory', '--prepare-only']));
});

test('公开路径含目标类型，同名目标不会合并，视图契约拒绝错误状态与伪就绪', () => {
  const target = { kind: 'server', id: 'third_party' };
  assert.equal(targetPath(target), '/api/v2/plugin-dependencies/server/third_party');
  assert.notEqual(targetPath(target), targetPath({ ...target, kind: 'browser' }));
  assert.notEqual(targetPath(target), targetPath({ ...target, kind: 'release' }));
    const view = { target, revision: 'a'.repeat(64), dependencies: [], ready: true };
  assert.equal(assertView(view, target), view);
  const missing = { id: 'node', name: '工具', version_requirement: '*', required: true,
    status: 'missing', source: null, version: null, installable: true, message: null };
  assert.throws(() => assertView({ ...view, dependencies: [missing] }, target));
  assertView({ ...view, dependencies: [missing], ready: false }, target);
  assert.throws(() => assertView({ ...view, dependencies: [{ ...missing, status: 'success' }], ready: false }, target));
  assert.throws(() => assertView({ ...view, dependencies: [{ ...missing, status: 'ready' }] }, target));
  assert.throws(() => assertView({ ...view, target: { kind: 'browser', id: target.id } }, target));
  assert.throws(() => assertView({ ...view, revision: '不是摘要' }, target));
});

test('进程路径只是候选，必须同时归属驱动或已退出宿主，不能回收用户编辑器或兄弟根', () => {
  const root = 'G:\\验收\\run-1', created = '2026-10-26T01:00:01Z';
  const candidate = { ProcessId: 200, ParentProcessId: 100, CreatedAt: created,
    ExecutablePath: root + '\\host\\apk-server.exe', CommandLine: 'host.exe', Ancestry: [] };
  assert.equal(belongsToRun(candidate, root, [], 100), true);
  assert.equal(belongsToRun({ ...candidate, ParentProcessId: 99 }, root, [], 100), false);
  assert.equal(belongsToRun({ ...candidate, ExecutablePath: root + '-other\\host.exe' }, root, [], 100), false);
  assert.equal(belongsToRun({ ...candidate, ExecutablePath: 'C:\\node.exe', CommandLine: `node "${root}\\plugin.mjs"` }, root, [], 100), true);
  assert.equal(belongsToRun({ ...candidate, ExecutablePath: 'C:\\editor.exe', ParentProcessId: 99,
    CommandLine: `editor "${root}\\report.json"` }, root, [], 100), false);
  const host = { pid: 100, started_at: '2026-10-26T01:00:00Z', exit: { at: '2026-10-26T01:00:02Z' } };
  assert.equal(belongsToRun(candidate, root, [host], 999), true);
  assert.equal(belongsToRun({ ...candidate, CreatedAt: '2026-10-26T01:00:03Z' }, root, [host], 999), false);
  assert.equal(belongsToRun({ ...candidate, CreatedAt: '2026-10-26T00:59:59Z' }, root, [host], 999), false);
  assert.equal(belongsToRun({ ...candidate, ParentProcessId: 50,
    Ancestry: { ProcessId: 50, ParentProcessId: 100 } }, root, [], 100), true);
});

test('宿主环境独立用户根和插件目录，不继承在线服务配置、令牌或代理', () => {
  const keys = ['APK_API_TOKEN', 'DEVICEFORGE_USER_DIR', 'HTTP_PROXY', 'DF_DEPENDENCY_OLD'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = '本轮自检哨兵';
    const env = environment(join(tmpdir(), 'dependency-environment'), 12345, 'http://127.0.0.1:12346', 'X:/fixture/node.exe');
    assert.equal(env.APK_API_TOKEN, undefined); assert.equal(env.HTTP_PROXY, undefined); assert.equal(env.DF_DEPENDENCY_OLD, undefined);
    assert.ok(env.DEVICEFORGE_USER_DIR.endsWith(join('user', '.deviceforge')));
    assert.notEqual(env.APK_DATA_DIR, env.DEVICEFORGE_USER_DIR);
    assert.equal(env.APK_BIND, '127.0.0.1:12345'); assert.equal(env.DF_DEPENDENCY_NODE, 'X:/fixture/node.exe');
    const cold = environment(join(tmpdir(), 'dependency-cold'), 12345, 'http://127.0.0.1:12346', undefined, { bootstrapNode: false });
    assert.equal(cold.DEVICEFORGE_NODE, undefined); assert.equal(cold.DF_DEPENDENCY_NODE, undefined);
    assert.deepEqual(Object.keys(cold).filter((key) => /^path$/i.test(key)), ['PATH']);
    assert.ok(cold.PATH.endsWith('bootstrap-path'));
  } finally { for (const key of keys) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
});

test('进程身份比较包含创建时间、可执行路径和命令行，不只比较 PID', async () => {
  const processIdentity = { ProcessId: 100, CreatedAt: '2026-10-26T01:00:00Z', ExecutablePath: 'X:/host.exe', CommandLine: 'host.exe' };
  assert.equal(sameProcess({ ...processIdentity }, processIdentity), true);
  for (const key of ['ProcessId', 'CreatedAt', 'ExecutablePath', 'CommandLine']) {
    assert.equal(Boolean(sameProcess({ ...processIdentity, [key]: 'changed' }, processIdentity)), false);
  }
  if (process.platform === 'win32') {
    await temporary(async (root) => { assert.deepEqual(await ownedProcesses(root), []); });
  }
});

test('真实进程自检：仅本轮 Node 子进程进入归属列表，按身份回收且 OS close 与空快照均确认', async (context) => {
  if (process.platform !== 'win32') return context.skip('Windows 进程审计不外推其他平台');
  await temporary(async (root) => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()', join(root, 'owned.marker')],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
    const report = { hosts: [], reclamation: [] };
    let closedResult;
    try {
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
      const candidates = await ownedProcesses(root);
      assert.deepEqual(candidates.map((value) => value.ProcessId), [child.pid]);
      assert.equal(candidates[0].ParentProcessId, process.pid);
      assert.equal(await reclaim(root, report), 1, '这里只在自检中验证强制回收能力，不计产品正常退出');
      closedResult = await Promise.race([closed, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('自检 Node 回收后未收到 OS close')), 5000); timer.unref();
      })]);
      assert.deepEqual(await ownedProcesses(root), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await reclaim(root, report);
      }
      context.diagnostic(JSON.stringify({ pid: child.pid, command: 'node -e process.stdin.resume() <本轮临时根>/owned.marker',
        reclamation: report.reclamation, exit: closedResult, product_host_started: false }));
    }
  });
});

test('下载源统计真实 GET/HEAD/404 与原字节，关闭后端口可重绑', async () => {
  await temporary(async (root) => {
    const path = join(root, 'payload'), bytes = Buffer.from('本地来源实际文件字节');
    await writeFile(path, bytes);
    const report = {}, source = await sourceServer(report);
    try {
      if (process.platform === 'win32') assert.deepEqual(await listenerOwners(report.source.port), [process.pid]);
      source.add('/payload', await identity(path));
      assert.throws(() => source.add('/payload', { path, size: bytes.length }));
      const response = await fetch(source.base + '/payload');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      assert.equal((await fetch(source.base + '/payload', { method: 'HEAD' })).status, 200);
      assert.equal((await fetch(source.base + '/missing')).status, 404);
      assert.equal(source.snapshot(), 3);
      assert.deepEqual(source.requests.map((request) => request.method), ['GET', 'HEAD', 'GET']);
      assert.equal(source.requests[0].bytes, bytes.length);
      assert.equal(source.requests[0].finished, true);
      source.fail('/payload');
      assert.equal((await fetch(source.base + '/payload')).status, 503);
      source.restore('/payload');
      assert.equal((await fetch(source.base + '/payload')).status, 200);
      assert.equal(source.snapshot(), 5);
    } finally { await source.stop(); }
    assert.equal(report.source.listener_released, true);
    await listenerReleased(report.source.port);
  });
});

test('独立组件旁置声明和 v2 完整发布可解包，真实工具与故障描述不被伪造', async () => {
  await temporary(async (root) => {
    const fixtures = await prepareFixtures(root, 'http://127.0.0.1:12345', randomUUID());
    const { components } = fixtures;
    const checked = await checkFixtures(fixtures);
    assert.equal(checked.components.length, 7); assert.equal(checked.releases.length, 10);
    assert.equal(components.sameServer.target.id, components.sameBrowser.target.id);
    assert.equal(components.sameServer.target.id, fixtures.release.target.id);
    const serverFiles = await archiveMembers(components.environment.file, 'tgz');
    const declared = JSON.parse(serverFiles.get('package/dependencies.json'));
    assert.equal(declared.format_version, 1); assert.equal(declared.dependencies[0].id, components.environment.dependencies.dependencies[0].id);
    assert.equal(declared.dependencies[0].bindings[0].config_pointer, '/helper');
    const emptyFiles = await archiveMembers(components.empty.file, 'tgz');
    assert.equal(emptyFiles.has('package/dependencies.json'), false);
    const releaseFiles = await archiveMembers(fixtures.release.file, 'zip');
    const release = JSON.parse(releaseFiles.get('release.json'));
    assert.equal(release.format_version, 2); assert.equal(release.dependencies.format_version, 1);
    assert.ok(!Array.isArray(release.dependencies));
    const componentVariant = release.components[0].variants[0];
    assert.equal(digest(releaseFiles.get(componentVariant.path)), componentVariant.sha256);
    assert.equal(release.dependencies.dependencies[0].id, fixtures.shared.id);
    assert.ok(release.dependencies.dependencies.some((dependency) => !dependency.required && dependency.sources.length > 0));
    assert.ok(release.dependencies.dependencies.some((dependency) => dependency.discovery.some((rule) => rule.kind === 'environment')));
    assert.ok(release.dependencies.dependencies.some((dependency) => dependency.discovery.some((rule) => rule.kind === 'user_directory')));
    const source = fixtures.releases.badDigest.dependencies.dependencies[1].sources[0];
    assert.notEqual(source.sha256, fixtures.archiveIdentity.sha256);
    const missing = fixtures.releases.missingEntry.dependencies.dependencies[1].sources[0];
    assert.equal(fixtures.releases.badDigest.dependencies.dependencies[1].required, false);
    assert.equal(fixtures.releases.missingEntry.dependencies.dependencies[1].required, false);
    const toolMembers = await archiveMembers(fixtures.archiveIdentity.path, 'zip', { collect: false });
    assert.equal(toolMembers.has(missing.entries.main), false); assert.equal(toolMembers.has('node.exe'), true);
    assert.equal((await identity(fixtures.envProgram)).sha256, fixtures.node.sha256);
    assert.equal(components.conflict.dependencies.dependencies[0].version_requirement, '>=999.0.0');
    assert.equal((await tree(join(root, 'fixtures'))).filter((file) => file.path.endsWith('.tgz')).length, 11);
    assert.equal(Object.keys(fixtures.releases).length, 10);
    assert.deepEqual(fixtures.release.components.map((target) => target.kind), ['server', 'browser']);
    assert.equal(JSON.parse(await readFile(join(root, 'fixture-plan.json'))).pending.length, 4);
    const isolated = component('browser', 'third', [dependency('program')]);
    assert.equal(isolated.dependencies.dependencies[0].bindings.length, 0);
    for (const name of ['a', 'b', 'coldA', 'coldB']) {
      const fixture = fixtures.releases[name], files = await archiveMembers(fixture.componentFile, 'tgz');
      const descriptor = JSON.parse(files.get('package/package.json'));
      assert.deepEqual(descriptor.deviceforge.entrypoints.any, { runtime: 'script', path: 'index.mjs',
        dependency: { id: fixtures.shared.id, entry: 'main' } });
      assert.equal(files.has('package/.deviceforge-runtime.json'), false);
      const sidecar = JSON.parse(files.get('package/dependencies.json'));
      if (name === 'coldB') assert.deepEqual(sidecar.dependencies, []);
      else assert.equal(sidecar.dependencies[0].required, true);
      const body = files.get('package/index.mjs').toString();
      assert.ok(body.includes('runtime_executable:process.execPath'));
      assert.ok(body.includes('runtime_parent_pid:process.ppid'));
    }
    const original = await readFile(components.environment.file);
    try {
      await writeFile(components.environment.file, Buffer.from('错误归档'));
      await assert.rejects(() => checkFixtures(fixtures), '启动宿主前必须拒绝损坏夹具');
    } finally { await writeFile(components.environment.file, original); }
  });
});
