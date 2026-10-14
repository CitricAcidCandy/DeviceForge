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
const source = resolve(root, process.argv[2] ?? 'frontend/dist');
const active = '[data-route]:not([hidden])';
const routes = ['devices', 'packages', 'files', 'media', 'performance', 'frida', 'automation', 'terminal', 'ai', 'analysis', 'plugins', 'tasks', 'tools', 'settings'];
const cases: Case[] = []; const pages: unknown[] = []; const screenshots: string[] = [];
const report: RecordValue = { timestamp: new Date().toISOString(), scope: '真实隔离 Rust 宿主与生产 React 界面；14 页桌面和窄屏，合成 ZIP 仅验证目录排版；不连接设备、模拟器或桌面输入，不证明媒体或 Root 资格', out, source, cases, pages, screenshots };
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let host: ChildProcess | undefined; let browserChild: ChildProcess | undefined;
let hostEvidence: ChildEvidence | undefined; let browserEvidence: ChildEvidence | undefined;
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
  await walk(directory); return result;
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
  await page.call('Input.dispatchKeyEvent', {type: 'keyDown', ...params}); await page.call('Input.dispatchKeyEvent', {type: 'keyUp', ...params}); await delay(50);
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
  const frozen = join(out, 'frozen-dist'); await cp(source, frozen, {recursive: true}); report['inputs'] = await digestTree(frozen);
  const binary = resolve(root, 'backend/target/debug/apk-server.exe'); const bytes = await readFile(binary);
  report['host'] = {path: binary, bytes: bytes.length, sha256: hash(bytes)};
  const hostPort = await port(); ownedPorts.push(hostPort); base = `http://127.0.0.1:${hostPort}`; report['base'] = base;
  host = spawn(binary, [], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, APK_API_TOKEN: '', APK_BIND: `127.0.0.1:${hostPort}`, APK_DATA_DIR: join(out, 'session/data'), APK_PLUGIN_DIR: join(out, 'session/server-plugins'), APK_BROWSER_PLUGIN_DIR: join(out, 'session/browser-plugins'), DEVICEFORGE_NODE: process.execPath}});
  hostEvidence = observe(host); report['hostProcess'] = hostEvidence;
  const readyDeadline = Date.now() + 15000;
  while (true) { try { report['operations'] = await api('/api/v2/operations'); break; } catch { assert.ok(Date.now() < readyDeadline && host.exitCode === null, '隔离宿主未启动'); await delay(100); } }
  report['initialProviders'] = await api('/api/v2/device-providers');
  vite = await createServer({root: frozen, configFile: false, appType: 'spa', logLevel: 'error', server: {host: '127.0.0.1', port: 0, hmr: false, proxy: {'/api': base, '/mcp': base}}});
  await vite.listen(); const address = vite.httpServer?.address(); assert.ok(address && typeof address === 'object');
  const frontend = `http://127.0.0.1:${address.port}`; ownedPorts.push(address.port); report['frontend'] = frontend;
  browserChild = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(out, 'session/edge-profile')}`, 'about:blank'], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
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
  await check('窄屏菜单键盘与焦点返回', async () => {
    await viewport(390, 844); await evaluate('document.querySelector(".compact-tools button").focus()'); await key('Enter', 'Enter', 13);
    await wait('!!document.querySelector("[role=menu]")'); assert.equal(await evaluate('document.querySelectorAll("[role=menuitem]").length'), 14);
    await key('ArrowDown', 'ArrowDown', 40); assert.equal(await evaluate('document.activeElement.getAttribute("role")'), 'menuitem'); await capture('state-menu-keyboard');
    await key('Escape', 'Escape', 27); await wait('!document.querySelector("[role=menu]")');
    assert.equal(await evaluate('document.activeElement===document.querySelector(".compact-tools button")'), true); return {entries: 14, focusReturned: true};
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
    const height = await evaluate('document.querySelector(".scene-caption").getBoundingClientRect().height'); assert.ok(Number(height) <= 28); return {sceneHeight: height};
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
  report['completedAt'] = new Date().toISOString();
  const ports = await Promise.all(ownedPorts.map(async port => ({port, released: await released(port)})));
  report['cleanup'] = {browserNormal: browserEvidence?.code === 0 && !browserEvidence.forced, hostNormal: hostEvidence?.code === 0 && !hostEvidence.forced, ports};
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({out, passed: report['passed'], error: report['error'], cases, cleanup: report['cleanup']}));
}
