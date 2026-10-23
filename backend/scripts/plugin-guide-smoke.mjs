import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 只复制宿主二进制；临时工作目录没有仓库源码或指南文件。
const backend = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.every((value) => value === '--release'), '仅支持 --release 参数');
const profile = args.includes('--release') ? 'release' : 'debug';
const suffix = process.platform === 'win32' ? '.exe' : '';
const source = join(backend, 'target', profile, `apk-server${suffix}`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'deviceforge-guide-'));
const reportPath = resolve(backend, '../artifacts', `plugin-guide-${profile}-${randomUUID()}.json`);
const report = { timestamp: new Date().toISOString(), profile, passed: false, checks: [] };
const server = createServer();
await new Promise((done, reject) => server.once('error', reject).listen(0, '127.0.0.1', done));
const port = server.address().port;
await new Promise((done) => server.close(done));
const base = `http://127.0.0.1:${port}`;
const binary = join(temporary, `apk-server${suffix}`);
await copyFile(source, binary);
report.binary_sha256 = digest(await readFile(binary));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (key.startsWith('APK_') || key.startsWith('DEVICEFORGE_')) delete environment[key];
}
Object.assign(environment, {
  APK_BIND: `127.0.0.1:${port}`,
  APK_DATA_DIR: join(temporary, 'data'),
  APK_PLUGIN_DIR: join(temporary, 'plugins'),
  APK_BROWSER_PLUGIN_DIR: join(temporary, 'browser-plugins'),
  DEVICEFORGE_USER_DIR: join(temporary, 'user'),
  DEVICEFORGE_HTTP_RATE: '1000',
});
const child = spawn(binary, [], { cwd: temporary, env: environment, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
report.pid = child.pid;
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16384); });
let spawnError;
child.once('error', (error) => { spawnError = error; });
const closed = new Promise((done) => child.once('close', (code, signal) => done({ code, signal })));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let requestId = 0;
async function rpc(method, params) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method,
      ...(params.name ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'guide-smoke', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, requestId);
  const logId = response.headers.get('x-deviceforge-log-id');
  assert.ok(logId);
  assert.equal(body.result?._meta?.['deviceforge/log_id'] ?? body.error?.data?.log_id, logId);
  return body;
}

try {
  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, '宿主不应提前退出');
    try {
      ready = (await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(500) })).ok;
    } catch {}
    if (ready) break;
    await pause(100);
  }
  assert.ok(ready, '隔离宿主应按期启动');
  const initialized = await rpc('initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'guide-smoke', version: '1' },
  });
  assert.match(initialized.result.instructions, /deviceforge\.get_plugin_development_guide/);
  report.checks.push('初始化引导');
  const listed = await rpc('tools/list', {});
  const tool = listed.result.tools.find((entry) => entry.name === 'deviceforge.get_plugin_development_guide');
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.idempotentHint, true);
  report.checks.push('公开只读工具发现');
  const topics = ['overview', 'manifest', 'sdk', 'lifecycle', 'examples', 'packaging', 'validation'];
  report.documents = [];
  for (const target of ['frontend', 'backend', 'fullstack']) {
    for (const topic of topics) {
      const reply = await rpc('tools/call', { name: tool.name, arguments: { target, topic } });
      assert.notEqual(reply.result.isError, true);
      const data = reply.result.structuredContent;
      assert.equal(data.target, target);
      assert.equal(data.topic, topic);
      assert.equal(data.guide_version, 2);
      assert.equal(data.frontend_sdk_version, 2);
      assert.deepEqual(data.backend_task_protocol_versions, [1, 2, 3, 4]);
      assert.deepEqual(data.backend_session_protocol_versions, [5]);
      assert.deepEqual(data.release_format_versions, [1]);
      assert.deepEqual(data.release_host_api_versions, [2]);
      for (const term of ['release.json', '/api/v1/capabilities', 'catalog', 'DEVICEFORGE_PLUGIN_RESOURCES', 'configuration_required', '旧单组件']) {
        assert.ok(data.fullstack_workflow.includes(term), `配套流程缺少 ${term}`);
      }
      assert.equal(data.documents.length, target === 'fullstack' ? 2 : 1);
      for (const document of data.documents) {
        assert.ok(document.content.length > 100);
        assert.equal(document.topic, topic);
        report.documents.push({ target: document.target, topic, bytes: Buffer.byteLength(document.content), sha256: digest(document.content) });
      }
      report.checks.push(`${target}/${topic}`);
    }
  }
  const defaultTopic = await rpc('tools/call', { name: tool.name, arguments: { target: 'frontend' } });
  assert.equal(defaultTopic.result.structuredContent.topic, 'overview');
  report.checks.push('默认主题');
  for (const argumentsValue of [{}, { target: 'unknown' }, { target: 'frontend', topic: null }, { target: 'backend', path: '../../private' }]) {
    const reply = await rpc('tools/call', { name: tool.name, arguments: argumentsValue });
    assert.ok(reply.error || reply.result.isError === true);
  }
  report.checks.push('非法参数与任意路径拒绝');
  const jobs = await fetch(`${base}/api/v2/jobs`, { signal: AbortSignal.timeout(3000) });
  assert.equal(jobs.status, 200);
  assert.deepEqual((await jobs.json()).data, []);
  report.checks.push('指南查询未产生任务');
  const stopping = await fetch(`${base}/api/v2/system/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  assert.equal(stopping.status, 200);
  const exit = await Promise.race([closed, pause(10000).then(() => { throw new Error('宿主退出超时'); })]);
  assert.equal(exit.code, 0);
  report.exit = exit;
  const released = createServer();
  await new Promise((done, reject) => released.once('error', reject).listen(port, '127.0.0.1', done));
  await new Promise((done) => released.close(done));
  report.checks.push('宿主零退出与端口释放');
  assert.equal(report.binary_sha256, digest(await readFile(binary)));
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message };
  report.stderr = stderr;
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && !spawnError) {
    child.kill();
    report.forced_exit = await closed;
  }
  const within = relative(resolve(tmpdir()), resolve(temporary));
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '临时目录清理不得越界');
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  report.temporary_removed = true;
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`插件指南真实宿主验证：${report.passed ? '通过' : '失败'}，${reportPath}`);
}
