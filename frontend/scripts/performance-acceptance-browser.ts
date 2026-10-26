import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { createDefaultsBrowser, listenerReleased } from './plugin-defaults-browser/browser.ts';
import type { PerformanceAcceptanceHarness } from './performance-acceptance-harness.tsx';

type Fields = Record<string, unknown>;
type Browser = Awaited<ReturnType<typeof createDefaultsBrowser>>;
interface Identity { pid: number; parent: number; created: string; name: string }
const execute = promisify(execFile);
const object = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value);
function record(value: unknown): Fields {
  assert.ok(object(value), '验收结果必须是对象');
  return value;
}
function objects(value: unknown): Fields[] {
  assert.ok(Array.isArray(value), '验收字段必须是数组');
  return value.map((item: unknown) => record(item));
}
function number(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isFinite(value), '验收字段必须是有限数字');
  return value;
}
function message(error: unknown): string { return error instanceof Error ? error.message : '未知验收错误'; }
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超过限定时间`)), Math.max(1, ms));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const { values } = parseArgs({ options: {
  build: { type: 'string' }, backend: { type: 'string', default: 'http://127.0.0.1:7031' },
  output: { type: 'string' },
}, strict: true });
assert.ok(values.build && values.output,
  '用法：node frontend/scripts/performance-acceptance-browser.ts --build <生产构建目录> --output <输出目录> [--backend http://127.0.0.1:7031]');
assert.equal(process.platform, 'win32', '本入口只验收 Windows 隐藏 Edge 与进程身份回收');
const backend = new URL(values.backend ?? 'http://127.0.0.1:7031');
assert.ok(['http:', 'https:'].includes(backend.protocol) && !backend.username && !backend.password && !backend.search && !backend.hash,
  '后端 URL 不能携带凭据、查询或片段');
const buildDirectory = resolve(values.build);
const frontend = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(frontend, '..');
const outputRoot = resolve(values.output);
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, 'performance-'));
const profile = join(output, 'edge-profile');
const inputs: { path: string; bytes: number; sha256: string }[] = [];
const assets = new Map<string, Buffer>();
const checks: { name: string; at: string }[] = [];
const samples: Fields[] = [];
const captures: { file: string; width: number; height: number; phase: string }[] = [];
const browserEvidence: Fields = { socket_events: [], stages: [] };
const report: Fields = {
  started_at: new Date().toISOString(), build: buildDirectory, backend: backend.href, output,
  passed: false, checks, observations: samples, captures, inputs, browser_process: browserEvidence,
  scope: '生产 PerformancePage 与真实后端、已有在线 SM_G991U；不发现、不连接、不唤醒、不启动或重启游戏；图片待独立视觉代理审核',
};
let browser: Browser | null = null;
let server: ViteDevServer | null = null;
// 资源在异步 run 中创建，收尾按当时的所有权快照读取。
function resources(): { browser: Browser | null; server: ViteDevServer | null } { return { browser, server }; }
let port = 0;
let owned: Identity[] = [];
let stage = '核对生产构建资产';
let cancelled = false;
let finishing = false;
const started = Date.now();
const remaining = () => Math.max(1, 80000 - (Date.now() - started));
function onInterrupt() { cancelled = true; }
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onInterrupt);
function remember(identities: readonly Identity[]): void {
  const unique = new Map(owned.map((item) => [`${item.pid}/${item.created}`, item]));
  for (const item of identities) unique.set(`${item.pid}/${item.created}`, item);
  owned = [...unique.values()];
}

// 只定位唯一临时 profile 及已核对创建时间的后代，绝不按进程名结束用户 Edge。
async function profileProcesses(known: readonly Identity[] = []): Promise<Identity[]> {
  const script = `
