import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

type RecordValue = Record<string, unknown>;
interface Protocol {
  call(method: string, params?: RecordValue, timeout?: number): Promise<unknown>;
  close(): void;
}
interface ProtocolModule {
  themeProtocol(url: string, evidence: RecordValue): Promise<Protocol>;
}
interface Observer {
  wait(milliseconds: number): Promise<unknown>;
  force(): Promise<unknown>;
}
interface LifecycleModule {
  observeChild(child: ChildProcess, evidence: RecordValue): Observer;
  normalExit(evidence: RecordValue): boolean;
}
interface Expectation {
  id: string;
  name: string;
  summary: string;
  description: string;
}

function object(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): RecordValue {
  assert.ok(object(value), '返回值不是有效对象');
  return value;
}
function protocolModule(value: unknown): value is ProtocolModule {
  return object(value) && typeof value['themeProtocol'] === 'function';
}
function lifecycleModule(value: unknown): value is LifecycleModule {
  return object(value) && typeof value['observeChild'] === 'function' && typeof value['normalExit'] === 'function';
}
function text(value: unknown): string {
  assert.ok(typeof value === 'string' && value.trim(), '缺少公开文本');
  return value;
}
function revision(value: unknown): number {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, '配置修订号无效');
  return value;
}

const project = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = join(project, 'artifacts', 'plugin-metadata-configuration-20261022', 'browser');
const runId = randomUUID();
const profile = join(output, 'profile-' + runId);
const devUrl = process.env['DEVICEFORGE_TEST_DEV_URL'] ?? 'http://127.0.0.1:5173/#marketplace';
const apiUrl = process.env['DEVICEFORGE_TEST_API_URL'] ?? 'http://127.0.0.1:7031';
const browserEvidence: RecordValue = { socket_events: [] };
const apiLogIds: string[] = [];
const checks: { name: string; passed: boolean }[] = [];
const screenshots: { name: string; width: number; height: number }[] = [];
const report: RecordValue = {
  timestamp: new Date().toISOString(), run_id: runId,
  scope: '真实开发页面与预览后端的插件元数据、配置读取及原值保存；不含真机投屏或媒体验收',
  checks, screenshots, api_log_ids: apiLogIds, browser_process: browserEvidence,
};
let child: ChildProcess | null = null;
let observer: Observer | null = null;
let browser: Protocol | null = null;
let page: Protocol | null = null;
let debuggingPort: number | null = null;
let stage = '页面与接口可达性';
const lifecycle: unknown = await import(pathToFileURL(join(project, 'scripts/unified-discovery-browser/lifecycle.mjs')).href);
assert.ok(lifecycleModule(lifecycle), '浏览器生命周期驱动不可用');
await mkdir(output, { recursive: true });

async function fetchData(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, apiUrl), { signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, '真实接口请求失败：' + response.status);
  const envelope = record(await response.json());
  const logId = text(envelope['log_id']);
  if (!apiLogIds.includes(logId)) apiLogIds.push(logId);
  return envelope['data'];
}
async function evaluate(expression: string): Promise<unknown> {
  assert.ok(page, '浏览器页面未连接');
  const reply = record(await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }));
  assert.ok(!reply['exceptionDetails'], '浏览器脚本执行失败');
  return record(reply['result'])['value'];
}
async function wait(expression: string, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(label + '未就绪');
}
async function click(name: string, scope = '[role="dialog"]'): Promise<void> {
  const clicked = await evaluate(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(b=>b.getClientRects().length&&(b.textContent.trim()===${JSON.stringify(name)}||b.getAttribute('aria-label')===${JSON.stringify(name)}));if(!b||b.disabled)return false;b.scrollIntoView({block:'center'});b.focus();b.click();return true;})()`);
  assert.ok(clicked === true, '未找到可用按钮：' + name);
  await delay(100);
}
async function openConfiguration(id: string): Promise<void> {
  const clicked = await evaluate(`(() => {const c=[...document.querySelectorAll('.marketplace-card')].find(c=>c.querySelector('[title="插件标识"]')?.textContent.trim()===${JSON.stringify(id)});const b=c&&[...c.querySelectorAll('button')].find(b=>b.textContent.trim()==='配置');if(!b||b.disabled)return false;b.scrollIntoView({block:'center'});b.click();return true;})()`);
  assert.ok(clicked === true, '插件配置入口不可用');
  await wait(`!!document.querySelector('[role="dialog"]')&&!document.querySelector('[role="dialog"]')?.textContent.includes('正在读取插件配置')`, '插件配置');
  assert.ok(await evaluate(`!document.querySelector('[role="dialog"] [role="alert"]')&&!document.querySelector('[role="dialog"]')?.textContent.includes('接口不存在')`), '插件配置出现错误');
}
async function closeDialog(): Promise<void> {
  const closed = await evaluate(`(() => {const d=document.querySelector('[role="dialog"]');if(!d)return false;const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()==='关闭')??d.querySelector('button[data-slot="dialog-close"]');if(!b)return false;b.click();return true;})()`);
  assert.ok(closed === true, '弹窗关闭入口缺失');
  await wait(`!document.querySelector('[role="dialog"]')`, '弹窗关闭');
}
async function capture(name: string, width: number, height: number): Promise<void> {
  assert.ok(page, '截图页面未连接');
  await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(async()=>{await document.fonts.ready;window.scrollTo(0,0);for(const el of document.querySelectorAll('*')){if(el.scrollTop)el.scrollTop=0;}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true;})()`);
  await delay(400);
  const result = record(await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
  const data = text(result['data']);
  await writeFile(join(output, name + '.png'), Buffer.from(data, 'base64'));
  screenshots.push({ name: name + '.png', width, height });
}
async function released(port: number): Promise<boolean> {
  const probe = createPortProbe();
  try {
    await new Promise<void>((done, fail) => { probe.once('error', fail); probe.listen(port, '127.0.0.1', done); });
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) await new Promise<void>((done) => probe.close(() => done()));
  }
}

