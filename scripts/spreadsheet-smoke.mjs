import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHost, reservePort } from './android-packages-smoke/host.mjs';
import { business } from './spreadsheet-smoke/cases.mjs';
import { failure, fileIdentity, inputManifest, verifyLogs, writeJson } from './spreadsheet-smoke/evidence.mjs';
import { actualFrontend, freezeFrontend, verifyFrontend } from './spreadsheet-smoke/frontend.mjs';
import { prepareFixtures } from './spreadsheet-smoke/fixtures.mjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('表格插件功能验收：真实Rust宿主/插件、合法多表XLSX与CSV、HTTP/MCP及实际前端工厂。');
  console.log('node scripts/spreadsheet-smoke.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 [--profile=debug|release]');
  console.log('目录分别包含apk-server.exe、deviceforge-spreadsheet-plugin.exe与manifest.json；此入口不构建、不压测。');
  process.exit(0);
}
const flags = ['--frozen-input', '--plugin-input', '--profile'];
assert.ok(args.every(value => flags.some(flag => value.startsWith(flag + '='))), 'SS-UNKNOWN-ARGUMENT');
for (const flag of flags) assert.ok(args.filter(value => value.startsWith(flag + '=')).length <= 1, 'SS-DUPLICATE-ARGUMENT');
const option = flag => args.find(value => value.startsWith(flag + '='))?.slice(flag.length + 1);
assert.ok(option('--frozen-input') && option('--plugin-input'), 'SS-EXPLICIT-FROZEN-INPUT');
const profile = option('--profile') ?? 'debug'; assert.ok(['debug', 'release'].includes(profile));
const root = fileURLToPath(new URL('../', import.meta.url)), frozen = resolve(option('--frozen-input')), pluginFrozen = resolve(option('--plugin-input'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const directory = join(root, 'artifacts', 'spreadsheet-service-' + profile + '-' + randomUUID()), snapshot = join(directory, 'snapshot');
await mkdir(snapshot, { recursive: true });
const report = { timestamp: new Date().toISOString(), profile, passed: false, checks: [], requests: [], jobs: [], artifacts: [],
  scope: '新冻结真实Rust宿主及直接spreadsheet插件、真实OOXML/CSV原字节、HTTP/MCP和实际前端冻结工厂、历史热装卸与正常宿主退出',
  limitations: ['当前没有真实XLS黄金样本，XLS解析未验，不用伪magic或改名文件转计',
    '实际前端模块在Node执行，不是浏览器界面、产品视觉或字段映射全部业务验收',
    '宿主以实际child close退出且释放监听，快速插件子进程以宿主监督及调用结束日志确认；未独立捕获每笔插件原OS句柄',
    '本批没有确定性打断Rust阻塞解析的门闩，不宣称取消/worker收口已验',
    '本机冻结目录不等同正式TGZ/npx、registry、跨平台或另一局域网主机；未执行性能压测'] };
let host, frontend, stage = '冻结输入';
const binaryNames = ['apk-server' + suffix, 'deviceforge-spreadsheet-plugin' + suffix, 'manifest.json'];
const sources = [join(frozen, binaryNames[0]), join(pluginFrozen, binaryNames[1]), join(pluginFrozen, binaryNames[2])];
try {
  const frontendRoot = await freezeFrontend(root, join(snapshot, 'frontend'), report);
  const inputPaths = [...sources, ...report.frontend_snapshots.map(entry => entry.source.path)];
  report.inputs_before = await inputManifest(fileURLToPath(import.meta.url), inputPaths); report.snapshots = [];
  for (let i = 0; i < sources.length; i++) {
    const source = await fileIdentity(sources[i]), target = join(snapshot, binaryNames[i]); await copyFile(sources[i], target);
    const actual = await fileIdentity(target); assert.equal(actual.sha256, source.sha256); assert.equal(actual.bytes, source.bytes); report.snapshots.push({ source, actual });
  }
  const fixtures = await prepareFixtures(join(directory, 'fixtures')); report.fixtures = await Promise.all(Object.values(fixtures).map(value => fileIdentity(value.path)));
  const manifest = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'spreadsheet'); assert.equal(manifest.protocol_version, 4);
  assert.deepEqual(manifest.operations.map(value => value.name).sort(), ['inspect', 'read']);
  manifest.executable = join(snapshot, binaryNames[1]);
  host = await prepareHost({ root, binary: join(snapshot, binaryNames[0]), directory: join(directory, 'data'), report, port: await reservePort() });
  await host.ready(); assert.ok(!(await host.client.tools()).some(name => name.startsWith('plugin.spreadsheet.')));
  const deployment = join(host.plugins, 'spreadsheet'); await mkdir(deployment);
  const deployedManifest = join(deployment, 'manifest.json'); await writeFile(deployedManifest, JSON.stringify(manifest), { flag: 'wx' });
  report.deployed_manifest = await fileIdentity(deployedManifest);
  const loaded = await host.client.post('/api/v2/plugins/spreadsheet/load'); assert.equal(loaded.state, 'loaded');
  const tools = await host.client.tools(); assert.ok(tools.includes('plugin.spreadsheet.inspect') && tools.includes('plugin.spreadsheet.read'));
  report.checks.push({ name: '直接冻结Rust插件动态加载、inspect/read进入MCP目录', passed: true });
  stage = '真实文件上传与原字节'; const artifacts = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const metadata = await host.client.json('/api/v2/artifacts?filename=' + encodeURIComponent(name), {
      method: 'POST', status: 201, headers: { 'content-type': 'application/octet-stream' }, body: fixture.bytes });
    assert.equal(metadata.filename, name); assert.equal(metadata.size, fixture.bytes.length); assert.equal(metadata.sha256, fixture.sha256);
    const mediaType = name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    assert.equal(metadata.media_type, mediaType); artifacts[name] = metadata; report.artifacts.push(metadata);
    const response = await fetch(host.client.base + '/api/v2/artifacts/' + metadata.id + '/content', { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); const logId = response.headers.get('x-deviceforge-log-id'); assert.match(logId, /^[a-f\d-]{36}$/);
    host.client.logIds.add(logId); assert.equal(response.headers.get('content-type'), mediaType);
    assert.equal(Number(response.headers.get('content-length')), fixture.bytes.length); assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes);
    report.requests.push({ path: '/api/v2/artifacts/' + metadata.id + '/content', method: 'GET', status: response.status, log_id: logId });
  }
  report.checks.push({ name: '三表真实XLSX与UTF8 CSV最低格式准入、摘要与全部下载原字节', passed: true });
  frontend = await actualFrontend(host, report, frontendRoot); stage = 'HTTP/MCP及实际前端业务';
  await business(host, report, frontend, artifacts, loaded); host.assertRunning(); frontend.dispose(); frontend = undefined;
  stage = '正常退出与日志'; await host.shutdown(); await host.verifyIdentity(); await verifyLogs(directory, host, report);
  await verifyFrontend(report); report.inputs_after = await inputManifest(fileURLToPath(import.meta.url), inputPaths);
  assert.deepEqual(report.inputs_after, report.inputs_before);
  for (const entry of report.snapshots) assert.deepEqual(await fileIdentity(entry.actual.path), entry.actual);
  assert.deepEqual(await fileIdentity(deployedManifest), report.deployed_manifest);
  assert.deepEqual(await Promise.all(Object.values(fixtures).map(value => fileIdentity(value.path))), report.fixtures);
  report.checks.push({ name: '宿主真实child close exit0、监听释放、每响应日志及Job调用配对和冻结字节稳定', passed: true }); report.passed = true;
} catch (error) { failure(report, error, stage); }
finally {
  try { frontend?.dispose(); } catch (error) { failure(report, error, '释放实际前端'); }
  if (host) { try { await host.finish(); } catch (error) { failure(report, error, '收口本轮宿主'); } }
  report.completed_at = new Date().toISOString(); await writeJson(join(directory, 'report.json'), report);
  console.log(JSON.stringify({ directory, passed: report.passed, checks: report.checks.length, jobs: report.jobs.length, failure: report.failure }));
  process.exitCode = report.passed ? 0 : 1;
}
