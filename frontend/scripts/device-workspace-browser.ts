import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

type RecordValue = Record<string, unknown>;
interface Protocol {
  call(method: string, params?: RecordValue, timeout?: number): Promise<unknown>;
  close(): void;
}
interface ProtocolModule {
  themeProtocol(url: string, evidence: RecordValue): Promise<Protocol>;
}
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function record(value: unknown): RecordValue {
  assert.ok(object(value));
  return value;
}
function protocolModule(value: unknown): value is ProtocolModule {
  return object(value) && typeof value['themeProtocol'] === 'function';
}
const frontend = fileURLToPath(new URL('../', import.meta.url));
const project = resolve(frontend, '..');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = join(project, 'artifacts', 'device-workspace', runId);
const bundle = join(output, 'bundle');
const profile = join(output, 'browser-profile');
const evidence: RecordValue = { socket_events: [], stages: [] };
const cases: { name: string; passed: boolean; error?: string; value?: unknown }[] = [];
const report: RecordValue = {
  timestamp: new Date().toISOString(),
  scope: '真实浏览器与产品组件，受控 API 设备目录/动作；不含 Rust 服务、实际设备或真机成功',
  output,
  cases,
  browser_process: evidence,
  screenshots: [],
};
let child: ChildProcess | null = null;
let browser: Protocol | null = null;
let page: Protocol | null = null;
let diagnostic = '';
const ownedPorts: number[] = [];
const server = await createServer({
  root: bundle,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
await mkdir(output, { recursive: true });

async function evaluate(expression: string): Promise<unknown> {
  assert.ok(page);
  const reply = record(await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }));
  if (reply['exceptionDetails']) throw new Error(JSON.stringify(reply['exceptionDetails']));
  return record(reply['result'])['value'];
}
async function wait(expression: string, label: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(label + '未就绪');
}
async function capture(name: string, width: number, height: number) {
  assert.ok(page);
  await page.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.fonts.ready');
  await delay(250);
  const reply = record(await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
  assert.equal(typeof reply['data'], 'string');
  const path = join(output, name + '.png');
  await writeFile(path, Buffer.from(String(reply['data']), 'base64'));
  const screenshots = report['screenshots'];
  assert.ok(Array.isArray(screenshots));
  screenshots.push({ path, width, height });
}
async function check(name: string, action: () => Promise<unknown>) {
  try {
    cases.push({ name, passed: true, value: await action() });
  } catch (error) {
    cases.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
    await capture('failure-' + cases.length, 1536, 1024).catch(() => {});
  }
}
async function click(name: string, scope = '[data-route="devices"]') {
  const result = await evaluate(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(b=>b.getClientRects().length&&(b.textContent.trim()===${JSON.stringify(name)}||b.getAttribute('aria-label')===${JSON.stringify(name)}));if(!b||b.disabled)return false;b.scrollIntoView({block:'center'});b.focus();b.click();return true;})()`);
  assert.equal(result, true, '未找到可用按钮：' + name);
  await delay(80);
}
async function fill(selector: string, value: string) {
  assert.equal(await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`), true, '输入框缺失');
  await delay(80);
}
async function choose(provider: string, localId: string) {
  const key = JSON.stringify([provider, 'generation-1', localId]);
  assert.equal(await evaluate(`(() => {const b=[...document.querySelectorAll('[data-device-reference]')].find(b=>b.getAttribute('data-device-reference')===${JSON.stringify(key)});if(!b)return false;b.focus();b.click();return true;})()`), true, '设备选择按钮缺失');
  await wait(`window.__harness.selected()?.reference.providerId===${JSON.stringify(provider)} && window.__harness.selected()?.reference.localId===${JSON.stringify(localId)}`, '设备选择');
}
async function openReadCapability() {
  assert.equal(await evaluate(`(() => {const outer=document.querySelector('.device-advanced');const detail=[...document.querySelectorAll('.device-capability-action')].find(d=>d.textContent.includes('packages@1'));if(!outer||!detail)return false;outer.open=true;detail.open=true;return true;})()`), true, '读取能力入口缺失');
  await delay(80);
}
async function released(port: number) {
  const probe = createPortProbe();
  try {
    await new Promise<void>((done, fail) => {
      probe.once('error', fail);
      probe.listen(port, '127.0.0.1', done);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) await new Promise<void>((done) => probe.close(() => done()));
  }
}

try {
  await build({
    root: frontend,
    configFile: false,
    logLevel: 'warn',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(frontend, 'src') } },
    build: {
      outDir: bundle,
      emptyOutDir: false,
      rolldownOptions: {
        input: { harness: join(frontend, 'scripts/device-workspace-browser/harness.ts') },
        preserveEntrySignatures: 'strict',
        output: { entryFileNames: 'assets/[name].js' },
      },
    },
  });
  const assets = await readdir(join(bundle, 'assets'));
  report['inputs'] = await Promise.all(assets.map(async (name) => {
    const bytes = await readFile(join(bundle, 'assets', name));
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  server.middlewares.use('/__device_workspace__', (_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const styles = assets.filter((name) => name.endsWith('.css')).map((name) => `<link rel="stylesheet" href="/assets/${name}">`).join('');
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>设备工作台浏览器验收</title>${styles}<body><script>window.__errors=[];window.addEventListener('error',e=>window.__errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__errors.push(String(e.reason)));const original=console.error;console.error=(...args)=>{window.__errors.push(args.map(String).join(' '));original(...args);};</script><script type="module">import * as harness from '/assets/harness.js';window.__harness=harness;await harness.mount();</script></body></html>`);
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  ownedPorts.push(address.port);
  const base = `http://127.0.0.1:${address.port}`;
  report['base'] = base;
  const executable = process.env['DEVICEFORGE_TEST_BROWSER'] ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await access(executable);
  child = spawn(executable, ['--headless=new', '--disable-gpu', '--in-process-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  evidence['pid'] = child.pid;
  child.stderr?.on('data', (value: Buffer) => { diagnostic = (diagnostic + value.toString()).slice(-16000); });
  const deadline = Date.now() + 15000;
  let endpoint = '';
  while (!endpoint && Date.now() < deadline) {
    endpoint = diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1] ?? '';
    assert.equal(child.exitCode, null, '验收浏览器提前退出');
    await delay(50);
  }
  assert.ok(endpoint, '验收浏览器调试端口未就绪');
  ownedPorts.push(Number(new URL(endpoint).port));
  const module: unknown = await import(pathToFileURL(join(project, 'scripts/browser-theme-smoke/cdp.mjs')).href);
  assert.ok(protocolModule(module));
  browser = await module.themeProtocol(endpoint, evidence);
  report['browser_runtime'] = await browser.call('Browser.getVersion');
  const origin = new URL(endpoint);
  origin.protocol = 'http:';
  origin.pathname = '/json/new';
  origin.search = '?' + encodeURIComponent(base + '/__device_workspace__#devices');
  const response = await fetch(origin, { method: 'PUT', signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok);
  const target = record(await response.json());
  assert.equal(typeof target['webSocketDebuggerUrl'], 'string');
  page = await module.themeProtocol(String(target['webSocketDebuggerUrl']), evidence);
  await page.call('Runtime.enable');
  await wait('window.__harness && document.querySelector("[data-route=devices]") && document.body.textContent.includes("设备甲")', '设备目录');
  await capture('desktop-initial', 1536, 1024);
  await runCases();
  report['console_errors'] = await evaluate('window.__errors');
  assert.deepEqual(report['console_errors'], [], '浏览器控制台发生错误');
  assert.ok(cases.every((item) => item.passed), '设备页行为存在失败项');
  report['passed'] = true;
} catch (error) {
  report['passed'] = false;
  report['error'] = error instanceof Error ? error.message : String(error);
  report['failure_page'] = await evaluate('({url:location.href,text:document.body.innerText,errors:window.__errors})').catch(() => null);
  await capture('failure-initialization', 1536, 1024).catch(() => {});
  process.exitCode = 1;
} finally {
  await evaluate('window.__harness?.dispose()').catch(() => {});
  page?.close();
  if (browser) await browser.call('Browser.close', {}, 5000).catch(() => {});
  browser?.close();
  const deadline = Date.now() + 5000;
  while (child && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    evidence['forced'] = true;
    await delay(500);
  }
  evidence['exit_code'] = child?.exitCode;
  evidence['diagnostic'] = diagnostic;
  const listener = server.httpServer;
  if (listener && 'closeAllConnections' in listener) listener.closeAllConnections();
  await server.close();
  report['ports'] = await Promise.all(ownedPorts.map(async (port) => ({ port, released: await released(port) })));
  const subpath = relative(output, profile);
  assert.ok(profile.startsWith(output + sep) && !subpath.startsWith('..') && basename(profile) === 'browser-profile');
  await rm(profile, { recursive: true, force: true });
  report['profile_cleaned'] = true;
  report['completed_at'] = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`设备工作台浏览器验收：${report['passed'] === true ? '通过' : '未通过'}；证据：${output}`);
}

async function runCases() {
  await check('目录来源与初始空选择', async () => {
    assert.equal(await evaluate('window.__harness.selected()'), null);
    assert.equal(await evaluate('document.querySelectorAll("[data-device-reference]").length'), 3);
    return evaluate('window.__harness.requests().filter(r=>r.method==="GET"&&(r.path==="/api/v2/devices"||r.path==="/api/v2/device-providers"))');
  });
  await check('设备搜索与来源筛选', async () => {
    await fill('[aria-label="搜索设备"]', '离线');
    assert.equal(await evaluate('document.querySelectorAll("[data-device-reference]").length'), 1);
    await fill('[aria-label="搜索设备"]', '不存在的设备');
    assert.equal(await evaluate('document.body.textContent.includes("没有匹配的设备")'), true);
    await fill('[aria-label="搜索设备"]', '');
    const value = JSON.stringify(['fixture.second', 'generation-1']);
    await evaluate(`(() => {const el=document.querySelector('[aria-label="筛选设备来源"]');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await delay(80);
    assert.equal(await evaluate('document.querySelectorAll("[data-device-reference]").length'), 1);
    await evaluate(`(() => {const el=document.querySelector('[aria-label="筛选设备来源"]');el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await delay(80);
  });
  await check('设备选择同步详情与全局摘要', async () => {
    await choose('fixture.first', 'device-a');
    assert.equal(await evaluate('document.querySelector("[aria-label=设备详细工作台]").textContent.includes("设备甲") && document.querySelector("[aria-label=当前设备摘要]").textContent.includes("设备甲")'), true);
    assert.equal(await evaluate('document.querySelector("[data-device-reference][aria-pressed=true]")!==null'), true);
    return evaluate('window.__harness.selected().reference');
  });
  await check('未声明能力显示拒绝原因', async () => {
    assert.equal(await evaluate('document.querySelectorAll(".device-shortcut[aria-disabled=true]").length'), 2);
    assert.equal(await evaluate('[...document.querySelectorAll(".device-shortcut[aria-disabled=true]")].every(el=>el.textContent.includes("提供者未声明此功能"))'), true);
  });
  await check('离线与未授权设备禁止读取', async () => {
    for (const [provider, id] of [['fixture.first', 'device-offline'], ['fixture.second', 'device-a']]) {
      assert.ok(provider && id);
      await choose(provider, id);
      await openReadCapability();
      assert.equal(await evaluate('[...document.querySelectorAll(".device-capability-action button")].find(b=>b.textContent.trim()==="执行读取任务")?.disabled'), true);
    }
    await choose('fixture.first', 'device-a');
  });
  await check('实际操作目录缺失禁止读取', async () => {
    await evaluate('window.__harness.refreshOperations(true)');
    await openReadCapability();
    assert.equal(await evaluate('[...document.querySelectorAll(".device-capability-action button")].find(b=>b.textContent.trim()==="执行读取任务")?.disabled'), true);
    await evaluate('window.__harness.refreshOperations(false)');
  });
  await check('公开设备读取动作保留完整引用与日志', async () => {
    await openReadCapability();
    await click('执行读取任务', '.device-capability-action');
    await wait('document.body.textContent.includes("任务已完成")', '设备读取任务');
    const action = record(await evaluate('window.__harness.requests().filter(r=>r.path==="/api/v2/device-actions").at(-1).input'));
    assert.equal(action['provider_id'], 'fixture.first');
    assert.equal(action['generation'], 'generation-1');
    assert.equal(action['device_id'], 'device-a');
    assert.equal(action['capability'], 'packages');
    assert.equal(action['version'], 1);
    assert.equal(await evaluate('document.body.textContent.includes("fixture-log")'), true);
    return action;
  });
  await check('公开连接动作与发现回读', async () => {
    await click('连接设备');
    await wait('document.querySelector("[role=dialog]")?.textContent.includes("设备连接地址")', '连接弹窗');
    const selector = await evaluate(`(() => {const label=[...document.querySelectorAll('[role=dialog] label')].find(l=>l.textContent.trim()==='设备连接地址');return label?'#'+label.htmlFor:null;})()`);
    assert.equal(typeof selector, 'string');
    await fill(String(selector), 'fixture-only:5555');
    await click('连接地址', '[role="dialog"]');
    await wait('document.querySelector("[role=dialog]")?.textContent.includes("已重新发现并更新设备目录")', '连接后发现');
    const action = record(await evaluate('window.__harness.requests().filter(r=>r.path==="/api/v2/device-actions").at(-1).input'));
    assert.equal(action['device_id'], null);
    assert.equal(action['capability'], 'connect');
    assert.deepEqual(action['input'], { address: 'fixture-only:5555' });
    assert.equal(await evaluate('window.__harness.selected()'), null);
    await evaluate('document.querySelector("[data-slot=dialog-close]")?.click()');
    await delay(100);
    return action;
  });
  await check('重新发现实际调用并撤销旧选择', async () => {
    await choose('fixture.first', 'device-a');
    await click('重新发现');
    await wait('window.__harness.selected()===null', '发现后撤销选择');
    const requests = await evaluate('window.__harness.requests().filter(r=>r.method==="POST"&&r.path.endsWith("/refresh"))');
    assert.ok(Array.isArray(requests) && requests.length >= 2);
    return requests;
  });
  await check('发现失败暴露实际日志 ID 且可重新发现', async () => {
    await evaluate('window.__harness.failDiscovery(true)');
    await click('重新发现 fixture.first');
    await wait('document.body.textContent.includes("受控提供者发现失败")', '发现错误');
    assert.equal(await evaluate('[...document.querySelectorAll("button")].some(b=>b.getAttribute("aria-label")==="复制日志 ID：device-workspace-fixture-log"||b.textContent.includes("复制日志 ID：device-workspace-fixture-log"))'), true);
    assert.equal(await evaluate('window.__harness.selected()'), null);
    await evaluate('window.__harness.failDiscovery(false)');
    await click('重新发现设备');
    await wait('document.querySelectorAll("[data-device-reference]").length===3', '发现恢复');
    assert.equal(await evaluate('document.body.textContent.includes("已完成 2 个提供者的设备发现")'), true);
  });
  await choose('fixture.first', 'device-a');
  await evaluate('document.querySelector(".device-advanced").open=false;document.querySelector("#workplane").scrollTop=0;window.scrollTo(0,0)');
  await capture('desktop-selected', 1536, 1024);
  await capture('mobile-selected', 390, 844);
  await check('390px 页面和工作区无横向溢出', async () => {
    const geometry = record(await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth,workspace:document.querySelector("#workplane").clientWidth,workspaceScroll:document.querySelector("#workplane").scrollWidth})'));
    assert.ok(Number(geometry['document']) <= Number(geometry['viewport']));
    assert.ok(Number(geometry['body']) <= Number(geometry['viewport']));
    assert.equal(geometry['workspace'], geometry['workspaceScroll']);
    return geometry;
  });
  await evaluate('document.querySelector(".device-detail-heading").scrollIntoView({block:"start"})');
  await capture('mobile-detail', 390, 844);
  await check('主要应用管理导航保持当前设备', async () => {
    assert.equal(await evaluate('(() => {const a=document.querySelector(".device-primary-actions a[href=\\\"#packages\\\"]");if(!a)return false;a.click();return true;})()'), true);
    await wait('document.querySelector("[data-route=packages]")?.hidden===false', '应用管理导航');
    assert.equal(record(await evaluate('window.__harness.selected().reference'))['localId'], 'device-a');
  });
}
