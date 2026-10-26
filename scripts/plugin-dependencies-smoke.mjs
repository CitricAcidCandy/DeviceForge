// 消费主代理提供的新冻结宿主；本入口不运行 Cargo、npm 或 API 生成器。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect, runCases } from './plugin-dependencies-smoke/cases.mjs';
import { checkFixtures } from './plugin-dependencies-smoke/check.mjs';
import { identity, save, tree } from './plugin-dependencies-smoke/evidence.mjs';
import { prepareFixtures } from './plugin-dependencies-smoke/fixtures.mjs';
import { launchHost } from './plugin-dependencies-smoke/host.mjs';
import { help, options } from './plugin-dependencies-smoke/options.mjs';
import { reclaim } from './plugin-dependencies-smoke/processes.mjs';
import { sourceServer } from './plugin-dependencies-smoke/source.mjs';
import { coldRuntime } from './plugin-dependencies-smoke/runtime-cases.mjs';

const args = options(process.argv.slice(2));
if (args.help) {
  console.log(help);
} else {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runId = randomUUID();
  const root = args.outputDirectory ?? join(repository, 'artifacts', `plugin-dependencies-smoke-${runId}`);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  const report = { run_id: runId, started_at: new Date().toISOString(), directory: root,
    state: 'preparing', passed: false, hosts: [], requests: [], jobs: [], checks: [], reclamation: [],
    scope: '真实冻结 Windows 宿主、HTTP/MCP、独立用户根与端口、模拟程序真实进程及下载字节；不替代真实市场、npx、浏览器执行或真机',
    pending: ['npx 双缓存与换业务根后依赖持久化复用', '真实市场和可信官方 HTTPS 来源', '浏览器执行、真机、其他平台、性能'],
  };
  const controller = new AbortController();
  const interrupt = (signal) => {
    report.interrupted ??= { signal, at: new Date().toISOString() };
    process.exitCode = 1;
    controller.abort(new Error(`驱动收到 ${signal}，停止业务等待并回收本轮资源`));
  };
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => interrupt(signal)]));
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  let source, host, inputIdentities, fixtureIdentities;
  try {
    const inputs = [join(repository, 'scripts/plugin-dependencies-smoke.mjs'),
      ...(await tree(join(repository, 'scripts/plugin-dependencies-smoke'))).map((file) => join(repository, 'scripts/plugin-dependencies-smoke', file.path)),
      ...['backend/scripts/online-plugins/fixtures.mjs', 'scripts/plugin-releases/archive-write.mjs',
        'scripts/plugin-releases/archive-common.mjs', 'scripts/plugin-releases/contract.mjs',
        'scripts/plugin-releases/archive.mjs', 'scripts/plugin-releases/archive-zip.mjs',
        'scripts/plugin-releases/archive-tar.mjs', 'scripts/plugin-releases/versions.mjs',
        'scripts/plugin-releases/dependencies.mjs'].map((path) => join(repository, path))];
    inputIdentities = await Promise.all(inputs.map(identity));
    await save(join(root, 'inputs-before.json'), inputIdentities);
    if (!args.prepareOnly) source = await sourceServer(report);
    const fixtures = await prepareFixtures(root, source?.base ?? 'http://127.0.0.1:1', runId);
    report.fixture_check = await checkFixtures(fixtures);
    await save(join(root, 'fixture-check.json'), report.fixture_check);
    controller.signal.throwIfAborted();
    fixtureIdentities = await tree(join(root, 'fixtures'));
    await save(join(root, 'fixtures-before.json'), fixtureIdentities);
    if (args.prepareOnly) {
      report.state = 'prepared';
      report.execution = '未启动宿主或 HTTP 源；此结果不是集成通过';
    } else {
      for (const [path, file] of Object.entries(fixtures.sources)) source.add(path, file);
      host = await launchHost({ root, binaryDirectory: args.binaryDirectory, binaryPath: args.binaryPath,
        source: source.base, envProgram: fixtures.envProgram,
        report, signal: controller.signal });
      report.state = 'running';
      await runCases({ root, api: host.api, fixtures, source, report, hostEntry: host.entry });
      report.primary_matrix_passed_at = new Date().toISOString();
      await host.stop();
      host = undefined;
      const coldRoot = join(root, 'runtime-no-bootstrap');
      await mkdir(coldRoot);
      host = await launchHost({ root: coldRoot, binaryDirectory: args.binaryDirectory, binaryPath: args.binaryPath,
        source: source.base, report, signal: controller.signal, bootstrapNode: false });
      await coldRuntime({ root: coldRoot, api: host.api, fixtures, source, report, hostEntry: host.entry }, inspect);
      report.state = 'business-passed';
    }
  } catch (error) {
    report.state = 'failed'; report.error = error.stack; process.exitCode = 1;
  } finally {
    for (const [name, finish] of [['host', () => host?.stop()], ['source', () => source?.stop()]]) {
      try { await finish(); }
      catch (error) { (report.cleanup_errors ??= []).push({ name, error: error.stack }); process.exitCode = 1; }
    }
    const audits = [
      ['process-audit', async () => {
        if (args.prepareOnly) return;
        const forced = await reclaim(root, report);
        assert.equal(forced, 0, '收尾仍需强制回收进程，不能计为正常通过');
      }],
      ['input-audit', async () => {
        if (!inputIdentities) return;
        const after = await Promise.all(inputIdentities.map(async (file) => {
          try { return await identity(file.path); } catch (error) { return { path: file.path, error: error.message }; }
        }));
        await save(join(root, 'inputs-after.json'), after);
        const changes = after.filter((file, index) => file.sha256 !== inputIdentities[index].sha256);
        const own = (path) => path === join(repository, 'scripts/plugin-dependencies-smoke.mjs')
          || path.startsWith(join(repository, 'scripts/plugin-dependencies-smoke') + (process.platform === 'win32' ? '\\' : '/'));
        report.shared_source_changes = changes.filter((file) => !own(file.path));
        assert.deepEqual(changes.filter((file) => own(file.path)), [], '独占夹具源码在运行期间发生变化');
        report.inputs_stable = changes.length === 0;
        report.smoke_inputs_stable = true;
      }],
      ['fixture-audit', async () => {
        if (!fixtureIdentities) return;
        const after = await tree(join(root, 'fixtures'));
        await save(join(root, 'fixtures-after.json'), after);
        assert.deepEqual(after, fixtureIdentities, '运行期间归档或模拟环境程序发生变化');
        report.fixtures_stable = true;
      }],
    ];
    for (const [name, audit] of audits) {
      try { await audit(); }
      catch (error) { (report.cleanup_errors ??= []).push({ name, error: error.stack }); process.exitCode = 1; }
    }
    report.finished_at = new Date().toISOString();
    report.passed = report.state === 'business-passed' && !report.cleanup_errors?.length && !report.interrupted;
    if (report.passed) report.state = 'passed';
    else if (report.cleanup_errors?.length || report.interrupted) report.state = 'failed';
    await save(join(root, 'report.json'), report);
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    console.log(JSON.stringify({ run_id: runId, state: report.state, passed: report.passed,
      report: join(root, 'report.json'), checks: report.checks.length, jobs: report.jobs.length,
      source_requests: report.source?.requests.length ?? 0, reclamation: report.reclamation,
      pending: report.pending }, null, 2));
  }
}
