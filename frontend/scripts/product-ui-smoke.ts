import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

type RecordValue = Record<string, unknown>;
interface Protocol { call(method: string, params?: RecordValue, timeout?: number): Promise<unknown>; close(): void }
interface Case { name: string; passed: boolean; result?: unknown; error?: string }
interface InputIdentity { path: string; bytes: number; sha256: string }
interface ChildEvidence { pid?: number; diagnostic: string; code: number | null; signal: NodeJS.Signals | null; forced: boolean }
function isRecord(value: unknown): value is RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function record(value: unknown): RecordValue { assert.ok(isRecord(value)); return value; }
function textValue(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'artifacts/product-ui', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.every(value => !value.startsWith('--') || value === '--in-process-gpu'), '未知浏览器验收选项');
assert.ok(argumentsList.filter(value => value === '--in-process-gpu').length <= 1, '浏览器验收选项重复');
const sourceArguments = argumentsList.filter(value => !value.startsWith('--'));
assert.ok(sourceArguments.length <= 1, '只接受一个生产构建目录');
const source = resolve(root, sourceArguments[0] ?? 'frontend/dist');
const inProcessGpu = argumentsList.includes('--in-process-gpu');
const active = '[data-route]:not([hidden])';
const routes = ['devices', 'packages', 'files', 'media', 'performance', 'frida', 'automation', 'terminal', 'ai', 'analysis', 'plugins', 'tasks', 'tools', 'settings'];
const cases: Case[] = []; const pages: unknown[] = []; const screenshots: string[] = [];
const report: RecordValue = { timestamp: new Date().toISOString(), scope: '真实隔离 Rust 宿主与生产 React 界面；14 页桌面和窄屏，合成 ZIP 仅验证目录排版；不连接设备、模拟器或桌面输入，不证明媒体或 Root 资格', out, source, browserMode: inProcessGpu ? 'headless-in-process-gpu' : 'headless-disable-gpu', cases, pages, screenshots };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let host: ChildProcess | undefined; let browserChild: ChildProcess | undefined;
let hostEvidence: ChildEvidence | undefined; let browserEvidence: ChildEvidence | undefined;
let frozenFrontend: string | undefined; let frozenBinary: string | undefined;
let vite: ViteDevServer | undefined; let browser: Protocol | undefined; let page: Protocol | undefined; let base = '';
const ownedPorts: number[] = [];

