// 所有业务断言来自真实公开接口；文件摘要用于独立证明旧工具未被破坏。
import assert from 'node:assert/strict';
import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { assertView, check, identity, save } from './evidence.mjs';
import { registerComponents, registerRelease } from './fixtures.mjs';
import { targetPath, tools } from './client.mjs';
import { selectedRuntime } from './runtime-cases.mjs';

const item = (view, id) => {
  const found = view.dependencies.find((value) => value.id === id);
  assert.ok(found, `视图缺声明依赖：${id}`);
  return found;
};

async function sameView(api, target, canonicalTarget = target) {
  const http = await api.view(target, 'http', canonicalTarget), mcp = await api.view(target, 'mcp', canonicalTarget);
  assert.deepEqual(mcp, http, 'HTTP/MCP 依赖视图必须一致');
  return http;
}

async function config(api, target) {
  assert.equal(target.kind, 'server');
  return api.http(`/api/v2/plugin-configurations/server/${target.id}`);
}

export async function inspect(api, target, componentTarget) {
  const owner = target.kind === 'release' ? await api.http(`/api/v2/plugin-installations/${target.id}`) : undefined;
  const selected = componentTarget ?? target;
  const submitted = await api.http('/api/v2/jobs', { method: 'POST', status: 202,
    ...(owner ? { headers: { 'x-deviceforge-plugin-release': JSON.stringify({ id: owner.id, revision: owner.revision }) } } : {}),
    input: { operation: `plugin.${selected.id}.inspect`, input: {} } });
  const job = await api.finish(submitted);
  assert.equal(job.result.version, process.versions.node);
  assert.equal(job.result.setting, '本轮旧配置必须保留');
  assert.ok(isAbsolute(job.result.helper), '自动绑定必须进入真实插件执行快照');
  return { job_id: job.id, ...job.result };
}

async function readyByScan(context, name, expectedSource, transport = 'http') {
  const { api, fixtures, report, source } = context;
  const fixture = fixtures.components[name], before = source.snapshot();
  const initial = await config(api, fixture.target);
  const automatic = await sameView(api, fixture.target);
  assert.equal(automatic.ready, true, '安装后不先点依赖接口就应完成自动发现');
  const automaticExecution = await inspect(api, fixture.target);
  const expectedProgram = name === 'environment' ? fixtures.envProgram
    : join(context.root, 'user/.deviceforge/preexisting-tool/node.exe');
  assert.equal(await realpath(automaticExecution.helper), await realpath(expectedProgram), '安装必须先使用已存在的明确发现候选');
  assert.equal((await identity(expectedProgram)).sha256, fixtures.node.sha256);
  const { job } = await api.change(fixture.target, 'scan', { transport });
  const view = await sameView(api, fixture.target);
  assert.equal(view.ready, true);
  const dependency = item(view, fixture.dependencies.dependencies[0].id);
  assert.equal(dependency.status, 'ready');
  if (expectedSource) assert.equal(dependency.source, expectedSource);
  assert.equal(dependency.version, process.versions.node);
  const saved = await config(api, fixture.target);
  assert.deepEqual(saved.values, initial.values, '扫描不得把自动绑定改写为用户显式配置');
  assert.equal(saved.values.helper, '', '默认空路径不应被自动发现回写');
  await inspect(api, fixture.target);
  assert.equal(source.snapshot(), before, '环境或用户根发现不能访问下载源');
  check(report, name === 'environment' ? '空配置从环境自动发现并真实执行' : '空配置从 .deviceforge 现有目录自动发现并真实执行',
    { target: fixture.target, source: dependency.source, job_id: job.id });
}

