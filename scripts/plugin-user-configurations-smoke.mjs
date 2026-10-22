// 两个业务数据目录顺序启动，共用同一用户配置根；二进制由调用者明确指定。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checks,
  diskChecks,
  firstRound,
  secondRound,
} from './plugin-user-configurations-smoke/cases.mjs';
import { digest, prepare } from './plugin-user-configurations-smoke/fixture.mjs';
import { launch } from './plugin-user-configurations-smoke/host.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = {};
const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) {
  console.log(
    '用法：node scripts/plugin-user-configurations-smoke.mjs --binary <宿主绝对或相对路径> [--output <全新证据目录>]',
  );
} else {
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    assert.ok(['--binary', '--output'].includes(name), '仅支持 --binary 和 --output');
    assert.ok(arguments_[index + 1] && !arguments_[index + 1].startsWith('--'), `${name} 缺少参数`);
    assert.ok(options[name] === undefined, `${name} 不能重复指定`);
    options[name] = arguments_[index + 1];
  }
  assert.ok(options['--binary'], '必须使用 --binary 明确指定本轮宿主');
  const source = resolve(options['--binary']);
  const output = options['--output']
    ? resolve(options['--output'])
    : join(repository, 'artifacts', `plugin-user-configurations-${randomUUID()}`);
  await mkdir(dirname(output), { recursive: true });
  // 不覆盖现有证据目录；此处失败尚未启动任何进程。
  await mkdir(output);
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
    passed: false,
    output,
    scope:
      '当前明确指定宿主、真实 HTTP、受控 Node 插件进程与文件；不含浏览器界面、真机、正式分发或性能',
    checks: [],
    requests: [],
    hosts: [],
    cleanup_errors: [],
    configuration_root: paths.user,
  };
  const check = checks(report);
  let host;
  try {
    await copyFile(source, paths.binary);
    report.binary_sha256 = digest(await readFile(paths.binary));
    const fixture = await prepare(paths, repository);
    report.manifest_sha256 = fixture.manifestDigest;
    report.legacy_template_sha256 = fixture.legacyDigest;
    await mkdir(paths.dataDirectories[0]);
    await mkdir(paths.dataDirectories[1]);
    host = await launch({ ...paths, data: paths.dataDirectories[0] }, report);
    const saved = await firstRound(host.call, check);
    await diskChecks(paths, fixture, saved, check, '第一轮');
    await host.stop();
    host = undefined;
    check(
      '第一轮正常退出并释放监听端口',
      report.hosts[0].normal_shutdown && report.hosts[0].port_released,
    );
    host = await launch({ ...paths, data: paths.dataDirectories[1] }, report);
    await secondRound(host.call, check, saved);
    await diskChecks(paths, fixture, saved, check, '第二轮');
    await host.stop();
    host = undefined;
    check(
      '第二轮正常退出并释放监听端口',
      report.hosts[1].normal_shutdown && report.hosts[1].port_released,
    );
    report.passed = true;
  } catch (error) {
    // 所有配置断言均为布尔条件，错误信息不包含配置原值。
    report.error = {
      name: error.name,
      code: typeof error.code === 'string' ? error.code : undefined,
      message:
        error.name === 'AssertionError'
          ? error.message
          : '验收执行失败；按请求状态、已通过检查与宿主退出证据定位',
    };
    process.exitCode = 1;
  } finally {
    if (host) {
      try {
        await host.stop();
      } catch {
        report.cleanup_errors.push('失败路径宿主清理未通过');
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
    console.log(
      JSON.stringify({
        passed: report.passed,
        checks: report.checks.length,
        report: join(output, 'report.json'),
      }),
    );
  }
}
