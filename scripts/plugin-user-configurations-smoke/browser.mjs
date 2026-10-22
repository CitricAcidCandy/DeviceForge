// 复用隔离宿主和 HTTP 用例，另调严格 TypeScript 浏览器驱动；不启动 Vite 或构建。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checks, diskChecks, firstRound, secondRound } from './cases.mjs';
import { digest, prepare } from './fixture.mjs';
import { launch } from './host.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) {
  console.log(
    '用法：node scripts/plugin-user-configurations-smoke/browser.mjs --binary <宿主路径> [--dev-url http://127.0.0.1:5173] [--output <全新目录>] [--browser <浏览器程序>]',
  );
} else {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index],
      value = arguments_[index + 1];
    assert.ok(
      ['--binary', '--dev-url', '--output', '--browser'].includes(name) &&
        value &&
        !value.startsWith('--'),
      '验收参数无效',
    );
    assert.ok(options[name] === undefined, '验收参数不能重复');
    options[name] = value;
  }
  assert.ok(options['--binary'], '必须明确指定本轮宿主 --binary');
  const devUrl = options['--dev-url'] ?? 'http://127.0.0.1:5173';
  const output = options['--output']
    ? resolve(options['--output'])
    : join(repository, 'artifacts', `plugin-user-configurations-browser-${randomUUID()}`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const runId = randomUUID();
  const paths = {
    output,
    binary: join(output, process.platform === 'win32' ? 'apk-server.exe' : 'apk-server'),
    user: join(output, 'isolated-user', '.deviceforge'),
    deployment: join(output, 'plugins'),
    browserDeployment: join(output, 'browser-plugins'),
    dataDirectories: [join(output, 'business-a'), join(output, 'business-b')],
  };
  const report = {
    timestamp: new Date().toISOString(),
    run_id: runId,
    passed: false,
    scope: '当前指定宿主的真实 HTTP 与真实浏览器配置模型；无产品界面、设备、正式分发或性能验收',
    checks: [],
    requests: [],
    hosts: [],
    browsers: [],
    cleanup_errors: [],
    configuration_root: paths.user,
  };
  const check = checks(report);
  let host;
  async function browser(phase) {
    const directory = join(output, phase === 'setup' ? 'browser-setup' : 'browser-restart');
    const hostEntry = report.hosts.at(-1);
    assert.ok(hostEntry && host, '浏览器阶段必须使用本轮已就绪宿主');
    const args = [
      join(repository, 'frontend/scripts/browser-user-configuration-smoke.ts'),
      '--api-url',
      `http://127.0.0.1:${hostEntry.port}`,
      '--dev-url',
      devUrl,
      '--run-id',
      runId,
      '--phase',
      phase,
      '--output',
      directory,
      ...(phase === 'restart' ? ['--state', join(output, 'browser-setup/report.json')] : []),
      ...(options['--browser'] ? ['--browser', options['--browser']] : []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: repository,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const entry = { phase, pid: child.pid, report: join(directory, 'report.json') };
    report.browsers.push(entry);
    // 浏览器驱动自管有界关闭和端口/profile清理；编排等待真实退出而不抢杀其浏览器。
    const result = await new Promise((done) => {
      child.once('error', (error) => done({ spawn_error: error.code ?? 'spawn_failed' }));
      child.once('close', (code, signal) => done({ code, signal }));
    });
    entry.exit = result;
    check(`${phase}浏览器驱动正常退出`, result.code === 0 && result.signal === null);
    const evidence = JSON.parse(await readFile(entry.report, 'utf8'));
    check(
      `${phase}浏览器报告与当前轮身份一致且通过`,
      evidence.passed === true && evidence.run_id === runId && evidence.phase === phase,
    );
  }
  try {
    await copyFile(resolve(options['--binary']), paths.binary);
    report.binary_sha256 = digest(await readFile(paths.binary));
    const fixture = await prepare(paths, repository);
    report.manifest_sha256 = fixture.manifestDigest;
    report.legacy_template_sha256 = fixture.legacyDigest;
    for (const directory of paths.dataDirectories) await mkdir(directory);
    host = await launch({ ...paths, data: paths.dataDirectories[0] }, report);
    const saved = await firstRound(host.call, check);
    await browser('setup');
    await diskChecks(paths, fixture, saved, check, '第一轮');
    await host.stop();
    host = undefined;
    check(
      '第一轮宿主正常退出并释放监听',
      report.hosts[0].normal_shutdown && report.hosts[0].port_released,
    );
    host = await launch({ ...paths, data: paths.dataDirectories[1] }, report);
    await secondRound(host.call, check, saved);
    await browser('restart');
    await diskChecks(paths, fixture, saved, check, '第二轮');
    await host.stop();
    host = undefined;
    check(
      '第二轮宿主正常退出并释放监听',
      report.hosts[1].normal_shutdown && report.hosts[1].port_released,
    );
    report.passed = true;
  } catch (error) {
    report.error = {
      name: error.name,
      message:
        error.name === 'AssertionError'
          ? error.message
          : '编排失败；参阅分阶段报告，不记录可能含配置的原始异常',
    };
    process.exitCode = 1;
  } finally {
    if (host) {
      try {
        await host.stop();
      } catch {
        report.cleanup_errors.push('宿主失败路径清理未通过');
      }
    }
    if (
      report.cleanup_errors.length ||
      report.hosts.some((entry) => !entry.normal_shutdown || !entry.port_released)
    ) {
      report.passed = false;
      process.exitCode = 1;
    }
    report.finished_at = new Date().toISOString();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, report: join(output, 'report.json') }));
  }
}