async function sharedReuse(context) {
  const { api, fixtures, source, report, root } = context;
  const a = fixtures.releases.a, b = fixtures.releases.b;
  const before = source.snapshot();
  const installed = await registerRelease(api, a);
  assert.equal(installed.result.status, 'enabled', 'A 的一次发布安装就应自动准备依赖并启用');
  assert.equal(installed.result.enabled, true);
  const automaticA = await sameView(api, a.target);
  assert.equal(automaticA.ready, true, 'A 安装后不点扫描或依赖安装即可就绪');
  assert.equal(item(automaticA, fixtures.shared.id).status, 'ready');
  for (const name of ['environment', 'user']) {
    const id = fixtures.components[name].dependencies.dependencies[0].id;
    assert.equal(item(automaticA, id).source, name === 'environment' ? 'environment' : 'local');
  }
  assert.ok(automaticA.dependencies.some((dependency) => !dependency.required && dependency.status === 'missing'),
    '自动安装只能下载缺失必需项，不安装可选工具');
  const firstRequests = source.requests.slice(before);
  const downloads = firstRequests.filter((request) => request.method === 'GET');
  assert.equal(downloads.length, 1, 'A 只允许一次真实下载');
  assert.equal(downloads[0].path, '/node-good.zip');
  assert.equal(downloads[0].bytes, fixtures.archiveIdentity.size);
  assert.equal(downloads[0].finished, true);
  assert.ok(firstRequests.every((request) => request.path === '/node-good.zip'), 'A 不得访问其他来源');
  const configA = await config(api, a.component);
  const actualA = await inspect(api, a.target, a.component);
  await selectedRuntime(context, a, actualA);
  const offset = relative(await realpath(root), await realpath(actualA.helper));
  assert.ok(offset && !offset.startsWith('..') && !isAbsolute(offset), '托管工具必须属于独占证据根');
  assert.equal((await identity(actualA.helper)).sha256, fixtures.node.sha256);
  assert.equal(basename(actualA.helper), 'node.exe');
  const afterA = source.snapshot();
  const reused = await registerRelease(api, b);
  assert.equal(reused.result.status, 'enabled', 'B 一次发布安装自动复用并启用');
  const automaticB = await sameView(api, b.target);
  assert.equal(automaticB.ready, true);
  assert.equal(item(automaticB, fixtures.shared.id).source, 'shared');
  const actualB = await inspect(api, b.target, b.component);
  await selectedRuntime(context, b, actualB);
  assert.equal(actualB.helper, actualA.helper, 'B 必须复用同一共享程序，不是复制下载');
  assert.equal(source.snapshot(), afterA, 'B 整个发布安装及就绪查询必须零 HTTP 请求，包括 HEAD');
  check(report, 'A script 一次安装下载并实际使用运行时，B script 零网络复用且实际使用同一运行时',
    { a: a.target, b: b.target, download_requests: firstRequests.length, reused_requests: 0,
      jobs: [installed.id, reused.id], no_manual_dependency_install: true });
  return { a, b, configA, program: await identity(actualA.helper) };
}

async function targetIsolation(context) {
  const { api, fixtures, source, report } = context;
  const before = source.snapshot();
  const targets = [fixtures.components.sameServer.target, fixtures.components.sameBrowser.target, fixtures.release.target];
  assert.equal(new Set(targets.map((target) => target.id)).size, 1);
  const signatures = [];
  for (const [index, target] of targets.entries()) {
    await api.change(target, 'scan', { transport: index === 1 ? 'mcp' : 'http' });
    const view = await sameView(api, target);
    assert.equal(view.ready, true);
    const expectedIds = (index === 0 ? fixtures.components.sameServer.dependencies
      : index === 1 ? fixtures.components.sameBrowser.dependencies : fixtures.release.dependencies).dependencies.map((value) => value.id);
    assert.deepEqual(view.dependencies.map((value) => value.id), expectedIds);
    signatures.push(view.dependencies.map((value) => value.id).join(','));
  }
  assert.equal(new Set(signatures).size, 3, '同名三类目标不得读到另一类型的依赖');
  assert.equal(source.snapshot(), before, '同名目标扫描和完整发布复用不得重新下载');
  check(report, '第三方同名 release/server/browser 三类目标独立且 HTTP/MCP 一致', { targets });
}