try {
  const response = await fetch(devUrl, { signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, '现有开发页面不可达');
  const plugins = await fetchData('/api/v2/plugins');
  assert.ok(Array.isArray(plugins), '插件列表不是数组');
  const expected: Expectation[] = plugins.map((value: unknown) => {
    const plugin = record(value), metadata = record(plugin['metadata']);
    const entry = { id: text(plugin['id']), name: text(metadata['name']), summary: text(metadata['summary']), description: text(metadata['description']) };
    assert.ok(/[\u3400-\u9fff]/u.test(entry.name), '插件标题未提供中文外显名称');
    return entry;
  });
  assert.ok(expected.length === 13, '预览插件数量与本轮验收范围不一致');
  checks.push({ name: stage, passed: true });

  stage = '真实浏览器启动';
  const executable = process.env['DEVICEFORGE_TEST_BROWSER'] ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await access(executable);
  child = spawn(executable, [
    '--headless=new', '--disable-gpu', '--in-process-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  observer = lifecycle.observeChild(child, browserEvidence);
  const deadline = Date.now() + 15000;
  let endpoint = '';
  while (!endpoint && Date.now() < deadline) {
    const diagnostic = browserEvidence['diagnostic'];
    endpoint = typeof diagnostic === 'string' ? diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1] ?? '' : '';
    assert.ok(child.exitCode === null && !browserEvidence['spawn_error'], '验收浏览器提前退出');
    await delay(50);
  }
  assert.ok(endpoint, '验收浏览器调试端口未就绪');
  debuggingPort = Number(new URL(endpoint).port);
  const protocol: unknown = await import(pathToFileURL(join(project, 'scripts/browser-theme-smoke/cdp.mjs')).href);
  assert.ok(protocolModule(protocol), '浏览器调试驱动不可用');
  browser = await protocol.themeProtocol(endpoint, browserEvidence);
  const version = record(await browser.call('Browser.getVersion'));
  report['browser_version'] = text(version['product']);
  const targetUrl = new URL(endpoint);
  targetUrl.protocol = 'http:';
  targetUrl.pathname = '/json/new';
  targetUrl.search = '?' + encodeURIComponent(devUrl);
  const targetResponse = await fetch(targetUrl, { method: 'PUT', signal: AbortSignal.timeout(10000) });
  assert.ok(targetResponse.ok, '真实浏览器页面创建失败');
  const target = record(await targetResponse.json());
  page = await protocol.themeProtocol(text(target['webSocketDebuggerUrl']), browserEvidence);
  await page.call('Runtime.enable');
  await page.call('Page.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1024, deviceScaleFactor: 1, mobile: false });
  await wait(`!!document.querySelector('[data-product-page="marketplace"]')`, '资源市场');
  checks.push({ name: stage, passed: true });

  stage = '已安装插件中文元数据';
  await wait(`!![...document.querySelectorAll('[data-product-page="marketplace"] button')].find(b=>b.textContent.trim()==='已安装 13')`, '已安装列表入口');
  await click('已安装 13', '[data-product-page="marketplace"]');
  await wait(`document.querySelectorAll('.marketplace-card').length===13`, '已安装卡片');
  const installed = record(await evaluate(`(() => {const expected=${JSON.stringify(expected)};const cards=[...document.querySelectorAll('.marketplace-card')];return {count:cards.length,complete:expected.every(e=>{const c=cards.find(c=>c.querySelector('[title="插件标识"]')?.textContent.trim()===e.id);return c?.querySelector('h3')?.textContent.trim()===e.name&&c?.querySelector('.marketplace-card-content p')?.textContent.trim()===e.summary;}),incomplete:cards.filter(c=>c.textContent.includes('元数据不完整')).length};})()`));
  assert.ok(installed['count'] === 13 && installed['complete'] === true && installed['incomplete'] === 0, '已安装中文名称、辅助标识或简介不匹配');
  report['installed'] = installed;
  await capture('installed-desktop', 1536, 1024);
  checks.push({ name: stage, passed: true });

  stage = '详情中文描述';
  const android = expected.find((entry) => entry.id === 'android-device');
  assert.ok(android, 'Android 插件元数据缺失');
  await click('查看 ' + android.name + ' 详情', '[data-product-page="marketplace"]');
  await wait(`!!document.querySelector('.marketplace-description')`, '插件详情');
  assert.ok(await evaluate(`document.querySelector('.marketplace-description')?.textContent.trim()===${JSON.stringify(android.description)}`), '详情描述未使用插件中文元数据');
  await closeDialog();
  checks.push({ name: stage, passed: true });

  stage = 'Android 设备配置读取';
  await openConfiguration('android-device');
  const androidFields = record(await evaluate(`(() => {const d=document.querySelector('[role="dialog"]');const labels=[...d.querySelectorAll('.schema-form label')].map(e=>e.textContent.trim());return {label_count:labels.length,adb_label:labels.some(l=>l.includes('ADB')),save_action:[...d.querySelectorAll('button')].some(b=>b.textContent.trim()==='保存配置'&&!b.disabled),title:d.querySelector('[data-slot="dialog-title"]')?.textContent.includes('Android 设备')??d.textContent.includes('配置 · Android 设备')};})()`));
  assert.ok(androidFields['adb_label'] === true && androidFields['save_action'] === true && androidFields['title'] === true, 'Android 配置未显示 ADB 字段或保存入口');
  report['android_configuration'] = androidFields;
  await capture('android-config', 1536, 1024);
  await closeDialog();
  checks.push({ name: stage, passed: true });

  stage = 'DEX 无配置状态';
  await openConfiguration('dex-analysis');
  assert.ok(await evaluate(`document.querySelector('[role="dialog"]')?.textContent.includes('此插件无需配置。')&&![...document.querySelectorAll('[role="dialog"] button')].some(b=>b.textContent.trim()==='保存配置')`), 'DEX 未显示正确的无配置状态');
  await closeDialog();
  checks.push({ name: stage, passed: true });

  stage = '投屏配置原值保存与重新读取';
  const before = record(await fetchData('/api/v2/plugin-configurations/server/mirroring'));
  const beforeRevision = revision(before['revision']);
  await openConfiguration('mirroring');
  const mirroringFields = record(await evaluate(`(() => {const d=document.querySelector('[role="dialog"]');const labels=[...d.querySelectorAll('.schema-form label')].map(e=>e.textContent.trim());return {label_count:labels.length,scrcpy_label:labels.some(l=>l.includes('scrcpy')),adb_label:labels.some(l=>l.includes('ADB')),version_3_3_4:[...d.querySelectorAll('[role="combobox"], select')].some(e=>e.textContent.includes('3.3.4')),title:d.textContent.includes('配置 · 设备投屏与录制')};})()`));
  assert.ok(mirroringFields['scrcpy_label'] === true && mirroringFields['adb_label'] === true && mirroringFields['version_3_3_4'] === true && mirroringFields['title'] === true, '投屏配置字段或服务版本不匹配');
  await click('保存配置');
  await wait(`!![...document.querySelectorAll('[role="dialog"] [role="status"]')].find(e=>e.textContent.includes('配置已保存'))`, '投屏原值保存反馈');
  assert.ok(await evaluate(`!document.querySelector('[role="dialog"] [role="alert"]')`), '投屏原值保存出现错误');
  const saved = record(await fetchData('/api/v2/plugin-configurations/server/mirroring'));
  const savedRevision = revision(saved['revision']);
  assert.ok(savedRevision >= beforeRevision, '保存后的配置修订号倒退');
  assert.ok(isDeepStrictEqual(before['values'], saved['values']), '保存改变了投屏配置原值');
  await capture('mirroring-config', 1536, 1024);
  await click('重新读取');
  await wait(`!!document.querySelector('[role="dialog"] .schema-form')&&!document.querySelector('[role="dialog"]')?.textContent.includes('正在读取插件配置')`, '投屏配置重新读取');
  const reread = record(await fetchData('/api/v2/plugin-configurations/server/mirroring'));
  const rereadRevision = revision(reread['revision']);
  assert.ok(rereadRevision === savedRevision && isDeepStrictEqual(before['values'], reread['values']), '重新读取后投屏配置不一致');
  report['mirroring_configuration'] = { ...mirroringFields, before_revision: beforeRevision, saved_revision: savedRevision, reread_revision: rereadRevision, values_unchanged: true };
  await closeDialog();
  checks.push({ name: stage, passed: true });

  stage = '窄屏已安装列表';
  await capture('installed-mobile', 390, 844);
  const mobile = record(await evaluate(`(() => {const cards=[...document.querySelectorAll('.marketplace-card')];return {card_count:cards.length,incomplete_count:cards.filter(c=>c.textContent.includes('元数据不完整')).length,horizontal_overflow:document.documentElement.scrollWidth>window.innerWidth+1};})()`));
  assert.ok(mobile['card_count'] === 13 && mobile['incomplete_count'] === 0, '窄屏插件元数据不完整');
  report['mobile'] = mobile;
  checks.push({ name: stage, passed: true });
  report['passed'] = true;
} catch (error) {
  checks.push({ name: stage, passed: false });
  report['passed'] = false;
  report['failure'] = error instanceof Error ? error.message : '浏览器验收失败';
  if (page) {
    report['ui_failure'] = await evaluate(`(() => {const d=document.querySelector('[role="dialog"]');const text=d?.textContent??'';return {dialog_open:!!d,alert_count:d?.querySelectorAll('[role="alert"]').length??0,field_label_count:d?.querySelectorAll('.schema-form label').length??0,field_constraint_rejected:text.includes('配置不符合字段约束'),save_rejected:text.includes('保存被拒绝'),interface_not_found:text.includes('接口不存在'),log_ids:[...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)??[])]};})()`).catch(() => ({ unavailable: true }));
    if (stage === '投屏配置原值保存与重新读取') {
      await capture('mirroring-config', 1536, 1024).catch(() => {});
      await closeDialog().catch(() => {});
      await capture('installed-mobile', 390, 844).catch(() => {});
    }
  }
  process.exitCode = 1;
} finally {
  page?.close();
  if (browser) {
    await browser.call('Browser.close', {}, 5000).catch(() => {});
    browser.close();
  }
  if (observer) {
    try { await observer.wait(10000); }
    catch { await observer.force().catch(() => { report['browser_cleanup_failed'] = true; }); }
    report['browser_normal_exit'] = lifecycle.normalExit(browserEvidence);
    if (!report['browser_normal_exit']) { report['passed'] = false; process.exitCode = 1; }
  }
  if (debuggingPort !== null) {
    const deadline = Date.now() + 5000;
    let portReleased = false;
    while (!portReleased && Date.now() < deadline) { portReleased = await released(debuggingPort); if (!portReleased) await delay(100); }
    report['debugging_port_released'] = portReleased;
    if (!portReleased) { report['passed'] = false; process.exitCode = 1; }
  }
  const cleanupTarget = resolve(profile), withinOutput = relative(resolve(output), cleanupTarget);
  assert.ok(withinOutput === 'profile-' + runId && !isAbsolute(withinOutput) && !withinOutput.startsWith('..' + sep), '浏览器临时目录越界');
  try {
    await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    report['profile_removed'] = true;
  } catch {
    report['profile_removed'] = false; report['passed'] = false; process.exitCode = 1;
  }
  delete browserEvidence['diagnostic'];
  report['finished_at'] = new Date().toISOString();
  const reportText = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(output, 'report-' + runId + '.json'), reportText);
  await writeFile(join(output, 'report.json'), reportText);
  console.log(JSON.stringify(report, null, 2));
}
