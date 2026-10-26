// 只准备独占真实宿主和生产网页；浏览器交互由已注册的 cua_repl 完成。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createListener } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest, identity, save, tree } from './plugin-dependencies-smoke/evidence.mjs';
import { prepareFixtures } from './plugin-dependencies-smoke/fixtures.mjs';
import { client } from './plugin-dependencies-smoke/client.mjs';
import { environment } from './plugin-dependencies-smoke/host.mjs';
import { listenerReleased } from './plugin-dependencies-smoke/source.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  assert.ok(['--binary-path', '--dist-directory', '--output-directory'].includes(args[index]), '未知参数');
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), '参数缺值');
  assert.equal(options[args[index]], undefined, '参数不能重复');
  options[args[index]] = resolve(args[index + 1]);
}
assert.ok(options['--binary-path'], '必须显式指定本轮冻结宿主');
const runId = randomUUID();
const root = options['--output-directory'] ?? join(repository, 'artifacts', `plugin-dependencies-browser-${runId}`);
assert.ok(root.startsWith(join(repository, 'artifacts') + '\\'), '输出必须在本项目 artifacts 内');
await mkdir(root);
const report = { run_id: runId, started_at: new Date().toISOString(), directory: root, driver_pid: process.pid,
  passed: false, state: 'preparing', hosts: [], requests: [], jobs: [], checks: [], reclamation: [],
  proxy: [], source_requests: [], pending: ['真实浏览器交互与独立图审'],
  scope: '新冻结 debug 宿主、当前 dist 原字节、公开 API 安装夹具与真实依赖下载；不替代真实市场、官方来源、npx、真机或其他平台' };
report.driver_input = await identity(fileURLToPath(import.meta.url));
let host, source, product, stopRequested = false;
const stop = () => { stopRequested = true; };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
const inputs = [join(repository, 'scripts/plugin-dependencies-smoke.mjs'),
  ...(await tree(join(repository, 'scripts/plugin-dependencies-smoke'))).map((file) => join(repository, 'scripts/plugin-dependencies-smoke', file.path))];
