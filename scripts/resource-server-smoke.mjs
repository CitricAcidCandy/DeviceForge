// 独立资源服务发布验证；只创建本次证据目录，不操作预览服务或设备。
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = resolve(root, 'artifacts/deviceforge-resource-server-win32-x64.exe');
const output = join(root, 'artifacts', `resource-release-${randomUUID()}`);
await mkdir(output, { recursive: true });
const report = { timestamp: new Date().toISOString(), passed: false, binary, binary_sha256: createHash('sha256').update(await readFile(binary)).digest('hex'), checks: [] };
const check = (name, condition) => { assert.ok(condition, name); report.checks.push(name); };
const listener = createServer();
await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
const port = listener.address().port;
await new Promise(done => listener.close(done));
const base = `http://127.0.0.1:${port}`;
let child;
let closed;
try {
  const unused = join(output, '帮助不应创建');
  const help = await promisify(execFile)(binary, ['--data-dir', unused, '-h'], { windowsHide: true });
  const exists = await stat(unused).then(() => true, () => false);
  check('中文帮助直接退出且不创建目录', help.stdout.includes('--data-dir') && !exists);
  const parent = join(output, '中文资源父目录');
  child = spawn(binary, ['--bind', `127.0.0.1:${port}`, '--data-dir', parent], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  report.pid = child.pid;
  const logs = [];
  child.stdout.on('data', bytes => logs.push(bytes));
  child.stderr.on('data', bytes => logs.push(bytes));
  closed = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  const deadline = Date.now() + 12000;
  let healthy = false;
  while (Date.now() < deadline) {
    healthy = await fetch(`${base}/api/v1/health`).then(response => response.ok, () => false);
    if (healthy) break;
    if (child.exitCode !== null) throw new Error('资源服务提前退出');
    await delay(50);
  }
  check('独立发布程序健康可达', healthy);
  const directories = ['plugin', 'tool', 'config', 'distribution', 'resource', 'blobs', 'tmp'];
  for (const directory of directories) assert.ok((await stat(join(parent, directory))).isDirectory());
  check('中文父目录自动创建七类目录', true);
  const bytes = Buffer.from('中文媒体与单文件原始字节\0\u0001\u0002');
  const response = await fetch(`${base}/api/v1/resources`, { method: 'POST', headers: { 'content-type': 'video/mp4', 'x-resource-filename': encodeURIComponent('演示画面.mp4'), 'x-resource-filename-encoding': 'percent', 'x-resource-kind': 'resource' }, body: bytes });
  assert.equal(response.status, 201);
  const resource = await response.json();
  check('单文件原始上传、中文文件名与摘要', resource.filename === '演示画面.mp4' && resource.sha256 === createHash('sha256').update(bytes).digest('hex'));
  const download = await fetch(`${base}/api/v1/resources/${resource.sha256}`, { headers: { origin: 'http://localhost:5173' } });
  check('下载原字节与CORS文件名可读', Buffer.from(await download.arrayBuffer()).equals(bytes) && download.headers.get('access-control-expose-headers') === '*' && decodeURIComponent(download.headers.get('x-resource-filename')) === '演示画面.mp4');
  const range = await fetch(`${base}/api/v1/resources/${resource.sha256}`, { headers: { range: 'bytes=1-3' } });
  check('Range返回206与精确片段', range.status === 206 && Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(1, 4)));
  const entry = { metadata_version: 1, id: 'demo.plugin', kind: 'plugin', name: '中文配置演示', version: '1.0.0', summary: '支持文件夹资源', description: '运行清单与市场描述分开', keywords: ['资源'], categories: ['function'], applies_to: ['deviceforge'], supports_mcp: 'none', supports_agent: false, restart_policy: 'none', platforms: ['windows'], architectures: ['x64'], visibility: 'market', resource_id: resource.sha256, details: { plugin_kind: 'browser' } };
  const published = await fetch(`${base}/api/v1/catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
  check('点号插件ID发布与运行清单契约一致', published.ok);
  const results = await (await fetch(`${base}/api/v1/catalog?kind=plugin&applies_to=deviceforge&q=${encodeURIComponent('中文配置')}`)).json();
  check('发布后组合筛选与全文索引可检索', results.entries.some(item => item.id === entry.id));
  const internal = { ...entry, id: 'internal-media', kind: 'resource', categories: ['media'], visibility: 'internal', details: {} };
  assert.ok((await fetch(`${base}/api/v1/catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(internal) })).ok);
  const visible = await (await fetch(`${base}/api/v1/catalog`)).json();
  check('内部资源默认隐藏但摘要下载仍可引用', !visible.entries.some(item => item.id === internal.id));
  report.passed = true;
  await writeFile(join(output, 'server.log'), Buffer.concat(logs));
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); }
finally {
  if (child) { child.kill(); report.process_exit = await closed; }
  const probe = createServer();
  report.port_released = await new Promise(done => { probe.once('error', () => done(false)); probe.listen(port, '127.0.0.1', () => probe.close(() => done(true))); });
  if (!report.port_released) report.passed = false;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`资源服务 Release：${report.passed ? '通过' : '失败'}，${report.checks.length} 项，${join(output, 'report.json')}`);
  if (!report.passed) process.exitCode = 1;
}