$ErrorActionPreference = 'Stop'
$all = @(Get-CimInstance Win32_Process)
$known = ConvertFrom-Json $env:DEVICEFORGE_ACCEPTANCE_KNOWN
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($p in $all) {
  if (-not $p.CreationDate) { continue }
  $created = $p.CreationDate.ToUniversalTime().ToString('o')
  $old = @($known | Where-Object { $_.pid -eq $p.ProcessId -and $_.created -eq $created })
  if (($p.CommandLine -and $p.CommandLine.Contains($env:DEVICEFORGE_ACCEPTANCE_PROFILE)) -or $old.Count -gt 0) {
    [void]$ids.Add([uint32]$p.ProcessId)
  }
}
do {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([uint32]$p.ParentProcessId) -and $ids.Add([uint32]$p.ProcessId)) { $changed = $true }
  }
} while ($changed)
$result = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId;
    created = $_.CreationDate.ToUniversalTime().ToString('o'); name = $_.Name }
})
ConvertTo-Json -InputObject $result -Compress
`;
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, DEVICEFORGE_ACCEPTANCE_PROFILE: profile, DEVICEFORGE_ACCEPTANCE_KNOWN: JSON.stringify(known) },
  });
  const value: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  return objects(value).map((item) => {
    assert.equal(typeof item['created'], 'string');
    assert.equal(typeof item['name'], 'string');
    return { pid: number(item['pid']), parent: number(item['parent']), created: String(item['created']), name: String(item['name']) };
  });
}

async function forceOwned(identities: readonly Identity[]): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$identities = ConvertFrom-Json $env:DEVICEFORGE_ACCEPTANCE_IDENTITIES
$processes = @(Get-CimInstance Win32_Process)
foreach ($identity in $identities) {
  $p = $processes | Where-Object { $_.ProcessId -eq $identity.pid }
  if ($p -and $p.CreationDate -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $identity.created) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 3000, encoding: 'utf8',
    env: { ...process.env, DEVICEFORGE_ACCEPTANCE_IDENTITIES: JSON.stringify(identities) },
  });
}

async function freeze(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!finishing && !cancelled, '资产冻结已取消');
    const path = join(directory, item.name);
    if (item.isDirectory()) await freeze(path);
    else if (item.isFile() && !item.name.endsWith('.map')) {
      const content = await readFile(path);
      assert.ok(content.length <= 32 * 1024 * 1024, '单个生产资产超过 32 MiB');
      const name = relative(buildDirectory, path).replaceAll('\\', '/');
      assets.set('/' + name, content);
      inputs.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    }
  }
}
function mime(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}
async function evaluate(expression: string): Promise<unknown> {
  assert.ok(browser, '浏览器尚未启动');
  assert.ok(!cancelled && !finishing, '用户中断或验收已进入收尾');
  return bounded(browser.evaluate(expression), remaining(), stage);
}
const entry = '/assets/performance-acceptance-harness.js';
function invoke(method: keyof PerformanceAcceptanceHarness, args = ''): Promise<unknown> {
  return evaluate(`import(${JSON.stringify(entry)}).then(h=>h.${method}(${args}))`);
}
async function observation(): Promise<Fields> {
  const value = record(await invoke('observe'));
  samples.push(value);
  return value;
}
function passed(name: string): void { checks.push({ name, at: new Date().toISOString() }); }
async function waitFor(test: (value: Fields) => boolean, name: string, ms = 12000): Promise<Fields> {
  const deadline = Math.min(Date.now() + ms, started + 80000);
  let last: Fields | null = null;
  while (Date.now() < deadline) {
    last = await observation();
    assert.deepEqual(last['blocked'], [], '安全闸门曾拦截越界请求');
    assert.equal(last['error'], null, '生产性能模型报错');
    if (test(last)) return last;
    const session = last['session'];
    assert.ok(!object(session) || ['running', 'paused'].includes(String(session['state'])), `${name}之前采集已进入终态`);
    await delay(150);
  }
  throw new Error(`${name}未满足；末次点数 ${String(last?.['count'])}`);
}

function curvesReady(value: Fields): boolean {
  const charts = value['charts'];
  return Array.isArray(charts) && charts.length === 2 && charts.every((chart: unknown) =>
    object(chart) && typeof chart['width'] === 'number' && chart['width'] > 0 &&
    typeof chart['height'] === 'number' && chart['height'] > 0 &&
    Array.isArray(chart['series']) && chart['series'].length > 0 &&
    chart['series'].every((series: unknown) => object(series) &&
      Array.isArray(series['data']) && series['data'].length === value['count']));
}
function curves(value: Fields): Map<string, number> {
  assert.ok(curvesReady(value), '所有曲线必须有正尺寸 Canvas 和与真实样本等长的 ECharts series.data');
  const result = new Map<string, number>();
  for (const chart of objects(value['charts'])) {
    assert.ok(number(chart['canvasWidth']) > 0 && number(chart['canvasHeight']) > 0, 'Canvas 位图尺寸必须非零');
    for (const series of objects(chart['series'])) {
      const data: unknown = series['data'];
      assert.ok(Array.isArray(data));
      result.set(`${String(chart['label'])}/${String(series['id'])}`, data.length);
    }
  }
  return result;
}
function grew(before: Fields, after: Fields): void {
  assert.ok(number(after['count']) > number(before['count']), '运行中模型点数没有增长');
  assert.equal(record(after['session'])['state'], 'running', '增长必须发生在运行中');
  const old = curves(before);
  const next = curves(after);
  assert.ok(old.size >= 4 && old.size === next.size, '必须包含 FPS 和三条性能曲线');
  for (const [id, count] of old) assert.ok((next.get(id) ?? 0) > count, `曲线 ${id} 的实际 series.data 没有增长`);
}
function highFps(value: Fields): void {
  const readings = objects(value['readings']);
  const fps = readings.flatMap((item) => typeof item['fps'] === 'number' && Number.isFinite(item['fps']) ? [item['fps']] : []);
  assert.ok(fps.length > 0, '真实后端没有返回 FPS');
  const high = Math.max(...fps);
  assert.ok(high > 60, '本轮未取得高于 60 FPS 的真实数据，不伪造高帧量程验收');
  const chart = objects(value['charts']).find((item) => item['label'] === '帧率曲线');
  assert.ok(chart, '缺少实际 FPS 图表');
  const axis = objects(chart['axes'])[0];
  assert.ok(axis && number(axis['max']) >= high && number(axis['min']) <= Math.min(...fps), 'FPS 量程裁切真实高帧数据');
  const series = objects(chart['series'])[0];
  assert.ok(series && Array.isArray(series['data']), 'FPS 实际序列缺失');
  assert.deepEqual(series['data'], readings.map((item) => item['fps']), 'FPS 图表数据不等于真实模型读数');
  report['fps_range'] = { peak: high, min: axis['min'], max: axis['max'] };
}
async function capture(name: string, width: number, height: number): Promise<void> {
  assert.ok(browser);
  const file = join(output, name + '.png');
  await bounded(browser.capture(file, width, height), remaining(), '保存页面 PNG');
  captures.push({ file, width, height, phase: stage });
}

async function run(): Promise<void> {
  await freeze(buildDirectory);
  assert.ok(!finishing && !cancelled, '资产冻结期间验收已取消');
  assert.ok(assets.has(entry), '缺少性能验收生产入口，请由主代理先构建');
  assert.ok(inputs.length <= 1024 && inputs.reduce((size, item) => size + item.bytes, 0) <= 256 * 1024 * 1024,
    '生产资产数量或总量超出验收上限');
  // 只服务内存中冻结的生产字节；Vite 不转换源码，不代理或替代真实后端。
  const created = await createServer({ root: frontend, configFile: false, appType: 'custom', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  if (finishing) { await created.close(); throw new Error('服务就绪时已超时，立即回收'); }
  server = created;
  server.middlewares.use((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    response.setHeader('cache-control', 'no-store');
    if (path === '/__performance_acceptance__') {
      const styles = [...assets.keys()].filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="${name}">`).join('');
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>真实性能采集验收</title>${styles}</head><body></body></html>`);
      return;
    }
    const bytes = assets.get(path);
    if (bytes) { response.setHeader('content-type', mime(path)); response.end(bytes); }
    else { response.statusCode = 404; response.end('不存在的冻结生产资产'); }
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  port = address.port;
  report['asset_server'] = { pid: process.pid, host: '127.0.0.1', port, in_process: true };
  stage = '启动独占隐藏浏览器';
  assert.deepEqual(await profileProcesses(), [], '相同 profile 已有进程，禁止启动重复实例');
  assert.ok(!finishing && !cancelled, '禁止在收尾后启动浏览器');
  const launched = await createDefaultsBrowser(project, profile, browserEvidence);
  if (finishing) { await launched.close(); throw new Error('浏览器就绪时已超时，立即回收'); }
  browser = launched;
  remember(await profileProcesses());
  assert.ok(owned.some((item) => item.pid === browserEvidence['pid']), '不能核对本轮 Edge 原始 PID 的所有权');
  report['owned_browser_processes'] = owned;
  await browser.navigate(`http://127.0.0.1:${port}/__performance_acceptance__`);
  stage = '挂载生产页面并只读刷新公开目录';
  report['mount'] = await invoke('mount', JSON.stringify(backend.href));
  await capture('00-ready-no-collection', 1536, 1024);
  passed('真实后端目录已有唯一在线 SM_G991U，未执行发现或连接');
  stage = '通过 DOM 开始 45 秒采集并开启采样画面';
  report['start'] = await invoke('begin');
  await invoke('enableFrames');
  passed('DOM 输入包名、45 秒、1000 毫秒，关闭先启动应用，再显式开启画面');
  stage = '等待少量真实点与正尺寸曲线';
  const first = await waitFor((value) => number(value['count']) >= 2 && curvesReady(value), '首批真实点与曲线');
  curves(first);
  await capture('01-running-few-points', 1536, 1024);
  stage = '等待运行中增长与真实画面';
  const second = await waitFor((value) => number(value['count']) > number(first['count']) &&
    curvesReady(value) && objects(value['frames']).length >= 1, '更多真实点及已解码近邻画面');
  grew(first, second);
  highFps(second);
  assert.deepEqual(second['imageFailures'], [], '出现设备画面解码或近邻关联失败');
  passed('模型点数与每条 ECharts series.data 首次增长，高帧量程包含真实峰值，至少一帧成功解码并近邻关联');
  stage = '消费暂停与继续';
  report['pause'] = await invoke('control', '"pause"');
  const paused = record(await invoke('readState'));
  await delay(1250);
  const stillPaused = record(await invoke('readState'));
  assert.equal(record(stillPaused['session'])['state'], 'paused');
  assert.equal(record(stillPaused['session'])['samples'], record(paused['session'])['samples'], '暂停后服务器仍新增采集');
  assert.equal(stillPaused['count'], paused['count'], '暂停后页面仍追加样本');
  report['paused_stability'] = { before: paused, after: stillPaused };
  await invoke('control', '"resume"');
  const third = await waitFor((value) => number(value['count']) > number(second['count']) &&
    number(value['count']) > number(stillPaused['count']) && curvesReady(value), '恢复后的第二次点数与曲线增长');
  grew(second, third);
  highFps(third);
  passed('暂停被真实消费且稳定，继续后模型与所有曲线第二次增长');
  stage = '保存多点与画面、消费终止';
  await capture('02-many-points-with-frames', 1536, 1024);
  // 运行中多点图保留后立即停止，再拍窄屏，避免窄屏排版挤占控制按钮的真实运行窗口。
  report['stop'] = await invoke('control', '"stop"');
  const terminal = record(await invoke('readTerminal'));
  await capture('03-narrow', 390, 1100);
  const narrow = await observation();
  curves(narrow);
  highFps(narrow);
  assert.equal(number(record(narrow['viewport'])['width']), 390, '窄屏视口尺寸没有生效');
  assert.ok(number(record(narrow['viewport'])['documentWidth']) <= 390, '窄屏页面产生横向溢出');
  assert.deepEqual(narrow['imageFailures'], [], '窄屏画面解码或关联失败');
  report['narrow'] = narrow;
  passed('390 像素窄屏仍有非零 Canvas、真实曲线与已解码画面，未发生文档横向溢出');
  await delay(2200);
  const terminalAgain = record(await invoke('readTerminal'));
  assert.equal(record(terminalAgain['session'])['state'], 'stopped');
  assert.equal(record(terminalAgain['session'])['samples'], record(terminal['session'])['samples'], '终态后服务器仍追加采集');
  assert.equal(terminalAgain['count'], terminal['count'], '终态尾页收敛后页面仍增加点数');
  assert.deepEqual(terminalAgain['readings'], terminal['readings'], '终态后实际采集读数发生变化');
  const screenshotCount = (value: Fields) => objects(value['requests']).filter((item) => item['action'] === 'screenshot').length;
  assert.equal(screenshotCount(terminalAgain), screenshotCount(terminal), '终态后仍发起新的设备截图');
  assert.deepEqual(terminalAgain['blocked'], []);
  assert.deepEqual(terminalAgain['errors'], []);
  report['terminal_stability'] = { before: terminal, after: terminalAgain };
  passed('DOM 终止被消费，重复读取终态与尾页均无新指标或截图请求');
  stage = '核对冻结输入未变化';
  for (const input of inputs)
    assert.equal(createHash('sha256').update(await readFile(input.path)).digest('hex'), input.sha256, `生产构建在采集中变化：${input.path}`);
  assert.ok(!finishing && !cancelled, '验收已超时或取消');
  report['passed'] = true;
}