async function canonicalTargets(context, baseline) {
  const { api, source, report } = context;
  const owner = baseline.a.target, before = source.snapshot();
  const aliases = baseline.a.components;
  assert.deepEqual(aliases.map((target) => target.kind).sort(), ['browser', 'server']);
  for (const target of aliases) {
    const canonical = await sameView(api, owner);
    assert.deepEqual(await sameView(api, target, owner), canonical, '所属组件必须返回同一发布的目标、修订和依赖');
    const submitted = target.kind === 'server'
      ? await api.http(`${targetPath(target)}/scan`, { method: 'POST', status: 202,
        input: { expected_revision: canonical.revision } })
      : await api.tool(tools.scan, { target, expected_revision: canonical.revision });
    const job = await api.finish(submitted);
    assertView(job.result, owner);
    // 正常客户端以查询返回的发布目标继续操作，不继续携带组件目标。
    const result = await api.change(target, 'install', { canonicalTarget: owner,
      transport: target.kind === 'server' ? 'mcp' : 'http' });
    assertView(result.view, owner);
    assert.deepEqual(await sameView(api, target, owner), await sameView(api, owner));
  }
  assert.equal(source.snapshot(), before, '类型归并和重复依赖管理不能重新下载已有工具');
  await inspect(api, baseline.a.target, baseline.a.component);
  check(report, '所属 server/browser 规范化为 release，别名写入和规范化后续操作均一致',
    { owner, aliases, source_requests: 0 });
}

async function failurePreservesOld(context, name, baseline) {
  const { api, fixtures, source, report } = context;
  const fixture = fixtures.releases[name], automaticCount = source.snapshot();
  const installed = await registerRelease(api, fixture);
  assert.equal(installed.result.status, 'enabled');
  assert.equal(source.snapshot(), automaticCount, '可选坏来源不得在一次发布安装中下载');
  const initial = await sameView(api, fixture.target);
  assert.equal(initial.ready, true);
  const beforeConfig = await config(api, fixture.component), count = source.snapshot();
  const ownIds = fixture.dependencies.dependencies.map((value) => value.id);
  const { job } = await api.change(fixture.target, 'install', { ids: [ownIds[1]], expected: 'failed', transport: name === 'badDigest' ? 'http' : 'mcp' });
  const view = await sameView(api, fixture.target);
  const bad = item(view, ownIds[1]);
  assert.equal(view.ready, true, '可选依赖失败不得使必需依赖成功的插件变成不可用');
  assert.equal(bad.status, 'failed');
  assert.ok(typeof bad.message === 'string' && bad.message.trim(), '失败视图必须提供摘要');
  assert.ok(typeof job.error === 'string' && job.error.trim(), '失败 Job 必须保留原因');
  const requests = source.requests.slice(count), expectedPath = name === 'badDigest' ? '/node-bad-digest.zip' : '/node-missing-entry.zip';
  const downloads = requests.filter((request) => request.method === 'GET' && request.path === expectedPath);
  assert.equal(downloads.length, 1,
    '必须实际请求失败来源，不能被共享元数据短路成假失败');
  assert.equal(downloads[0].status, 200); assert.equal(downloads[0].finished, true);
  assert.equal(downloads[0].bytes, fixtures.sources[expectedPath].size, '坏包场景必须真正完成对应归档的字节传输');
  assert.ok(requests.every((request) => request.path === expectedPath));
  const afterConfig = await config(api, fixture.component);
  assert.deepEqual(afterConfig.values, beforeConfig.values, '失败安装不得破坏旧配置绑定');
  assert.equal(item(view, fixtures.shared.id).status, 'ready', '单个失败不能覆盖另一依赖成功');
  assert.deepEqual((await config(api, baseline.a.component)).values, baseline.configA.values);
  assert.equal((await identity(baseline.program.path)).sha256, baseline.program.sha256);
  await inspect(api, fixture.target, fixture.component);
  await inspect(api, baseline.a.target, baseline.a.component); await inspect(api, baseline.b.target, baseline.b.component);
  check(report, name === 'badDigest' ? '真实摘要失败有摘要且不坏旧工具与配置' : '真实缺入口失败有摘要且不坏旧工具与配置',
    { target: fixture.target, job_id: job.id, dependency: bad, source_requests: requests.length });
}

