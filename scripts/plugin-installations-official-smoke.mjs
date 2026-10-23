// 当前十八份正式包经真实市场安装后，再断网向另一空用户根逐包导入。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './plugin-installations-smoke/host.mjs';
import { launchMarket } from './plugin-installations-smoke/market.mjs';
import { publish, upload } from './plugin-installations-smoke/scenarios.mjs';
import { officialSources } from './plugin-releases/official.mjs';
import {
  supplySourceServer,
  verifySupplySource,
} from './plugin-installations-smoke/official-supply.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [batchArgument, binaryArgument] = process.argv.slice(2);
assert.ok(
  batchArgument && binaryArgument && process.argv.length === 4,
  '用法：node plugin-installations-official-smoke.mjs 本轮构包目录 本轮release二进制目录',
);
const batch = resolve(batchArgument),
  binaryDirectory = resolve(binaryArgument);
const built = JSON.parse(await readFile(join(batch, 'build-report.json'), 'utf8'));
const official = (await officialSources(root)).reports;
assert.equal(built.complete, true);
assert.equal(built.platform, 'win32-x64');
assert.equal(built.reports.length, 18);
assert.deepEqual(
  built.reports.map((entry) => entry.id).sort(),
  official.map((entry) => entry.id).sort(),
);
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-official-installations-'));
const report = {
  timestamp: new Date().toISOString(),
  batch,
  directory: temporary,
  profile: 'release',
  hosts: [],
  requests: [],
  online: [],
  offline: [],
  passed: false,
  scope:
    '十八官方完整发布真实市场安装与断网离线导入、空用户根工具绑定和配置；不执行设备、AI认证或终端命令',
};
let host, market, supply;
async function start(phase) {
  return launch({
    binary: join(binaryDirectory, 'apk-server.exe'),
    cwd: root,
    data: join(temporary, phase, 'data'),
    user: join(temporary, phase, 'user'),
    market: market.base,
    report,
  });
}
function verifyInstalled(value, manifest) {
  assert.equal(value.id, manifest.id);
  assert.equal(value.name, manifest.name);
  assert.ok(value.description.length > 0);
  assert.equal(value.version, manifest.version);
  assert.ok(
    ['enabled', 'configuration_required'].includes(value.status),
    `${value.id}: ${value.status}`,
  );
  assert.equal(value.enabled, value.status === 'enabled');
  assert.deepEqual(
    value.components.map((entry) => [entry.id, entry.version, entry.kind]),
    manifest.components.map((entry) => [entry.id, entry.version, entry.kind]),
  );
  for (const tool of manifest.tools.filter((tool) => tool.required))
    assert.ok(
      value.tools.some((entry) => entry.id === tool.id && entry.version === tool.version),
      `${value.id}缺少必需工具${tool.id}`,
    );
}
try {
  supply = await supplySourceServer();
  market = await launchMarket({
    binary: join(root, 'resource-server', 'target', 'release', 'deviceforge-resource-server.exe'),
    cwd: root,
    data: join(temporary, 'market'),
    report,
  });
  const fixtures = [];
  for (const packed of built.reports) {
    const source = official.find((item) => item.id === packed.id);
    const fixture = {
      ...packed,
      directory: join(batch, 'releases', packed.id),
      market: join(root, 'backend', 'plugins', source.directory, 'market.json'),
    };
    fixture.manifest = JSON.parse(await readFile(join(fixture.directory, 'release.json'), 'utf8'));
    fixture.source = await publish(fixture, market);
    fixtures.push(fixture);
  }
  host = await start('online');
  for (const fixture of fixtures) {
    console.log(`在线安装：${fixture.id}`);
    const plan = await host.call('/api/v2/plugin-installations/plan', {
      method: 'POST',
      input: fixture.source,
    });
    assert.equal(
      plan.issues.filter((issue) => issue.required && issue.code !== 'user_configuration').length,
      0,
      JSON.stringify(plan.issues),
    );
    const job = await host.job(
      '/api/v2/plugin-installations',
      { source: fixture.source },
      { timeout: 120000 },
    );
    verifyInstalled(job.result, fixture.manifest);
    report.online.push({
      id: fixture.id,
      status: job.result.status,
      revision: job.result.revision,
      tools: job.result.tools,
      job_id: job.id,
    });
  }
  assert.equal((await host.call('/api/v2/plugin-installations')).length, 18);
  const toolDigests = new Set(
    fixtures.flatMap((fixture) =>
      fixture.manifest.tools.flatMap((tool) => tool.variants.map((variant) => variant.sha256)),
    ),
  );
  for (const digest of toolDigests)
    assert.equal(
      market.counts.get(`GET /api/v1/resources/${digest}`),
      1,
      `共享资源${digest}只下载一次`,
    );
  await verifySupplySource(host, temporary, 'online', supply, report);
  await host.stop();
  host = null;
  await market.stop();
  await supply.stop();
  host = await start('offline');
  for (const fixture of fixtures) {
    console.log(`断网导入：${fixture.id}`);
    const artifact = await upload(host, fixture);
    const job = await host.job(
      '/api/v2/plugin-installations',
      { source: { kind: 'offline', artifact_id: artifact.id } },
      { timeout: 120000 },
    );
    verifyInstalled(job.result, fixture.manifest);
    report.offline.push({
      id: fixture.id,
      status: job.result.status,
      revision: job.result.revision,
      tools: job.result.tools,
      job_id: job.id,
    });
  }
  assert.equal((await host.call('/api/v2/plugin-installations')).length, 18);
  await verifySupplySource(host, temporary, 'offline', supply, report);
  report.checks = {
    official_coverage: '18/18',
    online_empty_user_root: true,
    offline_empty_user_root: true,
    all_required_tools_present: true,
    shared_resources_downloaded_once: true,
    configuration_required_explicit: report.online
      .filter((entry) => entry.status === 'configuration_required')
      .map((entry) => entry.id),
    tool_supply_remote_or_local_with_managed_root: true,
  };
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  if (host)
    try {
      await host.stop();
    } catch (error) {
      report.shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  if (market)
    try {
      await market.stop();
    } catch (error) {
      report.market_shutdown_error = error.stack;
      report.passed = false;
      process.exitCode = 1;
    }
  if (supply) await supply.stop();
  const bytes = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(temporary, 'report.json'), bytes);
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(
    join(root, 'artifacts', 'plugin-installations-official-smoke-release.json'),
    bytes,
  );
  console.log(
    JSON.stringify(
      { passed: report.passed, directory: temporary, checks: report.checks, error: report.error },
      null,
      2,
    ),
  );
}
