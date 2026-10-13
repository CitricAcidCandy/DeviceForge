import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeManifest } from '../cli/src/plugin-package.mjs';
import { archiveMembers, verifyArchiveCache } from './cli-smoke-archive.mjs';
import { captureNpxRuntime, createCliEvidence, preserveCliArchive, verifyServedHost } from './cli-smoke-evidence.mjs';
import { prepareHost } from './harmony-npx-smoke/host.mjs';
import { lifecycleLogs } from './harmony-npx-smoke/evidence.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { assertSourceContract, catalog, names, pluginId } from './harmony-screenshot-smoke/contracts.mjs';
import { discover, normalEntries } from './harmony-screenshot-smoke/cases.mjs';
import { histories, owner, plugins } from './harmony-screenshot-smoke/lifecycle.mjs';
import { finishPendingProbes } from './harmony-screenshot-smoke/fixtures.mjs';
import { failure, inputManifest, reportFor, retain, verifyLogs } from './harmony-screenshot-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), entry = fileURLToPath(import.meta.url);
const parameters = new Map(), args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  assert.ok(['--archive', '--plugin-archive', '--plugin-binary', '--tool-binary', '--probe-binary', '--source-directory'].includes(name));
  assert.ok(value && isAbsolute(value) && !parameters.has(name)); parameters.set(name, resolve(value));
}
for (const name of ['--archive', '--plugin-archive', '--plugin-binary', '--tool-binary', '--probe-binary', '--source-directory']) {
  assert.ok(parameters.has(name), '缺少冻结输入 ' + name);
}
const archive = parameters.get('--archive'), pluginArchive = parameters.get('--plugin-archive');
const pluginBinary = parameters.get('--plugin-binary'), toolBinary = parameters.get('--tool-binary');
const probeBinary = parameters.get('--probe-binary'), source = parameters.get('--source-directory');
const token = randomBytes(32).toString('hex');
await mkdir(join(root, 'artifacts'), { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-harmony-screenshot-npx-'));
const report = { ...await createCliEvidence(root, temporary), ...reportFor('release', 'npx') };
report.command = { entry: 'node scripts/harmony-screenshot-npx-smoke.mjs', archive, plugin_archive: pluginArchive,
  plugin_binary: pluginBinary, tool_binary: toolBinary, probe_binary: probeBinary, source_directory: source };
report.scope = '冻结正式原TGZ、真实CLI安装及npx两阶段，十一贡献十能力八availability，截图六入口完整产物数组、HTTP原字节及逐工具真实父子OS退出';
report.limitations = ['假HDC和31字节结构JPEG不证明真机、真实HDC、共享daemon、像素解码或视觉正确',
  '本地原TGZ和npx运行不证明npm registry发布、另一LAN主机或生产性能',
  '公开MCP artifact.inspect只提供元数据任务，没有MCP原字节下载接口',
  'npx包装exit0与宿主日志不等于Rust宿主直接OS退出码；工具与直接父插件另由真实句柄探针验证',
  '本入口只验分发成功路径，取消、deadline、锁、未知资源矩阵须另用服务入口'];
const sourceFiles = ['manifest.json', 'manifest.example.json', 'aliases.example.json', 'harmony-device.config.example.json', 'README.md'];
const inputs = [archive, pluginArchive, pluginBinary, toolBinary, probeBinary, process.execPath,
  ...sourceFiles.map((name) => join(source, name)), join(root, 'backend/plugins/harmony-device/tests/fixtures/hdc.rs'),
  join(root, 'backend/plugins/harmony-device/tests/fixtures/screenshot.rs'), join(root, 'scripts/harmony-screenshot-smoke/process-probe.rs')];
let host, deployment, completed = false, ports, previousGeneration;
const allLogIds = new Set();

async function verifyMembers() {
  const members = await archiveMembers(report.plugin.retained_archive.path, report.plugin.archive.sha256);
  assert.deepEqual(members, report.plugin.members);
  assert.equal((await fileIdentity(pluginArchive)).sha256, report.plugin.archive.sha256);
  for (const member of members) {
    const path = join(deployment.packageRoot, ...member.relative_path.split('/'));
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink());
    const identity = await fileIdentity(path); assert.equal(identity.bytes, member.bytes); assert.equal(identity.sha256, member.sha256);
  }
  assert.equal((await fileIdentity(deployment.manifestPath)).sha256, report.plugin.generated_manifest.sha256);
  report.plugin.member_verification = { matched_files: members.length, passed: true, checked_at: new Date().toISOString() };
}

async function installed() {
  const platform = `${process.platform}-${process.arch}`, packageName = `@deviceforge/plugin-${pluginId}-${platform}`;
  const packageRoot = join(host.plugins, pluginId, 'node_modules', ...packageName.split('/'));
  const descriptor = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const executableName = `deviceforge-${pluginId}-plugin${process.platform === 'win32' ? '.exe' : ''}`;
  assert.equal(descriptor.name, packageName); assert.equal(descriptor.deviceforge.kind, 'server');
  assert.equal(descriptor.deviceforge.manifest, 'plugin.json'); assert.deepEqual(descriptor.os, [process.platform]);
  assert.deepEqual(descriptor.cpu, [process.arch]);
  assert.deepEqual(descriptor.deviceforge.entrypoints, { [platform]: { runtime: 'native', path: `bin/${executableName}` } });
  assert.deepEqual(report.plugin.members.map((member) => member.relative_path).sort(),
    ['README.md', 'package.json', 'plugin.json', `bin/${executableName}`, 'bin/aliases.example.json', 'bin/harmony-device.config.example.json'].sort());
  const [original, example, bindings] = await Promise.all(sourceFiles.slice(0, 3).map(async (name) => JSON.parse(await readFile(join(source, name), 'utf8'))));
  assertSourceContract(original, example, bindings);
  const manifest = JSON.parse(await readFile(join(packageRoot, 'plugin.json'), 'utf8'));
  delete original.executable; assert.deepEqual(manifest, original); assert.equal(manifest.version, descriptor.version);
  const manifestPath = join(host.plugins, pluginId, 'manifest.json');
  const generated = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(generated, await materializeManifest(packageRoot, packageRoot, platform));
  assert.equal(generated.executable, join(packageRoot, 'bin', executableName));
  const originalBinary = await fileIdentity(pluginBinary), actualBinary = await fileIdentity(generated.executable);
  assert.equal(actualBinary.bytes, originalBinary.bytes); assert.equal(actualBinary.sha256, originalBinary.sha256);
  assert.equal((await readFile(join(packageRoot, 'README.md'), 'utf8')).endsWith(await readFile(join(source, 'README.md'), 'utf8') + '\n'), true);
  for (const name of ['aliases.example.json', 'harmony-device.config.example.json']) {
    assert.deepEqual(await readFile(join(packageRoot, 'bin', name)), await readFile(join(source, name)));
  }
  const configuration = JSON.parse(await readFile(join(packageRoot, 'bin/harmony-device.config.example.json'), 'utf8'));
  assert.deepEqual(configuration, { format_version: 1, tools: { hdc: 'hdc' } });
  await assert.rejects(lstat(join(dirname(generated.executable), 'harmony-device.config.json')), { code: 'ENOENT' });
  await copyFile(join(packageRoot, 'bin/aliases.example.json'), join(temporary, 'operation-bindings.json'));
  report.plugin.name = packageName; report.plugin.version = manifest.version;
  report.plugin.original_binary = originalBinary; report.plugin.actual_binary = actualBinary;
  report.plugin.generated_manifest = await fileIdentity(manifestPath);
  report.plugin.bindings = await fileIdentity(join(temporary, 'operation-bindings.json'));
  deployment = { packageRoot, actualBinary: generated.executable, manifestPath, manifest };
  await verifyMembers(); return deployment;
}

try {
  report.stage = '冻结正式原TGZ与源码'; report.inputs_before = await inputManifest(entry, inputs);
  for (const path of [archive, pluginArchive]) {
    const info = await lstat(path); assert.ok(path.endsWith('.tgz') && info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 * 1024);
  }
  await preserveCliArchive(archive, report);
  const original = await fileIdentity(pluginArchive), retainedPath = join(report.directory, basename(pluginArchive));
  await copyFile(pluginArchive, retainedPath); const retainedArchive = await fileIdentity(retainedPath);
  assert.equal(retainedArchive.sha256, original.sha256); assert.equal(retainedArchive.bytes, original.bytes);
  report.plugin = { archive: original, retained_archive: retainedArchive, members: await archiveMembers(retainedPath, original.sha256) };
  for (const [ordinal, phaseName, phaseToken] of [[1, '显式令牌', token], [2, '默认免令牌', undefined]]) {
    console.log(JSON.stringify({ phase: '开始', round: phaseName }));
    const phase = { phase: phaseName, started_at: new Date().toISOString() };
    report.stage = phaseName + '真实CLI安装与npx启动';
    if (ordinal === 2) await rm(join(temporary, 'data', 'plugins', pluginId), { recursive: true, force: true });
    host = await prepareHost({ root, temporary, archive, report, phase, token: phaseToken,
      bindingsPath: join(temporary, 'operation-bindings.json'), ports });
    await copyFile(join(source, 'aliases.example.json'), join(temporary, 'operation-bindings.json'));
    host.start(); await host.ready();
    const result = await host.runNpx([...host.prefix, 'plugin', 'install', pluginArchive, '--data-dir', host.directory], '截图正式Harmony原TGZ安装');
    deployment = await installed(); assert.ok(result.stdout.includes(`harmony-device@${deployment.manifest.version} 安装完成`));
    const listing = await host.runNpx([...host.prefix, 'plugin', 'list', '--data-dir', host.directory], '截图正式包列举');
    assert.deepEqual(JSON.parse(listing.stdout), [{ id: pluginId, version: deployment.manifest.version, protocol_version: 4, operations: names.length }]);
    Object.assign(phase, await captureNpxRuntime(host.cache, report, phaseName)); report.phases[report.phases.length - 1] = phase;
    phase.npx_entry = await fileIdentity(host.npx); await verifyServedHost(host.client.base, phase);
    if (phaseToken) {
      assert.equal((await host.client.call('/api/v2/health', { authenticate: false })).status, 401);
      const denied = await host.client.call('/mcp', { authenticate: false, method: 'POST',
        headers: { accept: 'application/json, text/event-stream', origin: host.client.base },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }) });
      assert.equal(denied.status, 401); phase.unauthorized_http_mcp_rejected = true;
    }
    await plugins(host); await catalog(host, deployment, report, phaseName + '空宿主', false);
    const loaded = owner(await host.client.post('/api/v2/plugins/' + pluginId + '/load'), deployment, undefined, 'loaded');
    if (previousGeneration) assert.notEqual(loaded.generation, previousGeneration);
    await plugins(host, loaded); await catalog(host, deployment, report, phaseName + '已加载', true, loaded);
    await histories(host, report, phaseName + '既有历史');
    const directory = join(temporary, 'phase-' + ordinal); await mkdir(directory);
    const options = { directory, toolBinary, probeBinary, token: phaseToken };
    report.stage = phaseName + '截图六入口完整产物与OS退出';
    await discover(host, deployment, report, options, 'phase-' + ordinal);
    await normalEntries(host, deployment, report, options, 'phase-' + ordinal);
    owner(await host.client.tool('deviceforge.unload_plugin', { id: pluginId }), deployment, loaded.generation, 'unloaded');
    await plugins(host); await catalog(host, deployment, report, phaseName + '确认清理卸载', false);
    await histories(host, report, phaseName + '卸载历史'); previousGeneration = loaded.generation;
    report.stage = phaseName + '正常退出与原包身份稳定';
    await host.shutdown(); await host.finish(); ports = { webPort: host.webPort, mcpPort: host.mcpPort };
    phase.archive_cache_after = await verifyArchiveCache(report.archive.path, phase.package_root, phase.resources, report.archive.sha256);
    assert.deepEqual(phase.archive_cache_after.members, phase.archive_cache.members);
    assert.equal((await fileIdentity(host.npx)).sha256, phase.npx_entry.sha256); await verifyMembers();
    if (ordinal === 1) await rm(join(temporary, 'data', 'plugins', pluginId), { recursive: true, force: true });
    for (const id of host.client.logIds) allLogIds.add(id);
    report.checks.push({ name: phaseName + '冻结原TGZ、默认LAN、截图六入口、完整产物与原字节、npx退出零及双端口释放', passed: true });
    console.log(JSON.stringify({ phase: '终态', round: phaseName, passed: true }));
  }
  report.stage = '两阶段日志与输入冻结';
  assert.equal(report.jobs.length, 14); assert.equal(new Set(report.jobs.map((job) => job.job_id)).size, 14);
  assert.equal(report.metadata_jobs.length, 12); assert.equal(report.jobs.flatMap((job) => job.tools).length, 62);
  await verifyLogs(temporary, { client: { logIds: allLogIds } }, report, token); await lifecycleLogs(host, report, token);
  report.inputs_after = await inputManifest(entry, inputs); assert.deepEqual(report.inputs_after, report.inputs_before);
  report.inputs_stable = true; completed = true;
} catch (error) {
  failure(report, error);
  await writeFile(join(report.directory, 'failure-before-cleanup.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
} finally {
  if (host) try { await host.finish(); } catch (error) { failure(report, error, '自有npx退出'); }
  try { await finishPendingProbes(report); } catch (error) { failure(report, error, '自有探针收尾'); }
  try { await retain(temporary, report); } catch (error) { failure(report, error, '原件索引'); }
  report.passed = completed && !report.failure; report.completed_at = new Date().toISOString();
  if (report.passed) report.stage = '完成'; assert.ok(!JSON.stringify(report).includes(token));
  const path = join(report.directory, 'report.json'); await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ passed: report.passed, report: path, stage: report.stage,
    phases: report.phases.length, jobs: report.jobs.length, metadata_jobs: report.metadata_jobs.length,
    tools: report.jobs.flatMap((job) => job.tools ?? []).length, failure: report.failure }));
  if (!report.passed) process.exitCode = 1;
}
