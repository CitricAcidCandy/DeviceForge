// 仅使用已构建产物；独立 CLI 服务验证本地导入及跨重启持久化，不连接设备或市场。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from '../cli/src/paths.mjs';
import { parseOptions } from '../cli/src/options.mjs';
import { importRootConfiguration } from '../cli/src/root-config.mjs';
import { cleanEnvironment, freePort, launch } from './local-import-smoke/host.mjs';
import { deploy, digest } from './local-import-smoke/fixtures.mjs';
import {
  importSettings,
  importTools,
  installPackages,
  verifyRestart,
} from './local-import-smoke/cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(
  process.argv.slice(2).every((value) => value === '--release'),
  '仅支持 --release',
);
const profile = process.argv.includes('--release') ? 'release' : 'debug';
const suffix = process.platform === 'win32' ? '.exe' : '';
const runtime = {
  binary: join(root, 'backend', 'target', profile, `apk-server${suffix}`),
  validator: join(root, 'backend', 'target', profile, `validate-plugin${suffix}`),
  web: join(root, 'frontend', 'dist'),
};
const inputs = {
  server: runtime.binary,
  validator: runtime.validator,
  tool_supply: join(root, 'backend', 'target', profile, `deviceforge-tool-supply-plugin${suffix}`),
  settings: join(root, 'backend', 'target', profile, `deviceforge-settings-plugin${suffix}`),
  frontend_index: join(runtime.web, 'index.html'),
};
const output = join(root, 'artifacts', 'persistent-local-import-20261020');
const report = {
  timestamp: new Date().toISOString(),
  profile,
  passed: false,
  scope:
    '当前已构建宿主与真实插件、CLI 生命周期、HTTP/MCP、本地 ZIP、配置 CAS 及跨重启原字节；浏览器模块仅取资源，不含 UI 挂载、真机、性能或正式 npx 分发',
  inputs: {},
  deployments: [],
  runs: [],
  checks: [],
  requests: [],
  jobs: [],
  persisted: {},
  temporary_removed: false,
};
let temporary,
  host,
  stage = '检查已构建输入';

async function fingerprint(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), '输入必须是已有的非链接普通文件');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest('hex') };
}

async function cleanup() {
  if (!temporary) return;
  const base = await realpath(tmpdir());
  const target = await realpath(temporary);
  const info = await lstat(temporary);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      target !== base &&
      inside(base, target) &&
      basename(target).startsWith('deviceforge-local-import-'),
    '只允许清理本轮临时目录',
  );
  await rm(target, { recursive: true, force: true });
  report.temporary_removed = true;
}

try {
  for (const [name, path] of Object.entries(inputs)) report.inputs[name] = await fingerprint(path);
  stage = '准备独立数据根与部署';
  temporary = await mkdtemp(join(tmpdir(), 'deviceforge-local-import-'));
  const data = join(temporary, 'data');
  const deployed = await deploy(root, data, profile);
  for (const plugin of deployed) {
    const identity = await fingerprint(plugin.path);
    const source = report.inputs[plugin.id === 'tool-supply' ? 'tool_supply' : 'settings'];
    assert.deepEqual(identity, source, '部署副本必须与本轮构建插件字节一致');
    report.deployments.push({ id: plugin.id, ...identity, config_source: '本轮部署目录旁置配置' });
  }
  const environment = { ...cleanEnvironment(), DEVICEFORGE_HTTP_RATE: '10000' };
  const port = await freePort();
  let mcpPort = await freePort();
  while (mcpPort === port) mcpPort = await freePort();
  const options = parseOptions(
    [
      'start',
      '--data-dir',
      data,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--mcp-port',
      String(mcpPort),
    ],
    environment,
  );
  stage = '首次 CLI 启动与根配置生成';
  await assert.rejects(readFile(join(data, 'config.json')), { code: 'ENOENT' });
  host = await launch(options, runtime, environment, report);
  const rootConfiguration = JSON.parse(await readFile(join(data, 'config.json'), 'utf8'));
  assert.equal(rootConfiguration.format_version, 1);
  report.checks.push('首次 CLI 启动在独立数据根生成 config.json');
  stage = '工具本地导入';
  await importTools(host.client, data, report);
  stage = '配置本地导入及 CAS';
  await importSettings(host.client, data, report);
  stage = '浏览器与服务器本地插件包导入';
  await installPackages(host.client, data, report);
  stage = '首次正常退出与端口释放';
  await host.stop();
  host = undefined;
  report.checks.push('首次退出确认宿主成功日志，前端、MCP 与后端端口全部释放');
  stage = 'CLI 根配置导入与重新读取';
  rootConfiguration.server = { ip: '127.0.0.1', port, mcp_port: mcpPort };
  const source = join(temporary, 'root-import.json');
  await writeFile(source, `${JSON.stringify(rootConfiguration)}\n`, 'utf8');
  await importRootConfiguration(data, source);
  const rootBytes = await readFile(join(data, 'config.json'));
  const restarted = parseOptions(['start', '--data-dir', data], environment);
  assert.equal(restarted.port, port);
  assert.equal(restarted.mcpPort, mcpPort);
  assert.equal(restarted.ip, '127.0.0.1');
  report.persisted.root = { file_sha256: digest(rootBytes), imported: true };
  report.checks.push('CLI 根配置导入后只用数据目录参数恢复监听偏好');
  stage = '相同数据根重启与持久化复验';
  host = await launch(restarted, runtime, environment, report);
  await verifyRestart(host.client, data, report);
  assert.deepEqual(await readFile(join(data, 'config.json')), rootBytes);
  stage = '再次正常退出与输入冻结核对';
  await host.stop();
  host = undefined;
  for (const [name, path] of Object.entries(inputs))
    assert.deepEqual(await fingerprint(path), report.inputs[name], '验收期间已构建输入不可变化');
  for (const plugin of deployed) {
    const before = report.deployments.find((entry) => entry.id === plugin.id);
    assert.deepEqual(
      await fingerprint(plugin.path),
      { bytes: before.bytes, sha256: before.sha256 },
      '验收期间部署插件副本不可变化',
    );
  }
  report.checks.push('第二次正常退出并释放全部端口，构建输入前后摘要一致');
  report.passed = true;
} catch (error) {
  report.failure = {
    stage,
    name: error.name,
    code: error.code,
    message_sha256: digest(String(error.message)),
  };
  console.error(`持久化本地导入验收失败：${stage}；${error.message}`);
  process.exitCode = 1;
} finally {
  if (host) {
    try {
      await host.stop();
    } catch (error) {
      report.passed = false;
      report.shutdown_failure_sha256 = digest(String(error.message));
      process.exitCode = 1;
    }
  }
  try {
    await cleanup();
  } catch (error) {
    report.passed = false;
    report.cleanup_failure_sha256 = digest(String(error.message));
    process.exitCode = 1;
  }
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'service-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
}
if (report.passed)
  console.log(
    `持久化本地导入验收通过：${report.checks.length} 项检查，${report.jobs.length} 个真实任务，报告 ${join(output, 'service-report.json')}`,
  );