try {
  await bounded(run(), remaining(), '整轮功能验收');
} catch (error) {
  finishing = true;
  report['failure_stage'] = stage;
  report['error'] = message(error);
  const failedBrowser = resources().browser;
  if (failedBrowser) {
    report['failure_observation'] = await bounded(failedBrowser.evaluate(`import(${JSON.stringify(entry)}).then(h=>h.observe())`), 2000, '失败现场读取').catch(message);
    await bounded(failedBrowser.capture(join(output, 'failure.png'), 1536, 1024), 2500, '失败截图').catch(() => {});
  }
} finally {
  finishing = true;
  // 收尾不重启后端、游戏或设备；只撤销本次产品实例、内存资产服务和独占 profile 的 Edge。
  const cleanupErrors: string[] = [];
  const cleanupStarted = Date.now();
  const ownedResources = resources();
  if (ownedResources.browser) {
    report['app_cleanup'] = await bounded(ownedResources.browser.evaluate(`import(${JSON.stringify(entry)}).then(h=>h.dispose())`), 7500, '停止本轮采集与释放页面')
      .catch((error: unknown) => { cleanupErrors.push(message(error)); return null; });
  }
  try { remember(await profileProcesses(owned)); }
  catch (error) { cleanupErrors.push(message(error)); }
  try { await bounded(ownedResources.browser?.close() ?? Promise.resolve(), 6500, '关闭自有 Edge'); }
  catch (error) { cleanupErrors.push(message(error)); }
  let survivors: Identity[] = owned;
  try { survivors = await profileProcesses(owned); }
  catch (error) { cleanupErrors.push(message(error)); }
  try {
    if (survivors.length > 0) await forceOwned(survivors);
    const remainingProcesses = await profileProcesses(owned);
    report['browser_remaining'] = remainingProcesses;
    assert.deepEqual(remainingProcesses, [], '仍有本轮 Edge PID 未退出');
    report['process_cleanup'] = owned.map((item) => ({ ...item, exited: true }));
  } catch (error) { cleanupErrors.push(message(error)); }
  try {
    const http = ownedResources.server?.httpServer;
    if (http && 'closeAllConnections' in http) http.closeAllConnections();
    await bounded(ownedResources.server?.close() ?? Promise.resolve(), 4000, '关闭自有 Vite 资产服务');
    report['asset_listener_released'] = port === 0 || await listenerReleased(port);
    assert.equal(report['asset_listener_released'], true, '资产服务监听没有释放');
  } catch (error) { cleanupErrors.push(message(error)); }
  const appCleanup = report['app_cleanup'];
  if (!object(appCleanup) || appCleanup['stopped'] !== true || appCleanup['disposed'] !== true ||
      !Array.isArray(appCleanup['errors']) || appCleanup['errors'].length !== 0)
    cleanupErrors.push('未确认产品实例及本轮采集全部释放');
  if (cleanupErrors.length > 0) report['passed'] = false;
  if (Date.now() - started > 120000) {
    cleanupErrors.push('整轮验收及回收超过 120 秒预算');
    report['passed'] = false;
  }
  report['cleanup_errors'] = cleanupErrors;
  report['cleanup_ms'] = Date.now() - cleanupStarted;
  report['elapsed_ms'] = Date.now() - started;
  report['completed_at'] = new Date().toISOString();
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onInterrupt);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (report['passed'] !== true) process.exitCode = 1;
  console.log(`真实性能页面验收：${report['passed'] === true ? '功能通过，图片待视觉代理审核' : '未通过'}；证据：${output}`);
}