async function digestTree(directory: string): Promise<InputIdentity[]> {
  const result: InputIdentity[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else { const bytes = await readFile(child); result.push({path: child.slice(directory.length + 1), bytes: bytes.length, sha256: hash(bytes)}); }
    }
  }
  await walk(directory); return result.sort((left, right) => Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
}
async function fileIdentity(path: string): Promise<InputIdentity> {
  const bytes = await readFile(path); return {path, bytes: bytes.length, sha256: hash(bytes)};
}
async function freezeInputs(): Promise<{ frontend: string; binary: string }> {
  const frontend = join(out, 'frozen-dist'), sourceBefore = await digestTree(source);
  const driverBefore = await fileIdentity(fileURLToPath(import.meta.url));
  await cp(source, frontend, {recursive: true});
  const frozenBefore = await digestTree(frontend), sourceAfter = await digestTree(source);
  assert.deepEqual(sourceAfter, sourceBefore, '生产构建在冻结期间改变');
  assert.deepEqual(frozenBefore, sourceBefore, '生产构建冻结字节不一致');
  const hostSource = resolve(root, 'backend/target/debug/apk-server.exe'), hostBefore = await fileIdentity(hostSource);
  const binary = join(out, 'frozen-host', 'apk-server.exe'); await mkdir(join(out, 'frozen-host')); await cp(hostSource, binary);
  const hostAfter = await fileIdentity(hostSource), hostFrozen = await fileIdentity(binary);
  assert.deepEqual(hostAfter, hostBefore, 'Rust宿主在冻结期间改变');
  assert.equal(hostFrozen.bytes, hostBefore.bytes); assert.equal(hostFrozen.sha256, hostBefore.sha256);
  report['inputs'] = frozenBefore;
  report['frozenInputs'] = {source: {directory: source, before: sourceBefore, afterFreeze: sourceAfter}, frontend: {directory: frontend, before: frozenBefore},
    host: {before: hostBefore, afterFreeze: hostAfter, frozen: hostFrozen}, driver: {before: driverBefore}};
  report['host'] = hostFrozen; return {frontend, binary};
}
async function verifyFrozenInputs(frontend: string, binary: string): Promise<void> {
  const inputs = record(report['frozenInputs']), front = record(inputs['frontend']), hostInput = record(inputs['host']), driver = record(inputs['driver']);
  const frontendAfter = await digestTree(frontend), hostAfter = await fileIdentity(binary), driverAfter = await fileIdentity(fileURLToPath(import.meta.url));
  front['after'] = frontendAfter; hostInput['after'] = hostAfter; driver['after'] = driverAfter;
  assert.deepEqual(frontendAfter, front['before'], '受检生产构建运行期间改变');
  assert.deepEqual(hostAfter, hostInput['frozen'], '受检Rust宿主运行期间改变');
  assert.deepEqual(driverAfter, driver['before'], '验收驱动运行期间改变');
  inputs['verified'] = true;
}
async function port(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); return address.port;
}
function observe(child: ChildProcess): ChildEvidence {
  const evidence: ChildEvidence = { diagnostic: '', code: null, signal: null, forced: false };
  if (child.pid !== undefined) evidence.pid = child.pid;
  child.stderr?.on('data', (bytes: Buffer) => { evidence.diagnostic = (evidence.diagnostic + bytes.toString()).slice(-8192); });
  child.on('error', error => { evidence.diagnostic += '\n子进程启动错误：' + error.message; });
  child.on('exit', (code, signal) => { evidence.code = code; evidence.signal = signal; });
  return evidence;
}
async function released(port: number): Promise<boolean> {
  const server = createNetServer();
  try { await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); }); return true; }
  catch { return false; }
  finally { if (server.listening) await new Promise<void>(done => server.close(() => done())); }
}
async function ended(child: ChildProcess, evidence: ChildEvidence): Promise<void> {
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null && child.signalCode === null) { evidence.forced = true; child.kill(); await delay(500); }
}
async function protocol(url: string): Promise<Protocol> {
  const socket = new WebSocket(url); let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  await new Promise<void>((done, fail) => { socket.addEventListener('open', () => done(), {once: true}); socket.addEventListener('error', () => fail(new Error('浏览器调试连接失败')), {once: true}); });
  socket.addEventListener('message', event => {
    const reply = record(JSON.parse(String(event.data))); const entry = pending.get(Number(reply['id'])); if (!entry) return;
    pending.delete(Number(reply['id'])); clearTimeout(entry.timer);
    if (reply['error']) entry.reject(new Error('浏览器调试命令失败：' + JSON.stringify(reply['error']))); else entry.resolve(reply['result']);
  });
  socket.addEventListener('close', () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('浏览器调试连接已关闭')); } pending.clear(); });
  return {call(method, params = {}, timeout = 15000) {
    return new Promise<unknown>((done, fail) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); fail(new Error('调试命令超时：' + method)); }, timeout);
      pending.set(id, {resolve: done, reject: fail, timer}); socket.send(JSON.stringify({id, method, params}));
    });
  }, close() { socket.close(); }};
}

