// 对比真实操作进程、宿主生成描述和已选程序，不把 helper 子进程冒充插件运行时。
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { check, identity, save } from './evidence.mjs';
import { registerRelease, scriptArgs } from './fixtures.mjs';

export async function selectedRuntime(context, fixture, execution) {
  assert.ok(fixture.runtimeDependency, '此断言仅用于声明 script 运行时依赖的服务器组件');
  const selected = await realpath(execution.helper), actual = await realpath(execution.runtime_executable);
  assert.equal(actual, selected, '插件本体必须由所选依赖启动，不能只让 helper 子进程使用下载工具');
  assert.equal((await identity(actual)).sha256, context.fixtures.node.sha256);
  assert.notEqual(actual, await realpath(process.execPath), '不能偷偷使用启动验收驱动的全局 Node');
  assert.equal(execution.runtime_parent_pid, context.hostEntry.pid, '脚本进程必须直接由本轮宿主 argv 启动，不经过 shell');
  assert.ok(Number.isInteger(execution.runtime_pid) && execution.runtime_pid > 0);
  const directory = join(context.root, 'user/.deviceforge/plugins', fixture.component.id);
  assert.equal(await realpath(execution.runtime_argv[0]), selected);
  const owner = await context.api.http(`/api/v2/plugin-installations/${fixture.target.id}`);
  assert.equal(await realpath(execution.runtime_argv[1]), await realpath(join(directory, 'revisions', owner.revision, 'index.mjs')));
  assert.deepEqual(execution.runtime_argv.slice(2), scriptArgs, '空格和 shell 字符必须作为原样 argv 传递');
  const markerPath = join(directory, '.deviceforge-runtime.json'), info = await lstat(markerPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 65536);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.deepEqual(marker, { format_version: 1, dependency: fixture.runtimeDependency });
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, fixture.component.id);
  assert.deepEqual(manifest.args.slice(1), scriptArgs);
  const evidence = { component: fixture.component, dependency: fixture.runtimeDependency, job_id: execution.job_id,
    selected, actual, pid: execution.runtime_pid, parent_pid: execution.runtime_parent_pid,
    argv: execution.runtime_argv, marker, persisted_manifest_executable: manifest.executable,
    effective_executable: actual, marker_identity: await identity(markerPath) };
  (context.report.runtime_executions ??= []).push(evidence);
  return evidence;
}

export async function coldRuntime(context, inspect) {
  const { api, fixtures, source, report, root, hostEntry } = context;
  await api.requireTools();
  assert.equal(hostEntry.bootstrap_node, 'absent'); assert.equal(hostEntry.node_override_present, false);
  assert.deepEqual(await readdir(hostEntry.isolated_path), [], '无 bootstrap PATH 必须为空目录');
  const before = source.snapshot(), programs = [];
  for (const name of ['coldA', 'coldB']) {
    const fixture = fixtures.releases[name], offset = source.snapshot();
    const installed = await registerRelease(api, fixture);
    assert.equal(installed.result.status, 'enabled', '无初始宿主 Node 也应由一次安装准备运行时并启用');
    const http = await api.view(fixture.target), mcp = await api.view(fixture.component, 'mcp', fixture.target);
    assert.deepEqual(mcp, http); assert.equal(http.ready, true);
    const execution = await inspect(api, fixture.target, fixture.component);
    programs.push((await selectedRuntime(context, fixture, execution)).selected);
    if (name === 'coldA') {
      const downloads = source.requests.slice(offset).filter((request) => request.method === 'GET');
      assert.equal(downloads.length, 1); assert.equal(downloads[0].path, '/node-good.zip');
      assert.equal(downloads[0].bytes, fixtures.archiveIdentity.size); assert.equal(downloads[0].finished, true);
    } else assert.equal(source.snapshot(), offset, '无 bootstrap B 安装及实际执行必须零下载源请求');
  }
  assert.equal(programs[0], programs[1], '无 bootstrap 的两个第三方脚本也必须复用同一运行时');
  await save(join(root, 'runtime-executions.json'), report.runtime_executions.filter((value) => programs.includes(value.selected)));
  check(report, '无宿主 Node 和 PATH Node 的隔离宿主：A 下载运行时并 argv 执行，B 零网络复用且实际执行',
    { host_pid: hostEntry.pid, source_requests: source.snapshot() - before, program: programs[0], bootstrap_node: false });
}