async function conflictsAndEmpty(context, baseline) {
  const { api, fixtures, source, report } = context;
  const conflict = fixtures.components.conflict.target, before = source.snapshot();
  await api.change(conflict, 'scan', { transport: 'mcp' });
  const view = await sameView(api, conflict), incompatible = item(view, fixtures.shared.id);
  assert.equal(incompatible.status, 'incompatible');
  assert.equal(incompatible.installable, false); assert.equal(view.ready, false);
  assert.ok(incompatible.message, '版本不兼容必须提供可读原因');
  assert.equal((await identity(baseline.program.path)).sha256, baseline.program.sha256);
  await inspect(api, baseline.a.target, baseline.a.component);
  for (const name of ['empty', 'emptyBrowser']) {
    const target = fixtures.components[name].target;
    const empty = await sameView(api, target);
    assert.deepEqual(empty.dependencies, []); assert.equal(empty.ready, true);
    await api.change(target, 'scan', { transport: 'mcp', ids: [] });
    const result = await api.change(target, 'install');
    assert.deepEqual(result.view.dependencies, []); assert.equal(result.view.ready, true);
  }
  for (const name of ['empty', 'legacyEmpty']) {
    const fixture = fixtures.releases[name];
    const installed = await registerRelease(api, fixture);
    assert.equal(installed.result.status, 'enabled');
    const view = await sameView(api, fixture.target);
    assert.equal(view.ready, true); assert.deepEqual(view.dependencies, []);
    assert.deepEqual(await sameView(api, fixture.component, fixture.target), view);
    for (const action of ['scan', 'install']) {
      const result = await api.change(fixture.target, action, { transport: action === 'scan' ? 'mcp' : 'http' });
      assert.equal(result.view.ready, true); assert.deepEqual(result.view.dependencies, []);
    }
  }
  assert.equal(source.snapshot(), before, '版本不兼容及无依赖不得访问下载源');
  check(report, '版本冲突不替换共享成功；server/browser 及 v1/v2 release 无依赖就绪且零网络');
}

async function rejection(context) {
  const { api, fixtures, source, report } = context;
  const target = fixtures.releases.a.target, before = source.snapshot();
  const original = await sameView(api, target), stale = original.revision === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  const expired = await api.http(`${targetPath(target)}/install`, { method: 'POST', status: 202, input: { expected_revision: stale } });
  await api.finish(expired, 'failed');
  await api.finish(await api.tool(tools.scan, { target, expected_revision: stale }), 'failed');
  const unknown = await api.http(`${targetPath(target)}/install`, { method: 'POST', status: 202,
    input: { expected_revision: original.revision, dependency_ids: ['undeclared_dependency'] } });
  await api.finish(unknown, 'failed');
  assert.deepEqual(await sameView(api, target), original, '拒绝请求不能修改视图');
  const jobs = await api.http('/api/v2/jobs?limit=100');
  await api.http(`${targetPath(target)}/install`, { method: 'POST', status: 400,
    input: { expected_revision: original.revision, dependency_ids: '不是数组' } });
  assert.deepEqual(await api.http('/api/v2/jobs?limit=100'), jobs, '形状错误输入不能创建 Job');
  assert.equal(source.snapshot(), before);
  check(report, 'HTTP/MCP 过期修订及未知依赖产生失败 Job 且无副作用；形状错误不创建 Job');
}