async function api(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(base + path, {...options, signal: AbortSignal.timeout(15000)});
  const body = record(await response.json()); assert.ok(response.ok, `${path}：${response.status}`); return body['data'];
}
async function evaluate(expression: string): Promise<unknown> {
  assert.ok(page); const reply = record(await page.call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}));
  if (reply['exceptionDetails']) throw new Error(JSON.stringify(reply['exceptionDetails'])); return record(reply['result'])['value'];
}
async function wait(expression: string, label = '页面状态', milliseconds = 10000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { try { if (await evaluate(expression)) return; } catch { /* 页面导航可销毁旧执行上下文。 */ } await delay(50); }
  throw new Error(label + '未就绪');
}
async function viewport(width: number, height: number): Promise<void> { assert.ok(page); await page.call('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false}); await delay(250); }
async function route(id: string): Promise<void> {
  await evaluate(`location.hash=${JSON.stringify(id)}`); await wait(`document.querySelector('[data-route="${id}"]')?.hidden===false`, id);
  await evaluate('document.querySelector("#workplane").scrollTop=0; window.scrollTo(0,0)');
}
async function capture(name: string): Promise<void> {
  assert.ok(page); await evaluate('document.fonts.ready'); await delay(120);
  const reply = record(await page.call('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false}));
  await writeFile(join(out, name + '.png'), Buffer.from(textValue(reply['data']), 'base64')); screenshots.push(name + '.png');
}
async function check(name: string, action: () => Promise<unknown>): Promise<void> {
  try { cases.push({name, passed: true, result: await action()}); }
  catch (error) { cases.push({name, passed: false, error: message(error)}); await capture('failure-' + cases.length).catch(() => {}); }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
}
async function activate(selector: string): Promise<void> {
  const focused = await evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});if(!element||!element.getClientRects().length||element.disabled)return false;element.focus();return document.activeElement===element;})()`);
  assert.equal(focused, true, '不可用入口：' + selector); await key('Enter', 'Enter', 13);
}
async function navigation(scope: string, current: string): Promise<unknown> {
  const observation = record(await evaluate(`(() => {const navigation=document.querySelector(${JSON.stringify(scope)});if(!navigation)return null;const links=[...navigation.querySelectorAll('[data-navigation-route]')];return {groups:[...navigation.querySelectorAll('[data-navigation-group]')].map(group=>group.getAttribute('data-navigation-group')),routes:links.map(link=>link.getAttribute('data-navigation-route')),current:links.filter(link=>link.getAttribute('aria-current')==='page').map(link=>link.getAttribute('data-navigation-route')),labels:links.map(link=>link.getAttribute('aria-label')||link.textContent.trim())};})()`));
  assert.ok(Array.isArray(observation['groups']) && observation['groups'].length === 4, '导航必须有四个分组');
  assert.ok(Array.isArray(observation['routes'])); assert.deepEqual([...observation['routes']].sort(), [...routes].sort(), '全部十四个导航入口');
  assert.deepEqual(observation['current'], [current], '当前路由必须有唯一aria-current');
  assert.ok(Array.isArray(observation['labels']) && observation['labels'].every(label => typeof label === 'string' && label.trim().length > 0), '导航入口具有可访问名称');
  return observation;
}
async function click(text: string, scope = active): Promise<void> {
  const result = await evaluate(`(() => {const b=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].find(b=>b.getClientRects().length&&!b.closest('[hidden]')&&b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.scrollIntoView({block:'center'});b.focus();b.click();return true;})()`);
  assert.equal(result, true, '不可用按钮：' + text); await delay(80);
}
function labeled(label: string): string {
  return `(() => {const l=[...document.querySelectorAll('${active} label')].find(l=>l.textContent.trim()===${JSON.stringify(label)});return l?document.getElementById(l.htmlFor):null;})()`;
}
async function field(label: string, value: string): Promise<void> {
  assert.equal(await evaluate(`(() => {const el=${labeled(label)};if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`), true, '未找到字段：' + label);
  await delay(50);
}
async function file(selector: string, path: string): Promise<void> {
  assert.ok(page); const document = record(await page.call('DOM.getDocument'));
  const reply = record(await page.call('DOM.querySelector', {nodeId: record(document['root'])['nodeId'], selector}));
  assert.ok(reply['nodeId'], '未找到文件输入'); await page.call('DOM.setFileInputFiles', {nodeId: reply['nodeId'], files: [path]}); await delay(100);
}
async function key(key: string, code: string, virtual: number, shiftKey = false): Promise<void> {
  assert.ok(page); const params = {key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers: shiftKey ? 8 : 0};
  await page.call('Input.dispatchKeyEvent', {type: 'keyDown', ...params, ...(key === 'Enter' ? {text: '\r', unmodifiedText: '\r'} : {})}); await page.call('Input.dispatchKeyEvent', {type: 'keyUp', ...params}); await delay(50);
}

// 自包含 Stored ZIP 夹具：只验证真实服务器目录与长名称表格，不使用设备数据。
function zipFixture(name: string): Buffer {
  const filename = Buffer.from(name); const data = Buffer.from('真实上传目录夹具\n'); let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

await mkdir(out, {recursive: true});
try {
  const frozen = await freezeInputs(); frozenFrontend = frozen.frontend; frozenBinary = frozen.binary;
  const binary = frozen.binary;
  const hostPort = await port(); ownedPorts.push(hostPort); base = `http://127.0.0.1:${hostPort}`; report['base'] = base;
  host = spawn(binary, [], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, APK_API_TOKEN: '', APK_BIND: `127.0.0.1:${hostPort}`, APK_DATA_DIR: join(out, 'session/data'), APK_PLUGIN_DIR: join(out, 'session/server-plugins'), APK_BROWSER_PLUGIN_DIR: join(out, 'session/browser-plugins'), DEVICEFORGE_NODE: process.execPath}});
  hostEvidence = observe(host); report['hostProcess'] = hostEvidence;
  const readyDeadline = Date.now() + 15000;
  while (true) { try { report['operations'] = await api('/api/v2/operations'); break; } catch { assert.ok(Date.now() < readyDeadline && host.exitCode === null, '隔离宿主未启动'); await delay(100); } }
  report['initialProviders'] = await api('/api/v2/device-providers');
  vite = await createServer({root: frozen.frontend, configFile: false, appType: 'spa', logLevel: 'error', server: {host: '127.0.0.1', port: 0, hmr: false, proxy: {'/api': base, '/mcp': base}}});
  await vite.listen(); const address = vite.httpServer?.address(); assert.ok(address && typeof address === 'object');
  const frontend = `http://127.0.0.1:${address.port}`; ownedPorts.push(address.port); report['frontend'] = frontend;
  const browserBinary = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browserArguments = ['--headless=new', ...(inProcessGpu ? ['--in-process-gpu', '--no-sandbox'] : ['--disable-gpu']), '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(out, 'session/edge-profile')}`, 'about:blank'];
  report['browserLaunch'] = {binary: await fileIdentity(browserBinary), arguments: browserArguments};
  browserChild = spawn(browserBinary, browserArguments, {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  browserEvidence = observe(browserChild); report['browserProcess'] = browserEvidence;
  let browserUrl = ''; const browserDeadline = Date.now() + 15000;
  while (!browserUrl) { browserUrl = browserEvidence.diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1] ?? ''; assert.ok(Date.now() < browserDeadline && browserChild.exitCode === null, '隔离浏览器未启动'); if (!browserUrl) await delay(100); }
  browser = await protocol(browserUrl); report['browser'] = await browser.call('Browser.getVersion');
  const endpoint = new URL(browserUrl); endpoint.protocol = 'http:'; endpoint.pathname = '/json/new'; endpoint.search = '?' + encodeURIComponent(frontend);
  const target = record(await fetch(endpoint, {method: 'PUT', signal: AbortSignal.timeout(10000)}).then(response => response.json()));
  page = await protocol(textValue(target['webSocketDebuggerUrl']));
  await page.call('Runtime.enable'); await page.call('Page.enable'); await page.call('DOM.enable'); await viewport(1440, 1000);
  await wait('!!document.querySelector(".product-shell")', '生产 React 页面');
  await wait('document.querySelector(".connection-state")?.textContent.includes("服务器已连接")', '真实服务器目录');
  await viewport(1536, 1024); await route('devices'); await capture('reference-desktop-devices');
  for (const id of routes) {
    await route(id);
    for (const [width, height, size] of [[1440, 1000, 'desktop'], [390, 844, 'narrow']] as const) {
      await viewport(width, height); await evaluate('window.scrollTo(0,0)');
      const observation = record(await evaluate(`(() => {const current=document.querySelector('${active}');return {heading:current.querySelector('h1')?.textContent,text:current.innerText,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,controls:[...document.querySelectorAll('button,[role="tab"],[role="switch"]')].filter(b=>b.getClientRects().length&&!b.closest('[hidden]')).map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent.trim(),label:b.getAttribute('aria-label'),role:b.getAttribute('role'),width:r.width,height:r.height,disabled:b.disabled}})};})()`));
      pages.push({id, width, height, ...observation}); await capture(`${size}-${id}`);
      assert.ok(Number(observation['documentWidth']) <= width, `${id} 整页横向溢出`);
    }
  }
  await check('真实空目录与全部路由', async () => ({pages: pages.length, initialProviders: report['initialProviders']}));
  await check('窄屏全部动作按钮最小 44px', async () => {
    const measurements: unknown[] = [];
    for (const item of pages) {
      const observation = record(item); if (observation['width'] !== 390) continue;
      const controls = observation['controls']; assert.ok(Array.isArray(controls));
      for (const item of controls) {
        const control = record(item); measurements.push({page: observation['id'], ...control});
        assert.ok(Number(control['height']) >= 44, `${observation['id']} ${control['text'] || control['label'] || control['role'] || '图标按钮'} 高度 ${control['height']}px，低于 44px`);
      }
    }
    await viewport(390, 844);
    for (const [id, text] of [['packages', '运行清单'], ['media', '检查直播能力'], ['performance', '开始性能会话'], ['automation', '执行桌面点击'], ['terminal', '重查状态'], ['ai', '刷新助手目录'], ['tools', '检查功能资格'], ['settings', '导入配置区']] as const) {
      await route(id);
      const located = await evaluate(`(() => {const b=[...document.querySelectorAll('${active} button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.scrollIntoView({block:'center'});return true;})()`);
      assert.equal(located, true, '未找到待审动作：' + text); await capture(`state-narrow-${id}-actions`);
    }
    return {minimumHeight: 44, controls: measurements.length, includingDisabled: true, measurements};
  });
  await viewport(1440, 1000);
  await check('标签绑定字段与切页草稿保留', async () => {
    await route('settings'); await field('归属 ID', '审图草稿-保留'); await route('files'); await route('settings');
    assert.equal(await evaluate(`(${labeled('归属 ID')})?.value`), '审图草稿-保留'); return {labelBinding: true, draftRetained: true};
  });
  await check('桌面四组导航与折叠恢复', async () => {
    await viewport(1440, 1000); await route('settings');
    const nav = '.workspace-sidebar nav[aria-label="工坊工具"]';
    const expanded = await navigation(nav, 'settings');
    assert.equal(await evaluate('document.querySelector(".product-shell").getAttribute("data-navigation-collapsed")'), 'false');
    const before = record(await evaluate('(() => {const side=document.querySelector(".workspace-sidebar"),work=document.querySelector("#workplane");return {sidebarWidth:side.getBoundingClientRect().width,workspaceWidth:work.getBoundingClientRect().width};})()'));
    await activate('[aria-label="折叠导航"]');
    await wait('document.querySelector(".product-shell").getAttribute("data-navigation-collapsed")==="true"', '侧栏折叠');
    const collapsed = await navigation(nav, 'settings');
    const narrow = record(await evaluate('(() => {const side=document.querySelector(".workspace-sidebar"),work=document.querySelector("#workplane");return {sidebarWidth:side.getBoundingClientRect().width,workspaceWidth:work.getBoundingClientRect().width};})()'));
    assert.ok(Number(narrow['sidebarWidth']) < Number(before['sidebarWidth']), '折叠后侧栏没有收窄');
    assert.ok(Number(narrow['workspaceWidth']) > Number(before['workspaceWidth']), '折叠后工作面没有扩展');
    await capture('state-sidebar-collapsed');
    await activate('.workspace-sidebar [data-navigation-route="files"]'); await wait('document.querySelector("[data-route=files]")?.hidden===false');
    await navigation(nav, 'files');
    await activate('[aria-label="展开导航"]');
    await wait('document.querySelector(".product-shell").getAttribute("data-navigation-collapsed")==="false"', '侧栏展开');
    await navigation(nav, 'files'); await capture('state-sidebar-expanded');
    return {groups: 4, entries: 14, keyboardNavigation: true, expanded, collapsed, before, narrow};
  });
  await check('窄屏导航抽屉焦点约束与关闭恢复', async () => {
    await viewport(390, 844); await route('files');
    const trigger = '[aria-label="打开导航"]', dialog = '[role="dialog"]', nav = '[role="dialog"] nav[aria-label="工坊工具"]';
    await activate(trigger); await wait('!!document.querySelector("[role=dialog]")', '移动导航Sheet');
    assert.equal(await evaluate('document.querySelector("[role=dialog]").innerText.includes("工坊导航")'), true);
    const first = await navigation(nav, 'files');
    assert.equal(await evaluate('!!document.activeElement?.closest("[role=dialog]")'), true, '抽屉打开后焦点没有进入');
    for (let i = 0; i < 18; i++) {
      await key('Tab', 'Tab', 9, i >= 9);
      assert.equal(await evaluate('!!document.activeElement?.closest("[role=dialog]")'), true, '抽屉键盘焦点越界');
    }
    const targets = await evaluate('[...document.querySelectorAll("[role=dialog] button")].map(button=>{const bounds=button.getBoundingClientRect();return {label:button.getAttribute("aria-label")||button.textContent.trim(),width:bounds.width,height:bounds.height};})');
    assert.ok(Array.isArray(targets));
    for (const value of targets) {
      const target = record(value); assert.ok(Number(target['height']) >= 44 && Number(target['width']) >= 44, '导航抽屉点击目标不足44×44px：' + target['label']);
    }
    await capture('state-navigation-sheet');
    await key('Escape', 'Escape', 27); await wait('!document.querySelector("[role=dialog]")', 'Esc关闭导航');
    assert.equal(await evaluate('document.activeElement===document.querySelector("[aria-label=打开导航]")'), true);
    await activate(trigger); await wait('!!document.querySelector("[role=dialog]")');
    await activate(nav + ' [data-navigation-route="performance"]');
    await wait('!document.querySelector("[role=dialog]") && document.querySelector("[data-route=performance]")?.hidden===false', '导航后关闭抽屉');
    assert.equal(await evaluate('document.activeElement===document.querySelector("[aria-label=打开导航]")'), true, '导航后焦点未恢复触发器');
    await activate(trigger); await wait('!!document.querySelector("[role=dialog]")');
    const current = await navigation(nav, 'performance'); await capture('state-navigation-sheet-current');
    await activate(dialog + ' button[aria-label="关闭"]'); await wait('!document.querySelector("[role=dialog]")', '关闭按钮收起导航');
    assert.equal(await evaluate('document.activeElement===document.querySelector("[aria-label=打开导航]")'), true);
    return {groups: 4, entries: 14, first, current, focusContained: true, escapeClosed: true, navigationClosed: true, closeButton: true, focusReturned: true, targets};
  });
  await check('专注模式与减少动态效果', async () => {
    await viewport(1440, 1000); await route('files'); await field('公开产物 ID', '专注草稿'); await click('专注', '.global-actions');
    assert.equal(await evaluate('document.querySelector(".product-shell").classList.contains("is-focused")'), true); await capture('state-focus');
    await click('退出专注', '.global-actions'); assert.equal(await evaluate(`(${labeled('公开产物 ID')})?.value`), '专注草稿');
    await evaluate('document.querySelector("[aria-label=更多设置]").focus()'); await key('Enter', 'Enter', 13); await wait('!!document.querySelector("[role=menuitemcheckbox]")');
    await evaluate('document.querySelector("[role=menuitemcheckbox]").focus()'); await key('Enter', 'Enter', 13); assert.equal(await evaluate('document.querySelector(".product-shell").classList.contains("reduce-motion")'), true);
    await key('Escape', 'Escape', 27); return {focused: true, draftRetained: true, reduced: true};
  });
  await check('真实 JSON 上传与删除 Dialog 键盘', async () => {
    const filename = '审图-真实上传-UTF8.json'; const path = join(out, filename);
    const content = Buffer.from('{"说明":"设备工坊隔离服务上传，不涉及设备文件"}\n'); await writeFile(path, content);
    await route('files'); await file(`${active} #artifact-upload`, path);
    await wait(`!![...document.querySelectorAll('${active} h2')].find(e=>e.textContent===${JSON.stringify(filename)})`, '真实文件元数据');
    const id = textValue(await evaluate(`(${labeled('公开产物 ID')})?.value`)); assert.ok(id);
    const downloaded = await fetch(base + '/api/v2/artifacts/' + id + '/content');
    const downloadedBytes = await downloaded.arrayBuffer(); assert.equal(hash(Buffer.from(downloadedBytes)), hash(content));
    await capture('state-file-uploaded'); await click('删除产物'); await wait('!!document.querySelector("[role=dialog]")');
    assert.equal(await evaluate('!!document.activeElement.closest("[role=dialog]")'), true);
    for (let i = 0; i < 8; i++) { await key('Tab', 'Tab', 9); assert.equal(await evaluate('!!document.activeElement.closest("[role=dialog]")'), true); }
    await capture('state-file-delete-dialog'); await viewport(390, 844); await capture('state-narrow-delete-dialog');
    const dialogTargets = await evaluate(`[...document.querySelectorAll('[role=dialog] button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent.trim(),label:b.getAttribute('aria-label'),width:r.width,height:r.height}})`);
    assert.ok(Array.isArray(dialogTargets));
    for (const item of dialogTargets) {
      const target = record(item);
      assert.ok(Number(target['height']) >= 44 && Number(target['width']) >= 44, `窄屏 Dialog ${target['text'] || target['label'] || '关闭按钮'} 目标不足 44×44px`);
    }
    await key('Escape', 'Escape', 27); await wait('!document.querySelector("[role=dialog]")');
    const returned = await evaluate('document.activeElement.textContent.trim()==="删除产物"');
    // 焦点缺陷保留为独立失败，仍完成隔离产物删除并清理服务状态。
    await click('删除产物'); await click('确认删除', '[role=dialog]'); await wait(`document.querySelector('${active}')?.innerText.includes('尚未选择产物')`, '删除后空状态');
    assert.equal((await fetch(base + '/api/v2/artifacts/' + id)).status, 404); assert.equal(returned, true, 'Dialog 关闭后未返回删除入口');
    await viewport(1440, 1000); return {id, bytesUnchanged: true, focusTrap: true, focusReturned: true, deletedStatus: 404, dialogTargets};
  });
  await check('真实 ZIP 目录与长文件名局部滚动', async () => {
    await viewport(390, 844); await route('files'); const filename = '审图目录.zip'; const path = join(out, filename);
    const entryName = '目录/' + '长文件名审图'.repeat(20) + '.json'; await writeFile(path, zipFixture(entryName)); await file(`${active} #artifact-upload`, path);
    await wait(`!![...document.querySelectorAll('${active} h2')].find(e=>e.textContent===${JSON.stringify(filename)})`, 'ZIP 上传');
    await click('读取目录'); await wait(`document.querySelector('${active} table')?.innerText.includes(${JSON.stringify(entryName)})`, '真实目录表格');
    const overflow = record(await evaluate(`(() => {const t=document.querySelector('${active} [data-slot="table-container"]');const r=t.getBoundingClientRect();t.scrollIntoView({block:'center'});return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,tableWidth:t.scrollWidth,containerWidth:r.width};})()`));
    assert.ok(Number(overflow['pageWidth']) <= 390, '长名称引发整页横滚'); await capture('state-narrow-table');
    const id = textValue(await evaluate(`(${labeled('公开产物 ID')})?.value`)); await api('/api/v2/artifacts/' + id, {method: 'DELETE'});
    return {fixture: '本次自包含 Stored ZIP，非设备数据', ...overflow};
  });
  await check('真实公开 ID 错误常驻与日志 ID', async () => {
    await viewport(1440, 1000); await route('files'); await field('公开产物 ID', '00000000-0000-4000-8000-000000000099'); await click('读取文件元数据');
    await wait(`!!document.querySelector('${active} [role=alert]')`); const error = textValue(await evaluate(`document.querySelector('${active} [role=alert]').innerText`));
    assert.ok(error.includes('日志 ID')); await capture('state-file-error'); await route('devices'); await route('files');
    assert.equal(await evaluate(`!!document.querySelector('${active} [role=alert]')`), true); return {error, persistsAcrossRoutes: true};
  });
  await check('真实服务器断连与手动恢复', async () => {
    assert.ok(page); await page.call('Network.enable'); await page.call('Network.emulateNetworkConditions', {offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await evaluate('document.querySelector("[aria-label=重新连接服务器]").click()'); await wait('document.querySelector(".connection-state").innerText.includes("失败")'); await capture('state-server-disconnected');
    await page.call('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await evaluate('document.querySelector("[aria-label=重新连接服务器]").click()'); await wait('document.querySelector(".connection-state").innerText.includes("已连接")');
    return {disconnectedVisible: true, reconnected: true};
  });
  await check('低高度视口入口可用', async () => {
    await route('terminal'); await viewport(1440, 600); await capture('state-low-height');
    const geometry = record(await evaluate('(() => {const top=document.querySelector(".workspace-topbar"),device=document.querySelector(".device-context"),work=document.querySelector("#workplane"),link=document.querySelector(".workspace-sidebar [data-navigation-route=terminal]");const bounds=work.getBoundingClientRect();return {topbarVisible:!!top?.getClientRects().length,deviceContextVisible:!!device?.getClientRects().length,currentNavigationVisible:!!link?.getClientRects().length,workHeight:bounds.height,workBottom:bounds.bottom,viewportHeight:innerHeight};})()'));
    assert.equal(geometry['topbarVisible'], true); assert.equal(geometry['deviceContextVisible'], true); assert.equal(geometry['currentNavigationVisible'], true);
    assert.ok(Number(geometry['workHeight']) > 200 && Number(geometry['workBottom']) <= 601, '低高度工作面不可用或越界');
    return geometry;
  });
  await check('补充响应式断点与背景裁切', async () => {
    await route('devices'); const widths: unknown[] = [];
    for (const [width, height] of [[1366, 768], [1024, 768], [768, 1024], [360, 800]] as const) {
      await viewport(width, height); await evaluate('window.scrollTo(0,0)');
      const observed = await evaluate('({width:innerWidth,documentWidth:document.documentElement.scrollWidth})');
      assert.ok(Number(record(observed)['documentWidth']) <= width, '响应式断点横向溢出'); widths.push(observed); await capture(`state-breakpoint-${width}`);
    }
    return widths;
  });
  report['passed'] = cases.every(item => item.passed) && pages.length === 28;
  if (!report['passed']) process.exitCode = 1;
  report['visualReview'] = '截图等待视觉子代理直接查看；自动行为通过不代表视觉通过';
} catch (error) { report['error'] = message(error); report['passed'] = false; process.exitCode = 1; }
finally {
  page?.close();
  if (browser) { await browser.call('Browser.close', {}, 5000).catch(error => {report['browserCloseError'] = message(error);}); browser.close(); }
  if (browserChild && browserEvidence) await ended(browserChild, browserEvidence);
  if (vite) {
    if (vite.httpServer && 'closeAllConnections' in vite.httpServer) vite.httpServer.closeAllConnections();
    await vite.close().catch(error => {report['proxyCleanupError'] = message(error);});
  }
  if (host && hostEvidence) {
    if (host.exitCode === null && host.signalCode === null) await api('/api/v2/system/shutdown', {method: 'POST'}).catch(error => {report['shutdownError'] = message(error);});
    await ended(host, hostEvidence);
  }
  if (frozenFrontend && frozenBinary) {
    try { await verifyFrozenInputs(frozenFrontend, frozenBinary); }
    catch (error) { report['inputVerificationError'] = message(error); report['passed'] = false; process.exitCode = 1; }
  }
  report['completedAt'] = new Date().toISOString();
  const ports = await Promise.all(ownedPorts.map(async port => ({port, released: await released(port)})));
  report['cleanup'] = {browserNormal: browserEvidence?.code === 0 && !browserEvidence.forced, hostNormal: hostEvidence?.code === 0 && !hostEvidence.forced, ports};
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({out, passed: report['passed'], error: report['error'], cases, cleanup: report['cleanup']}));
}