const before = await Promise.all(inputs.map(identity));
await save(join(root, 'inputs-before.json'), before);
const execute = promisify(execFile);
async function processRecords(filter) {
  const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; "
    + "$items=@(Get-CimInstance Win32_Process -Filter $env:DF_BROWSER_PROCESS_FILTER | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='CreatedAt';e={$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -InputObject $items -Compress";
  const { stdout } = await execute('pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000,
      env: { ...process.env, DF_BROWSER_PROCESS_FILTER: filter }, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
}
async function listenerOwners(port) {
  // 当前机器全量 CIM 与网络 CIM 可能报错；只用原生 netstat 读取真实监听，不把查询失败当空集合。
  const { stdout } = await execute(join(process.env.SystemRoot, 'System32/netstat.exe'), ['-ano', '-p', 'tcp'],
    { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  return [...new Set(stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 5 && parts[0] === 'TCP' && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING')
    .map((parts) => Number(parts[4])))];
}
async function ownedProcesses(directory, hosts = report.hosts) {
  const records = new Map(), queue = [];
  for (const entry of hosts) {
    if (!entry.pid) continue;
    const current = (await processRecords(`ProcessId = ${entry.pid}`))[0];
    if (current) {
      assert.equal(current.ExecutablePath?.toLowerCase(), entry.binary.path.toLowerCase(), '宿主 PID 字节路径身份不符');
      if (entry.os_identity) assert.equal(current.CreatedAt, entry.os_identity.CreatedAt, '宿主 PID 已复用');
      records.set(current.ProcessId, current);
    }
    queue.push({ pid: entry.pid, start: Date.parse(entry.started_at), end: entry.exit ? Date.parse(entry.exit.at) : Infinity });
  }
  const seen = new Set();
  while (queue.length) {
    const owner = queue.shift();
    if (seen.has(owner.pid)) continue;
    seen.add(owner.pid);
    for (const child of await processRecords(`ParentProcessId = ${owner.pid}`)) {
      const created = Date.parse(child.CreatedAt);
      if (created < owner.start || created > owner.end) continue;
      records.set(child.ProcessId, child);
      queue.push({ pid: child.ProcessId, start: created, end: Infinity });
    }
  }
  return [...records.values()];
}
async function reclaim(directory) {
  const remaining = await ownedProcesses(directory);
  for (const candidate of [...remaining].reverse()) {
    const current = (await processRecords(`ProcessId = ${candidate.ProcessId}`))[0];
    if (!current) continue;
    assert.equal(current.CreatedAt, candidate.CreatedAt, '回收前 PID 身份发生变化');
    assert.equal(current.CommandLine, candidate.CommandLine, '回收前命令发生变化');
    await execute(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(candidate.ProcessId), '/F'],
      { windowsHide: true, timeout: 10000 });
    report.reclamation.push({ pid: candidate.ProcessId, command: candidate.CommandLine, created_at: candidate.CreatedAt,
      reclaimed: true, forced: true });
  }
  report.remaining_processes = await ownedProcesses(directory);
  assert.deepEqual(report.remaining_processes, [], '本轮归属进程必须全部结束');
  return remaining.length;
}
async function listen(server) {
  server.requestTimeout = 20000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}
async function close(service) {
  if (!service) return;
  service.server.closeAllConnections();
  await new Promise((done, reject) => service.server.close((error) => error ? reject(error) : done()));
  await listenerReleased(service.port);
  report.reclamation.push({ pid: process.pid, command: `驱动内 HTTP ${service.base}`, reclaimed: true, listener_released: true });
}
async function launchBrowserHost({ binaryPath, sourceBase, envProgram }) {
  const original = await identity(binaryPath), binary = join(root, 'host/apk-server.exe');
  await mkdir(dirname(binary));
  await copyFile(binaryPath, binary);
  const copied = await identity(binary);
  assert.equal(copied.sha256, original.sha256, '冻结宿主复制必须保持字节身份');
  report.frozen_binary = original;
  const reservation = createListener();
  await new Promise((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); });
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  assert.ok(![7031, 5173, 5186].includes(port), '不能占用用户服务端口');
  const env = environment(root, port, sourceBase, envProgram);
  for (const path of [env.APK_DATA_DIR, env.APK_PLUGIN_DIR, env.APK_BROWSER_PLUGIN_DIR, join(root, 'responses')]) {
    await mkdir(path, { recursive: true });
  }
  assert.deepEqual(await ownedProcesses(root), [], '不能重复启动同一证据根的宿主');
  const logs = ['stdout', 'stderr'].map((name) => createWriteStream(join(root, `host.${name}.log`), { flags: 'wx' }));
  const entry = { binary: copied, port, user_root: env.DEVICEFORGE_USER_DIR,
    started_at: new Date().toISOString(), startup_timeout_ms: 120000 };
  report.hosts.push(entry);
  const child = spawn(binary, [], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  entry.pid = child.pid;
  child.stdout.pipe(logs[0]); child.stderr.pipe(logs[1]);
  let spawnError, stopped = false;
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((done) => child.once('close', (code, signal) => {
    entry.exit = { code, signal, at: new Date().toISOString() }; done(entry.exit);
  }));
  const api = client(`http://127.0.0.1:${port}`, join(root, 'responses'), report);
  async function stopHost() {
    if (stopped) return;
    let failure;
    try {
      if (child.exitCode === null && child.signalCode === null && !spawnError) {
        assert.deepEqual(await listenerOwners(port), [child.pid], '仅向归属已核对的宿主请求退出');
        assert.equal((await api.http('/api/v2/system/shutdown', { method: 'POST' })).stopping, true);
        entry.shutdown_requested = true;
      }
      const result = await Promise.race([closed, delay(12000, undefined, { ref: false })]);
      assert.ok(result, '宿主正常退出超时');
      assert.equal(result.code, 0); assert.equal(result.signal, null); entry.graceful = true;
    } catch (error) { failure = error; }
    try {
      const forced = await reclaim(root, report); entry.forced_reclamation = forced;
      if (forced) failure ??= new Error('宿主需要强制回收，整轮不能计为正常通过');
      assert.ok(await Promise.race([closed, delay(5000, undefined, { ref: false })]), '回收后未收到退出事件');
      await Promise.all(logs.map((stream) => finished(stream, { signal: AbortSignal.timeout(5000) })));
      await listenerReleased(port); entry.listener_released = true;
      assert.equal((await identity(binaryPath)).sha256, original.sha256, '冻结原宿主发生漂移');
      assert.equal((await identity(binary)).sha256, copied.sha256, '运行副本发生漂移');
      stopped = true;
      report.reclamation.push({ pid: child.pid, command: binary, reclaimed: true, graceful: Boolean(entry.graceful), exit: entry.exit });
    } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
  try {
    const deadline = Date.now() + entry.startup_timeout_ms;
    let healthy = false;
    do {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, '宿主就绪前退出');
      assert.ok(!stopRequested, '启动阶段收到停止请求');
      try { healthy = (await api.http('/api/v2/health')).status === 'ok'; } catch { healthy = false; }
      if (!healthy) await delay(250);
    } while (!healthy && Date.now() < deadline);
    assert.ok(healthy, '宿主在120秒内没有就绪');
    assert.deepEqual(await listenerOwners(port), [child.pid], '就绪端口归属不匹配');
    entry.os_identity = (await ownedProcesses(root, report.hosts)).find((item) => item.ProcessId === child.pid);
    assert.ok(entry.os_identity, '必须取得宿主真实进程身份');
    entry.ready_at = new Date().toISOString();
    assert.deepEqual(await api.http('/api/v2/plugins'), []);
    assert.deepEqual(await api.http('/api/v2/jobs?limit=100'), []);
    return { api, entry, stop: stopHost };
  } catch (error) {
    try { await stopHost(); } catch (cleanupError) { report.start_cleanup_error = cleanupError.stack; }
    throw error;
  }
}
try {
  const files = new Map();
  source = await listen(createServer(async (incoming, outgoing) => {
    const entry = { method: incoming.method, path: incoming.url, at: new Date().toISOString(), bytes: 0 };
    report.source_requests.push(entry);
    const file = files.get(incoming.url);
    if (!file || !['GET', 'HEAD'].includes(incoming.method)) { entry.status = 404; outgoing.writeHead(404).end(); return; }
    entry.status = 200;
    outgoing.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size });
    if (incoming.method === 'HEAD') { outgoing.end(); return; }
    const throttle = new Transform({ transform(bytes, encoding, done) {
      entry.bytes += bytes.length;
      // 可选依赖保留可观察的真实下载进度，不伪造 Job 或页面状态。
      if (incoming.url === '/node-optional.zip') delay(4).then(() => done(null, bytes));
      else done(null, bytes);
    } });
    try { await pipeline(createReadStream(file.path), throttle, outgoing); entry.finished = true; }
    catch (error) { entry.error = error.message; outgoing.destroy(); }
    entry.finished_at = new Date().toISOString();
  }));
  const fixtures = await prepareFixtures(root, source.base, runId);
  for (const [path, file] of Object.entries(fixtures.sources)) files.set(path, file);
  host = await launchBrowserHost({ binaryPath: options['--binary-path'], sourceBase: source.base,
    envProgram: fixtures.envProgram });
  // 只安装服务器组件夹具，避免通用 HTTP 夹具的简化浏览器模块影响页面同步。
  const selected = ['b', 'empty', 'badDigest'];
  for (const name of selected) {
    const fixture = fixtures.releases[name];
    const artifact = await host.api.http('/api/v2/plugin-installations/artifacts?filename=release-v2.zip', {
      method: 'POST', bytes: await readFile(fixture.file), status: 201, contentType: 'application/octet-stream',
    });
    const submitted = await host.api.http('/api/v2/plugin-installations', { method: 'POST', status: 202,
      input: { source: { kind: 'offline', artifact_id: artifact.id } } });
    // debug 宿主真实大文件校验单独给有界窗口，不改已冻结 HTTP 验收的期限。
    let final;
    const deadline = Date.now() + 240000;
    do {
      final = await host.api.http(`/api/v2/jobs/${submitted.id}`);
      if (['succeeded', 'failed', 'cancelled'].includes(final.status)) break;
      await delay(250);
    } while (!stopRequested && Date.now() < deadline);
    report.jobs.push(final);
    assert.equal(final.status, 'succeeded', `公开安装 ${name} 未成功：${JSON.stringify(final)}`);
    report.checks.push({ name: `公开 API 安装 ${name}`, target: fixtures.releases[name].target,
      view: await host.api.view(fixtures.releases[name].target) });
  }
  report.fixture_targets = Object.fromEntries(selected.map((name) => [name, fixtures.releases[name].target]));
  report.assets = [];
  const assets = new Map(), dist = options['--dist-directory'] ?? join(repository, 'frontend/dist');
  for (const item of await tree(dist)) {
    const bytes = await readFile(join(dist, item.path));
    assert.equal(bytes.length, item.size);
    assert.equal(digest(bytes), item.sha256, '读取 dist 期间不能混入变化后的字节');
    assets.set('/' + item.path, bytes); report.assets.push(item);
  }
  assert.ok(assets.has('/index.html') && assets.has('/assets/app.js'), '当前生产 dist 不完整');
  await save(join(root, 'dist-inputs.json'), report.assets);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
  product = await listen(createServer(async (incoming, outgoing) => {
    const path = new URL(incoming.url, 'http://127.0.0.1').pathname;
    if (path.startsWith('/api/')) {
      const entry = { method: incoming.method, path: incoming.url, at: new Date().toISOString() };
      report.proxy.push(entry);
      const upstream = request(new URL(incoming.url, `http://127.0.0.1:${host.entry.port}`), {
        method: incoming.method, headers: { ...incoming.headers, host: `127.0.0.1:${host.entry.port}` },
      }, (response) => {
        entry.status = response.statusCode; entry.log_id = response.headers['x-deviceforge-log-id'];
        outgoing.writeHead(response.statusCode, response.headers);
        const chunks = [];
        response.on('data', (bytes) => chunks.push(bytes));
        response.on('end', () => { entry.body = Buffer.concat(chunks).toString('utf8'); });
        response.pipe(outgoing);
      });
      upstream.on('error', (error) => { entry.error = error.message; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream); return;
    }
    if (path === '/favicon.ico') { outgoing.writeHead(204).end(); return; }
    const name = path === '/' ? '/index.html' : path, bytes = assets.get(name);
    outgoing.writeHead(bytes ? 200 : 404, { 'content-type': types[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    outgoing.end(bytes ?? '本轮生产前端不存在该资源');
  }));
  report.host_origin = `http://127.0.0.1:${host.entry.port}`;
  report.product_origin = product.base;
  report.source_origin = source.base;
  report.state = 'ready-for-browser';
  report.control = { stop_file: join(root, 'STOP'), deadline_minutes: 30 };
  await save(join(root, 'ready.json'), report);
  console.log(JSON.stringify({ state: report.state, root, product: product.base, host: report.host_origin, targets: report.fixture_targets, pid: process.pid }));
  const deadline = Date.now() + 30 * 60 * 1000;
  while (!stopRequested && Date.now() < deadline) {
    try { await readFile(report.control.stop_file); stopRequested = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await save(join(root, 'live-report.json'), report);
    if (!stopRequested) await delay(1000);
  }
  assert.ok(stopRequested, '浏览器验收窗口到期，不能当作成功');
  report.state = 'browser-window-closed';
  report.pending = ['业务、视觉与浏览器关闭结果见 browser-result.json 和 visual-review.md；准备器不自行宣称浏览器通过'];
} catch (error) { report.state = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  for (const [name, finish] of [['product', () => close(product)], ['host', () => host?.stop()], ['source', () => close(source)]]) {
    try { await finish(); }
    catch (error) { (report.cleanup_errors ??= []).push({ name, error: error.stack }); process.exitCode = 1; }
  }
  const after = await Promise.all(inputs.map(identity));
  await save(join(root, 'inputs-after.json'), after);
  report.frozen_http_inputs_stable = JSON.stringify(before) === JSON.stringify(after);
  if (!report.frozen_http_inputs_stable) { report.input_error = '已冻结 HTTP 夹具输入发生漂移，不能外推验证'; process.exitCode = 1; }
  try {
    report.browser = JSON.parse(await readFile(join(root, 'browser-result.json'), 'utf8'));
    report.passed = report.browser.passed === true && report.frozen_http_inputs_stable && !report.cleanup_errors?.length;
    if (report.passed) { report.state = 'passed'; report.pending = report.browser.pending ?? []; }
  } catch (error) { if (error.code !== 'ENOENT') report.browser_result_error = error.message; }
  report.finished_at = new Date().toISOString();
  report.driver_reclamation = { pid: process.pid, command: process.argv.join(' '), exits_after_report: true };
  await save(join(root, 'report.json'), report);
  for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, stop);
  console.log(JSON.stringify({ state: report.state, root, cleanup_errors: report.cleanup_errors, inputs_stable: report.frozen_http_inputs_stable }));
}
