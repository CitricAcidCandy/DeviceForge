import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCliEvidence,
  captureNpxRuntime,
  preserveCliArchive,
  verifyServedHost,
} from './cli-smoke-evidence.mjs';
import { verifyArchiveCache } from './cli-smoke-archive.mjs';
import { inputManifest, verifyLogs } from './harmony-device-smoke/evidence.mjs';
import { keys } from './harmony-device-smoke/fixtures.mjs';
import { fileIdentity } from './unified-discovery-smoke/evidence.mjs';
import { prepareHost } from './harmony-npx-smoke/host.mjs';
import {
  inspectInstalled,
  materializeTemplates,
  preservePluginArchive,
  verifyPluginMembers,
} from './harmony-npx-smoke/identity.mjs';
import { phaseCases } from './harmony-npx-smoke/cases.mjs';
import { failure, lifecycleLogs, retainEvidence } from './harmony-npx-smoke/evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)),
  entry = fileURLToPath(import.meta.url);
const parameters = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  assert.ok(
    [
      '--archive',
      '--plugin-archive',
      '--plugin-binary',
      '--fake-hdc',
      '--source-directory',
    ].includes(key),
  );
  assert.ok(!parameters.has(key) && value && isAbsolute(value), '参数须唯一且为现有原件绝对路径');
  parameters.set(key, resolve(value));
}
for (const name of ['--archive', '--plugin-archive', '--plugin-binary', '--fake-hdc'])
  assert.ok(parameters.has(name), `缺少 ${name}`);
const archive = parameters.get('--archive'),
  pluginArchive = parameters.get('--plugin-archive');
const pluginBinary = parameters.get('--plugin-binary'),
  toolBinary = parameters.get('--fake-hdc');