async function remediation(context, baseline) {
  const { api, fixtures, source, report, root } = context;
  for (const name of ['noSource', 'network']) {
    const fixture = fixtures.releases[name];
    if (name === 'network') source.fail('/node-network.zip');
    const count = source.snapshot();
    await registerRelease(api, fixture, name === 'network' ? 'failed' : 'succeeded');
    const installed = await api.http(`/api/v2/plugin-installations/${fixture.target.id}`);
    assert.equal(installed.status, 'dependencies_required', '缺来源或网络失败必须保留已安装插件供补救');
    const waiting = await sameView(api, fixture.target);
    assert.equal(waiting.ready, false);
    assert.ok(waiting.dependencies[0].message, '不可就绪原因必须可查询');
    if (name === 'network') {
      const requests = source.requests.slice(count);
      assert.equal(requests.filter((request) => request.path === '/node-network.zip' && request.method === 'GET').length, 1);
      assert.equal(requests.find((request) => request.path === '/node-network.zip').status, 503);
      source.restore('/node-network.zip');
    } else assert.equal(source.snapshot(), count, '无来源不能尝试猜测下载');
    const scanBefore = source.snapshot();
    const scanned = await api.change(fixture.target, 'scan', { transport: 'mcp' });
    assert.equal(scanned.view.ready, false);
    assert.equal(source.snapshot(), scanBefore, '扫描在可恢复下载源前也不能下载');
    if (name === 'noSource') {
      const directory = join(root, 'user/.deviceforge/remediation-tool');
      await mkdir(directory);
      await copyFile(process.execPath, join(directory, 'node.exe'));
    }
    const beforeRepair = source.snapshot();
    const fixed = await api.change(fixture.target, 'install', { transport: name === 'network' ? 'mcp' : 'http' });
    assert.equal(fixed.view.ready, true);
    const after = await api.http(`/api/v2/plugin-installations/${fixture.target.id}`);
    assert.equal(after.status, 'enabled', '补救后应按已保存的启用意图恢复');
    await inspect(api, fixture.target, fixture.component);
    if (name === 'noSource') assert.equal(source.snapshot(), beforeRepair, '本地补救复用零网络');
    else {
      const downloads = source.requests.slice(beforeRepair).filter((request) => request.method === 'GET');
      assert.equal(downloads.length, 1); assert.equal(downloads[0].path, '/node-network.zip');
      assert.equal(downloads[0].bytes, fixtures.sources['/node-network.zip'].size);
    }
    assert.equal((await identity(baseline.program.path)).sha256, baseline.program.sha256);
    await inspect(api, baseline.a.target, baseline.a.component);
    check(report, name === 'noSource' ? '无可下载来源保留 DependenciesRequired，本地补救自动绑定并恢复'
      : '真实网络失败保留 DependenciesRequired，扫描不下载，独立 install 补救成功',
    { target: fixture.target, installation_job: installed.id, remediation_job: fixed.job.id });
  }
}

export async function runCases(context) {
  const { api, fixtures, report, root } = context;
  await api.requireTools();
  const beforeComponents = context.source.snapshot();
  await registerComponents(api, fixtures);
  assert.equal(context.source.snapshot(), beforeComponents, '可从环境和用户根自动发现的组件安装不能下载');
  check(report, '公开接口安装随机第三方组件及旁置依赖描述，无宿主白名单');
  await readyByScan(context, 'environment', 'environment');
  await readyByScan(context, 'user', 'local', 'mcp');
  const baseline = await sharedReuse(context);
  await targetIsolation(context);
  await canonicalTargets(context, baseline);
  await failurePreservesOld(context, 'badDigest', baseline);
  await failurePreservesOld(context, 'missingEntry', baseline);
  await remediation(context, baseline);
  await conflictsAndEmpty(context, baseline);
  await rejection(context);
  await save(join(root, 'final-views.json'), await Promise.all([
    ...Object.values(fixtures.components).map((value) => value.target),
    ...Object.entries(fixtures.releases).filter(([name]) => !['coldA', 'coldB'].includes(name)).map(([, value]) => value.target),
  ].map((target) => sameView(api, target))));
}

