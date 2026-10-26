// 新冻结输入交付后才运行；两个空 npm 缓存和业务根共享同一用户目录。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from './plugin-dependencies-smoke/cases.mjs';
import { checkFixtures } from './plugin-dependencies-smoke/check.mjs';
import { tools } from './plugin-dependencies-smoke/client.mjs';
import { assertView, check, identity, save, tree } from './plugin-dependencies-smoke/evidence.mjs';
import { prepareFixtures, registerRelease } from './plugin-dependencies-smoke/fixtures.mjs';
import {
  allowedMember,
  help,
  inside,
  initialCliCases,
  launchNpxHost,
  options,
  osAuditRetries,
  osAuditSnapshots,
  ownFromSnapshot,
  packNpx,
  reclaim,
  runCli,
  runtimeManifest,
  selectedNpxRuntime,
} from './plugin-dependencies-smoke/npx.mjs';
import { sourceServer } from './plugin-dependencies-smoke/source.mjs';

function selfTest() {
  assert.throws(() => options([]), /等待主代理/);
  assert.throws(() => options(['--binary-directory', '.']), /profile/);
  assert.throws(() => options(['--binary-directory', '.', '--profile', 'fast']), /profile/);
  assert.throws(() => options(['--profile', 'debug', '--profile', 'release']), /重复/);
  assert.throws(() => options(['--self-test', '--profile', 'debug']), /混入/);
  assert.throws(() => options(['--binary-directory', '--profile', 'debug']), /缺值/);
  assert.throws(
    () => options(['--binary-directory', '.', '--profile', 'debug', '--unknown', 'x']),
    /未知/,
  );
  assert.deepEqual(options(['--self-test']), { 'self-test': true });
  const parsed = options(['--binary-directory', '.', '--profile', 'debug']);
  assert.equal(parsed.profile, 'debug');
  assert.equal(parsed.binaryDirectory, resolve('.'));
  assert.equal(
    options(['--binary-directory', '.', '--profile', 'debug', '--cli-snapshot-directory', '.'])
      .cliSnapshotDirectory,
    resolve('.'),
  );
  const hash = 'a'.repeat(64),
    validatorHash = 'b'.repeat(64);
  for (const profile of ['debug', 'release']) {
    const manifest = runtimeManifest(profile, '0.1.0', { sha256: hash }, { sha256: validatorHash });
    assert.equal(manifest.profile, profile);
    assert.equal(manifest.platforms[0].sha256, hash);
    assert.equal(manifest.platforms[0].validator_sha256, validatorHash);
    assert.equal(manifest.capabilities, undefined, '旧包不得默认声明新宿主能力');
  }
  assert.deepEqual(
    runtimeManifest('debug', '0.1.0', { sha256: hash }, { sha256: validatorHash }, true)
      .capabilities,
    ['plugin_dependencies_v1'],
  );
  assert.throws(
    () => options(['--binary-directory', '.', '--profile', 'debug', '--initial-cli']),
    /显式启用/,
  );
  assert.throws(
    () => options(['--binary-directory', '.', '--profile', 'debug', '--dependency-preparation']),
    /CLI 快照/,
  );
  assert.throws(() => runtimeManifest(undefined, '0.1.0', {}, {}), /隐含 release/);
  for (const path of [
    'package.json',
    'cli/src/start.mjs',
    'cli/bin/deviceforge.mjs',
    'runtime/manifest.json',
    'runtime/win32-x64/apk-server.exe',
    'runtime/win32-x64/validate-plugin.exe',
    'runtime/web/assets/a.js',
  ])
    assert.equal(allowedMember(path), true);
  for (const path of [
    'backend/target/debug/apk-server.exe',
    'tools/node.exe',
    'scripts/postinstall.mjs',
    'runtime/win32-x64/third-party.exe',
    'cli/tests/start.test.mjs',
    'cli/src/../tests/a.mjs',
    'runtime/web/../../tools/a.exe',
    'cli\\src\\a.mjs',
  ])
    assert.equal(allowedMember(path), false);
  const root = resolve('exclusive-run');
  assert.equal(inside(root, join(root, 'user/.deviceforge/node.exe')), true);
  assert.equal(inside(root, resolve('exclusive-run-neighbor/node.exe')), false);
  const created = '2026-10-26T05:00:00Z';
  const snapshot = [
    { ProcessId: 10, ParentProcessId: 1, CreatedAt: created, CommandLine: 'driver' },
    {
      ProcessId: 20,
      ParentProcessId: 10,
      CreatedAt: created,
      CommandLine: `node ${root}\\package.tgz`,
    },
    { ProcessId: 30, ParentProcessId: 20, CreatedAt: created, CommandLine: `cmd ${root}\\start` },
    {
      ProcessId: 40,
      ParentProcessId: 30,
      CreatedAt: created,
      CommandLine: `node ${root}\\cli.mjs`,
    },
    { ProcessId: 50, ParentProcessId: 40, CreatedAt: created, ExecutablePath: `${root}\\host.exe` },
    {
      ProcessId: 60,
      ParentProcessId: 1,
      CreatedAt: created,
      CommandLine: `editor ${root}\\report.json`,
    },
  ];
  assert.deepEqual(
    ownFromSnapshot(snapshot, root, [], 10).map((item) => item.ProcessId),
    [20, 30, 40, 50],
  );
  assert.equal(ownFromSnapshot(snapshot, root, [], 10).at(-1).Ancestry.length, 4);
  console.log(
    JSON.stringify(
      {
        state: 'self-test-passed',
        passed: true,
        integration_executed: false,
        scope: '参数、显式 debug/release、主包成员白名单与路径边界；未打包、未启动进程或监听',
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function execute(args) {
  assert.equal(process.platform, 'win32', '当前验收仅 Windows x64，不外推其他平台');
  assert.equal(process.arch, 'x64');
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    runId = randomUUID();
  const root =
    args.outputDirectory ??
    join(repository, 'artifacts', `plugin-dependencies-npx-smoke-${args.profile}-${runId}`);
  assert.ok(!inside(args.binaryDirectory, root), '证据目录不得写入冻结二进制目录');
  const distDirectory = args.distDirectory ?? join(repository, 'frontend/dist');
  assert.ok(!inside(distDirectory, root), '证据目录不得写入 dist 输入');
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  const user = join(root, 'user/.deviceforge');
  const report = {
    run_id: runId,
    started_at: new Date().toISOString(),
    directory: root,
    profile: args.profile,
    initial_cli_requested: Boolean(args.initialCli),
    state: 'preparing',
    passed: false,
    hosts: [],
    requests: [],
    jobs: [],
    checks: [],
    caches: [],
    reclamation: [],
    os_audit_retries: osAuditRetries,
    os_audit_snapshots: osAuditSnapshots,
    scope:
      '真实 npm pack、两个空 npm 缓存/不同 cwd/不同业务根、同一 .deviceforge、第三方 v2 正常安装、HTTP/MCP/CLI 与本地受信字节源',
    pending: [
      '在线 npm 发布、真实资源市场与官方 HTTPS 来源',
      '浏览器交互、第二台物理机器、设备、其他平台、长时与性能',
    ],
    excluded_user_ports: [7031, 5173, 5186],
  };
  const controller = new AbortController(),
    handlers = {};
  for (const signal of ['SIGINT', 'SIGTERM']) {
    handlers[signal] = () => {
      report.interrupted ??= { signal, at: new Date().toISOString() };
      process.exitCode = 1;
      controller.abort(new Error('驱动收到中止，停止业务等待并回收本轮资源'));
    };
    process.on(signal, handlers[signal]);
  }
  let source, host, fixtures, packed, beforeInputs, beforeFixtures, baseline, cliSnapshot;
  try {
    const files = [
      fileURLToPath(import.meta.url),
      ...(await tree(join(repository, 'scripts/plugin-dependencies-smoke'))).map((file) =>
        join(repository, 'scripts/plugin-dependencies-smoke', file.path),
      ),
      ...[
        'backend/scripts/online-plugins/fixtures.mjs',
        'cli/src/processes.mjs',
        'scripts/plugin-releases/archive-write.mjs',
        'scripts/plugin-releases/archive-common.mjs',
        'scripts/plugin-releases/archive.mjs',
        'scripts/plugin-releases/archive-zip.mjs',
        'scripts/plugin-releases/archive-tar.mjs',
        'scripts/plugin-releases/contract.mjs',
        'scripts/plugin-releases/versions.mjs',
        'scripts/plugin-releases/dependencies.mjs',
      ].map((path) => join(repository, path)),
    ];
    beforeInputs = await Promise.all(files.map(identity));
    await save(join(root, 'inputs-before.json'), beforeInputs);
    if (args.cliSnapshotDirectory) {
      cliSnapshot = await tree(args.cliSnapshotDirectory);
      report.cli_snapshot_directory = args.cliSnapshotDirectory;
      await save(join(root, 'cli-snapshot-before.json'), cliSnapshot);
    }
    packed = await packNpx({
      repository: args.cliSnapshotDirectory ?? repository,
      root,
      binaryDirectory: args.binaryDirectory,
      distDirectory,
      profile: args.profile,
      dependencyPreparation: args.dependencyPreparation,
      report,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    source = await sourceServer(report);
    fixtures = await prepareFixtures(root, source.base, runId);
    report.fixture_check = await checkFixtures(fixtures);
    await save(join(root, 'fixture-check.json'), report.fixture_check);
    beforeFixtures = await tree(join(root, 'fixtures'));
    await save(join(root, 'fixtures-before.json'), beforeFixtures);
    for (const [path, file] of Object.entries(fixtures.sources)) source.add(path, file);
    const initialCandidates = await Promise.all(
      [fixtures.envProgram, fixtures.userProgram].map(identity),
    );
    await save(join(root, 'discovery-candidates.json'), initialCandidates);
    report.state = 'running';
    for (const phase of [1, 2]) {
      controller.signal.throwIfAborted();
      const phaseRoot = join(root, `phase-${phase}`),
        cache = join(root, `npm-cache-${phase}`),
        cwd = join(phaseRoot, 'cwd');
      const offset = source.snapshot();
      host = await launchNpxHost({
        root,
        phaseRoot,
        cache,
        cwd,
        user,
        packed,
        source: source.base,
        envProgram: fixtures.envProgram,
        report,
        signal: controller.signal,
      });
      const { api, mcp } = host;
      const cacheEvidence = {
        phase,
        cache: await realpath(cache),
        cwd: await realpath(cwd),
        data: await realpath(join(phaseRoot, 'data')),
        user: await realpath(user),
        package_root: host.entry.package_root,
        binary: host.entry.binary,
        empty_before_start: true,
      };
      report.caches.push(cacheEvidence);
      await mcp.requireTools();
      if (phase === 2) {
        const restored = await api.http(
          `/api/v2/plugin-installations/${fixtures.releases.a.target.id}`,
        );
        assert.equal(
          restored.revision,
          baseline.installation_revision,
          '新缓存和业务根必须恢复原安装记录',
        );
        const execution = await inspect(
          api,
          fixtures.releases.a.target,
          fixtures.releases.a.component,
        );
        await selectedNpxRuntime(
          { api, user, fixtures, report, hostEntry: host.entry },
          fixtures.releases.a,
          execution,
        );
        assert.equal(await realpath(execution.helper), baseline.program.path);
        assert.deepEqual(
          (
            await api.http(
              `/api/v2/plugin-configurations/server/${fixtures.releases.a.component.id}`,
            )
          ).values,
          baseline.config.values,
        );
        check(report, '第二缓存/业务根恢复 A 的发布修订、配置与真实工具执行', {
          job_id: execution.job_id,
          cache: cacheEvidence,
        });
      }
      const fixture = fixtures.releases[phase === 1 ? 'a' : 'b'];
      const installed = await registerRelease(api, fixture);
      assert.equal(
        installed.result.status,
        'enabled',
        '必须仅一次正常发布安装便自动准备依赖并启用',
      );
      const view = await api.view(fixture.target);
      assert.deepEqual(await mcp.view(fixture.target, 'mcp'), view);
      assert.equal(view.ready, true);
      const expected = fixture.dependencies.dependencies;
      assert.deepEqual(
        view.dependencies.map((entry) => entry.id),
        expected.map((entry) => entry.id),
      );
      for (const declaration of expected) {
        const dependency = view.dependencies.find((entry) => entry.id === declaration.id);
        if (declaration.required) {
          assert.equal(dependency.status, 'ready');
          assert.equal(dependency.version, process.versions.node);
        }
      }
      assert.equal(
        view.dependencies.find((entry) => entry.id === fixtures.shared.id).source,
        'shared',
      );
      assert.equal(
        view.dependencies.find((entry) => entry.id === expected[1].id).source,
        'environment',
      );
      assert.equal(view.dependencies.find((entry) => entry.id === expected[2].id).source, 'local');
      const execution = await inspect(api, fixture.target, fixture.component);
      const runtime = await selectedNpxRuntime(
        { api, user, fixtures, report, hostEntry: host.entry },
        fixture,
        execution,
      );
      const program = await identity(runtime.selected);
      assert.ok(
        inside(await realpath(user), program.path),
        '共享工具必须属于本轮同一用户根，而非 npm 缓存或业务根',
      );
      assert.equal(program.sha256, fixtures.node.sha256);
      const automaticRequests = source.requests.slice(offset);
      if (phase === 1) {
        const downloads = automaticRequests.filter((entry) => entry.method === 'GET');
        assert.equal(downloads.length, 1, 'A 只下载缺失的共享必需工具');
        assert.equal(downloads[0].path, '/node-good.zip');
        assert.equal(downloads[0].status, 200);
        assert.equal(downloads[0].bytes, fixtures.archiveIdentity.size);
        assert.equal(downloads[0].finished, true);
        assert.ok(
          automaticRequests.every((entry) => entry.path === '/node-good.zip'),
          '环境、本地和可选依赖不得触发下载',
        );
        const installation = await api.http(`/api/v2/plugin-installations/${fixture.target.id}`);
        assert.ok(typeof installation.revision === 'string' && installation.revision);
        baseline = {
          program,
          config: await api.http(`/api/v2/plugin-configurations/server/${fixture.component.id}`),
          installation_revision: installation.revision,
          source_after_install: source.snapshot(),
        };
        check(report, 'A 一次正常 v2 安装先发现环境/用户目录，仅下载缺项且脚本使用所选 Node', {
          installation_job: installed.id,
          runtime,
          program,
          downloads,
          no_manual_dependency_install: true,
        });
      } else {
        assert.equal(
          program.path,
          baseline.program.path,
          'B 必须跨插件复用同一绝对路径，不能复制或重新下载',
        );
        assert.deepEqual(program, baseline.program);
        assert.equal(
          automaticRequests.length,
          0,
          '第二宿主从启动、恢复 A 到 B 正常安装/执行都不能访问来源，包括 HEAD',
        );
        const cli = await runCli(
          host,
          [
            'plugin',
            'dependencies',
            'scan',
            'release',
            fixture.target.id,
            '--expected-revision',
            view.revision,
          ],
          report,
          controller.signal,
        );
        assertView(cli.output.data, fixture.target);
        assert.equal(cli.output.data.ready, true);
        assert.match(cli.output.log_id, /^[a-f0-9-]{36}$/i);
        assert.ok(
          cli.requests.some(
            (request) =>
              request.method === 'POST' && request.path.endsWith('/scan') && request.status === 202,
          ),
        );
        const cliJob = await api.finish(await api.http(`/api/v2/jobs/${cli.output.job_id}`));
        assert.equal(cliJob.operation, 'dependency.scan');
        assert.deepEqual(cliJob.result, cli.output.data);
        const current = await mcp.view(fixture.target, 'mcp');
        const mcpJob = await api.finish(
          await mcp.tool(tools.scan, {
            target: fixture.target,
            expected_revision: current.revision,
          }),
        );
        assert.equal(mcpJob.result.ready, true);
        check(report, '第二缓存 B 跨插件同路径零下载，实际 npx CLI POST 与独立 MCP 端口扫描通过', {
          installation_job: installed.id,
          cli_job: cliJob.id,
          mcp_job: mcpJob.id,
          program,
          runtime,
        });
      }
      const beforeScan = source.snapshot();
      const scan = await api.change(fixture.target, 'scan');
      assert.equal(scan.view.ready, true);
      assert.equal(source.snapshot(), beforeScan, 'HTTP POST 扫描不能下载');
      assert.deepEqual(await mcp.view(fixture.target, 'mcp'), scan.view);
      await save(join(phaseRoot, 'dependencies.json'), scan.view);
      cacheEvidence.source_requests = source.requests.slice(offset);
      await host.stop();
      host = undefined;
      if (phase === 2)
        assert.equal(
          source.snapshot(),
          offset,
          '第二阶段完整生命周期对来源必须零 GET/HEAD/其他请求',
        );
      cacheEvidence.source_after_shutdown = source.snapshot();
      await save(join(phaseRoot, 'phase.json'), cacheEvidence);
    }
    for (const key of ['cache', 'cwd', 'data', 'package_root'])
      assert.notEqual(report.caches[0][key], report.caches[1][key]);
    assert.equal(report.caches[0].user, report.caches[1].user);
    assert.notEqual(report.caches[0].binary.path, report.caches[1].binary.path);
    assert.equal(report.caches[0].binary.sha256, report.caches[1].binary.sha256);
    assert.deepEqual(
      await Promise.all([fixtures.envProgram, fixtures.userProgram].map(identity)),
      initialCandidates,
    );
    if (args.initialCli) {
      await initialCliCases({
        root,
        user,
        packed,
        fixtures,
        source,
        report,
        cache: report.caches[1].cache,
        signal: controller.signal,
      });
    }
    report.state = 'business-passed';
  } catch (error) {
    report.state = 'failed';
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    const audits = [
      ['host', () => host?.stop()],
      ['source', () => source?.stop()],
      [
        'processes',
        async () => {
          assert.equal(await reclaim(root, report), 0, '收尾强制回收不得计正常通过');
        },
      ],
      [
        'fixtures',
        async () => {
          if (!beforeFixtures) return;
          const after = await tree(join(root, 'fixtures'));
          await save(join(root, 'fixtures-after.json'), after);
          assert.deepEqual(after, beforeFixtures);
          report.fixtures_stable = true;
        },
      ],
      [
        'package-and-tools',
        async () => {
          if (!packed) return;
          assert.deepEqual(await identity(packed.host.path), packed.host, '冻结宿主原输入发生变化');
          assert.deepEqual(
            await identity(packed.validator.path),
            packed.validator,
            '冻结校验器原输入发生变化',
          );
          assert.equal((await identity(packed.archive)).sha256, packed.sha256);
          assert.deepEqual(await tree(packed.staging), packed.staging_files);
          if (cliSnapshot) {
            const after = await tree(args.cliSnapshotDirectory);
            await save(join(root, 'cli-snapshot-after.json'), after);
            assert.deepEqual(after, cliSnapshot, '显式 CLI 快照在运行期间发生变化');
            report.cli_snapshot_stable = true;
          }
          for (const cache of report.caches) {
            const after = await tree(cache.package_root);
            await save(join(root, `cache-${cache.phase}-after.json`), after);
            assert.deepEqual(after, packed.staging_files, 'npx 实际安装内容在运行期间发生变化');
          }
          if (baseline) assert.deepEqual(await identity(baseline.program.path), baseline.program);
          report.package_and_tools_stable = true;
        },
      ],
      [
        'inputs',
        async () => {
          if (!beforeInputs) return;
          const after = await Promise.all(beforeInputs.map((file) => identity(file.path)));
          await save(join(root, 'inputs-after.json'), after);
          const changed = after.filter((file, index) => file.sha256 !== beforeInputs[index].sha256);
          const own = [
            fileURLToPath(import.meta.url),
            join(repository, 'scripts/plugin-dependencies-smoke/npx.mjs'),
          ];
          assert.deepEqual(
            changed.filter((file) => own.includes(file.path)),
            [],
            '独占验收脚本在运行期间发生变化',
          );
          report.shared_source_changes = changed;
          report.smoke_inputs_stable = true;
        },
      ],
    ];
    for (const [name, audit] of audits) {
      try {
        await audit();
      } catch (error) {
        (report.cleanup_errors ??= []).push({ name, error: error.stack });
        process.exitCode = 1;
      }
    }
    report.finished_at = new Date().toISOString();
    report.passed =
      report.state === 'business-passed' && !report.cleanup_errors?.length && !report.interrupted;
    report.state = report.passed ? 'passed' : 'failed';
    await save(join(root, 'source-requests.json'), report.source?.requests ?? []);
    await save(join(root, 'runtime-executions.json'), report.runtime_executions ?? []);
    await save(join(root, 'report.json'), report);
    for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    console.log(
      JSON.stringify(
        {
          run_id: runId,
          state: report.state,
          passed: report.passed,
          profile: args.profile,
          report: join(root, 'report.json'),
          checks: report.checks.length,
          source_requests: report.source?.requests.length ?? 0,
          phase_two_source_requests: report.caches[1]?.source_requests?.length,
          reclamation: report.reclamation,
          pending: report.pending,
        },
        null,
        2,
      ),
    );
  }
}

const args = options(process.argv.slice(2));
if (args.help) console.log(help);
else if (args['self-test']) selfTest();
else await execute(args);
