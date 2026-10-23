// 统一发布真实验收：独立市场、宿主、用户根和第三方插件，不接触在线手机。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseFixture } from './plugin-installations-smoke/fixtures.mjs';
import { launch } from './plugin-installations-smoke/host.mjs';
import { launchMarket } from './plugin-installations-smoke/market.mjs';
import {
  publish,
  upload,
  inspect,
  asset,
  configuration,
  rpc,
  stageEvents,
  persistedConfiguration,
  invalidOffline,
} from './plugin-installations-smoke/scenarios.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 ||
    (args.length === 1 && args[0] === '--release') ||
    (args.length === 3 && args[0] === '--release' && args[1] === '--binary-directory'),
  '仅支持 --release [--binary-directory 路径]',
);
const profile = args.includes('--release') ? 'release' : 'debug';
const binaryDirectory = args[2] ? resolve(args[2]) : join(root, 'backend', 'target', profile);
const suffix = process.platform === 'win32' ? '.exe' : '';
const reportPath = join(root, 'artifacts', `plugin-installations-smoke-${profile}.json`);
const report = {
  timestamp: new Date().toISOString(),
  profile,
  platform: process.platform,
  architecture: process.arch,
  scope:
    '真实Rust市场和宿主、第三方Node协议1成套发布、HTTP/MCP、工具共享与多版本、配置持久化、离线导入；浏览器资源字节不代表浏览器交互或真机验收',
  hosts: [],
  requests: [],
  checks: {},
  passed: false,
};
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-installations-smoke-'));
report.directory = temporary;
let market, host;
async function start(data) {
  return launch({
    binary: join(binaryDirectory, `apk-server${suffix}`),
    cwd: root,
    data: join(temporary, data),
    user: join(temporary, 'user'),
    market: market.base,
    report,
  });
}
try {
  market = await launchMarket({
    binary: join(
      root,
      'resource-server',
      'target',
      profile,
      `deviceforge-resource-server${suffix}`,
    ),
    cwd: root,
    data: join(temporary, 'market'),
    report,
  });
  const first = await releaseFixture(temporary);
  const second = await releaseFixture(temporary, { id: 'another_feature' });
  const update = await releaseFixture(temporary, {
    version: '1.1.0',
    toolVersion: '2.0.0',
    toolBytes: '第二版本工具',
  });
  const broken = await releaseFixture(temporary, { version: '1.2.0', broken: true });
  const offline = await releaseFixture(temporary, { id: 'offline_feature' });
  const negative = await releaseFixture(temporary, { id: 'negative_feature' });
  const [source, secondSource, updateSource, brokenSource] = await Promise.all(
    [first, second, update, broken].map((fixture) => publish(fixture, market)),
  );
  host = await start('data-a');
  const plan = await host.call('/api/v2/plugin-installations/plan', {
    method: 'POST',
    input: source,
  });
  assert.equal(plan.issues.filter((issue) => issue.required).length, 0);
  assert.equal(plan.resources.length, 3);
  const installed = await host.job('/api/v2/plugin-installations', { source });
  let current = installed.result;
  assert.equal(current.enabled, true);
  assert.equal(current.status, 'enabled');
  await inspect(host, first, current);
  await asset(host, current);
  report.checks.stages = await stageEvents(host, installed.id);
  await configuration(host, first, '用户配置不丢失');
  await inspect(host, first, current, { setting: '用户配置不丢失' });
  report.checks.first_install_and_configuration = true;

  const shared = plan.resources.find((resource) => resource.kind === 'tool');
  const requests = () => market.counts.get(`GET /api/v1/resources/${shared.sha256}`) ?? 0;
  assert.equal(requests(), 1, '首次安装只下载一次工具');
  const sharedPlan = await host.call('/api/v2/plugin-installations/plan', {
    method: 'POST',
    input: secondSource,
  });
  assert.equal(sharedPlan.resources.find((resource) => resource.kind === 'tool').reused, true);
  const another = (await host.job('/api/v2/plugin-installations', { source: secondSource })).result;
  await inspect(host, second, another);
  assert.equal(requests(), 1);
  report.checks.shared_single_download = true;

  const mcpList = await rpc(host, 'deviceforge.list_plugin_installations');
  assert.equal(mcpList.length, 2);
  const disabled = (
    await host.job(
      `/api/v2/plugin-installations/${first.id}/enabled`,
      { expected_revision: current.revision, enabled: false },
      { method: 'PATCH' },
    )
  ).result;
  assert.equal(disabled.enabled, false);
  current = (
    await host.job(
      `/api/v2/plugin-installations/${first.id}`,
      { source: updateSource, expected_revision: current.revision },
      { method: 'PUT' },
    )
  ).result;
  assert.equal(current.enabled, false, '更新保留停用选择');
  current = (
    await host.job(
      `/api/v2/plugin-installations/${first.id}/enabled`,
      { expected_revision: current.revision, enabled: true },
      { method: 'PATCH' },
    )
  ).result;
  await inspect(host, update, current, { setting: '用户配置不丢失', value: '第二版本工具' });
  await inspect(host, second, another);
  await host.call('/api/v2/jobs', {
    method: 'POST',
    status: 409,
    headers: {
      'x-deviceforge-plugin-release': JSON.stringify({ id: first.id, revision: disabled.revision }),
    },
    input: { operation: `plugin.${first.serverId}.inspect`, input: {} },
  });
  report.checks.version_coexistence_disabled_update_and_stale_revision = true;

  await host.job(
    `/api/v2/plugin-installations/${first.id}`,
    { source: brokenSource, expected_revision: current.revision },
    { method: 'PUT', success: false },
  );
  assert.equal(
    (await host.call(`/api/v2/plugin-installations/${first.id}`)).revision,
    current.revision,
  );
  await inspect(host, update, current, { setting: '用户配置不丢失', value: '第二版本工具' });
  report.checks.failed_update_preserves_active_release = true;
  await persistedConfiguration(join(temporary, 'user'), first);
  await host.stop();
  host = null;
  await market.stop();

  // 市场已停止：同一用户根、更换业务根仍能恢复，完整离线包不再联网。
  host = await start('data-b');
  const restored = await host.call(`/api/v2/plugin-installations/${first.id}`);
  assert.equal(restored.revision, current.revision);
  await inspect(host, update, restored, { setting: '用户配置不丢失', value: '第二版本工具' });
  const artifact = await upload(host, offline);
  const imported = (
    await host.job('/api/v2/plugin-installations', {
      source: { kind: 'offline', artifact_id: artifact.id },
    })
  ).result;
  await inspect(host, offline, imported);
  await asset(host, imported);
  report.checks.offline_and_changed_data_root = true;
  await invalidOffline(host, negative, report);
  report.checks.invalid_dependencies_rejected_before_enable = true;
  await host.job(
    `/api/v2/plugin-installations/${first.id}/enabled`,
    { expected_revision: current.revision, enabled: false },
    { method: 'PATCH' },
  );
  await host.job(
    `/api/v2/plugin-installations/${first.id}`,
    { expected_revision: current.revision },
    { method: 'DELETE' },
  );
  await persistedConfiguration(join(temporary, 'user'), first);
  await inspect(host, second, another);
  const cleanup = await host.job('/api/v2/plugin-installations/cleanup', { dry_run: false });
  assert.equal(cleanup.result.dry_run, false);
  await inspect(host, second, another);
  report.checks.uninstall_preserves_configuration_and_shared_tool = true;
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (host) {
    try {
      await host.stop();
    } catch (error) {
      report.shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  if (market) {
    try {
      await market.stop();
    } catch (error) {
      report.market_shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(join(temporary, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      { passed: report.passed, report: reportPath, checks: report.checks, error: report.error },
      null,
      2,
    ),
  );
}