const source = parameters.get('--source-directory') ?? join(root, 'backend/plugins/harmony-device');
const token = randomBytes(32).toString('hex');
await mkdir(join(root, 'artifacts'), { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-harmony-npx-'));
const report = await createCliEvidence(root, temporary);
report.command = {
  entry: 'node scripts/harmony-npx-smoke.mjs',
  archive,
  plugin_archive: pluginArchive,
  plugin_binary: pluginBinary,
  fake_hdc: toolBinary,
};
Object.assign(report, {
  passed: false,
  stage: '冻结正式原TGZ与当前输入',
  jobs: [],
  requests: [],
  checks: [],
  cli_commands: [],
  scope:
    '正式Harmony原TGZ/真实CLI install/npx两阶段、十贡献/九定义能力含七设备和二提供者、HTTP/MCP22Job/24HDC每阶段、公开模板物化及逐成员原字节身份',
  limitations: [
    '假HDC不证明真机、真实HDC或共享daemon',
    '本地原TGZ与npx不代表npm registry发布',
    '公开CLI不暴露Rust PID；正常日志和包装exit0不作为直接Rust OS进程观测',
    '本批分发成功路径不替代独立148Job/130HDC的两类输入失败、取消、锁和卸载矩阵',
    '10000请求限流仅为验收配置，不提供生产性能结论',
  ],
});
const inputs = [
  archive,
  pluginArchive,
  pluginBinary,
  toolBinary,
  process.execPath,
  join(root, 'scripts/harmony-device-smoke/fake-hdc.rs'),
  ...[
    'manifest.json',
    'aliases.example.json',
    'harmony-device.config.example.json',
    'README.md',
  ].map((name) => join(source, name)),
];
let host,
  deployment,
  fixture,
  completed = false;
const allLogIds = new Set();
try {
  for (const path of [archive, pluginArchive]) {
    assert.ok(path.endsWith('.tgz'));
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 64 * 1024 * 1024);
  }
  report.inputs_before = await inputManifest(entry, inputs);
  await preserveCliArchive(archive, report);
  await preservePluginArchive(pluginArchive, report);
  let ports;
  for (const [phaseName, phaseToken] of [
    ['显式令牌', token],
    ['默认免令牌', undefined],
  ]) {
    const phase = { phase: phaseName, started_at: new Date().toISOString() };
    report.stage = phaseName + '真实CLI安装与默认LAN npx启动';
    host = await prepareHost({
      root,
      temporary,
      archive,
      report,
      phase,
      token: phaseToken,
      bindingsPath: join(temporary, 'operation-bindings.json'),
      ports,
    });
    if (!deployment) {
      const installed = await host.runNpx(
        [...host.prefix, 'plugin', 'install-legacy', pluginArchive, '--data-dir', host.directory],
        'Harmony正式TGZ安装',
      );
      deployment = await inspectInstalled(host, report, source, pluginBinary);
      assert.ok(
        installed.stdout.includes(`harmony-device@${deployment.manifest.version} 安装完成`),
      );
      ({ fixture } = await materializeTemplates(deployment, temporary, toolBinary, source, report));
      report.checks.push({
        name: '真实CLI install、六原包成员、原binary身份、生成清单及公开配置模板物化',
        passed: true,
      });
    }
    const listed = await host.runNpx(
      [...host.prefix, 'plugin', 'list-legacy', '--data-dir', host.directory],
      'Harmony安装目录列举',
    );
    assert.deepEqual(JSON.parse(listed.stdout), [
      {
        id: 'harmony-device',
        version: deployment.manifest.version,
        protocol_version: 4,
        operations: deployment.manifest.operations.length,
      },
    ]);
    phase.tools_before = await keys(fixture);
    const runtime = await captureNpxRuntime(host.cache, report, phaseName);
    Object.assign(phase, runtime);
    report.phases[report.phases.length - 1] = phase;
    phase.npx_entry = await fileIdentity(host.npx);
    host.start();
    await host.ready();
    await verifyServedHost(host.client.base, phase);
    if (phaseToken) {
      const denied = await host.client.call('/api/v2/health', { authenticate: false });
      assert.equal(denied.status, 401);
      const deniedMcp = await host.client.call('/mcp', {
        authenticate: false,
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', origin: host.client.base },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
      });
      assert.equal(deniedMcp.status, 401);
      phase.unauthorized_http_mcp_rejected = true;
    }
    report.stage = phaseName + '十贡献九定义能力HTTP/MCP、无发现provider动作、详情与自动ability';
    await phaseCases(host, deployment, fixture, report, phase);
    report.stage = phaseName + '正常退出与包身份稳定';
    await host.shutdown();
    phase.archive_cache_after = await verifyArchiveCache(
      report.archive.path,
      phase.package_root,
      phase.resources,
      report.archive.sha256,
    );
    assert.deepEqual(phase.archive_cache_after.members, phase.archive_cache.members);
    assert.equal((await fileIdentity(host.npx)).sha256, phase.npx_entry.sha256);
    await verifyPluginMembers(deployment, report);
    for (const id of host.client.logIds) allLogIds.add(id);
    await host.finish();
    ports = { webPort: host.webPort, mcpPort: host.mcpPort };
    report.checks.push({
      name: phaseName + 'npx exit0、双端口释放、全部CLI/Harmony原包成员稳定',
      passed: true,
    });
  }
  report.stage = '两阶段逐Job日志、宿主生命周期和冻结输入';
  assert.equal(report.jobs.length, 44);
  assert.equal(new Set(report.jobs.map((job) => job.job_id)).size, 44);
  assert.equal(report.jobs.flatMap((job) => job.tools ?? (job.tool ? [job.tool] : [])).length, 48);
  await verifyLogs(temporary, { client: { logIds: allLogIds } }, report);
  await lifecycleLogs(host, report, token);
  report.inputs_after = await inputManifest(entry, inputs);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  report.inputs_stable = true;
  completed = true;
} catch (error) {
  failure(report, error);
  process.exitCode = 1;
  await writeFile(
    join(report.directory, 'failure-before-cleanup.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  );
} finally {
  if (host)
    try {
      await host.finish();
    } catch (error) {
      failure(report, error);
      completed = false;
      process.exitCode = 1;
    }
  try {
    await retainEvidence(temporary, report, token);
  } catch (error) {
    failure(report, error);
    completed = false;
    process.exitCode = 1;
  }
  if (report.inputs_before && !report.inputs_after)
    try {
      report.inputs_after = await inputManifest(entry, inputs);
      report.inputs_stable =
        JSON.stringify(report.inputs_before) === JSON.stringify(report.inputs_after);
      assert.equal(report.inputs_stable, true);
    } catch (error) {
      failure(report, error);
      completed = false;
      process.exitCode = 1;
    }
  report.passed = completed && !report.failure;
  report.completed_at = new Date().toISOString();
  if (report.passed) report.stage = '完成';
  assert.ok(!JSON.stringify(report).includes(token));
  const path = join(report.directory, 'report.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(
    JSON.stringify({
      passed: report.passed,
      report: path,
      stage: report.stage,
      failure: report.failure,
      phases: report.phases.length,
      jobs: report.jobs.length,
      tools: report.jobs.flatMap((job) => job.tools ?? (job.tool ? [job.tool] : [])).length,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
