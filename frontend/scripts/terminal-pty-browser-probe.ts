import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';
import { createServer, type ViteDevServer } from 'vite';
import { newConsoleWindows, windowsObservation } from '../../scripts/terminal-pty-smoke/windows.mjs';

type Json = Record<string, unknown>;
interface Protocol { call(method: string, params?: Json): Promise<unknown>; close(): void }
function object(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Json { assert.ok(object(value)); return value; }
function text(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
async function protocol(url: string): Promise<Protocol> {
  const socket = new WebSocket(url);
  let sequence = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('浏览器连接建立超时')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new Error('浏览器连接失败')); }, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = record(JSON.parse(String(event.data)));
    const item = waiting.get(Number(message['id']));
    if (!item) return;
    waiting.delete(Number(message['id'])); clearTimeout(item.timer);
    if (message['error']) item.reject(new Error('浏览器命令失败：' + JSON.stringify(message['error'])));
    else item.resolve(message['result']);
  });
  socket.addEventListener('close', () => {
    for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error('浏览器连接关闭')); }
    waiting.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((done, fail) => {
        const id = ++sequence;
        const timer = setTimeout(() => { waiting.delete(id); fail(new Error('浏览器命令超时：' + method)); }, 15000);
        waiting.set(id, { resolve: done, reject: fail, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

const [sourceArgument, baseArgument, outputArgument, ownerArgument, hostDataArgument] = process.argv.slice(2);
assert.ok(sourceArgument && baseArgument && outputArgument && ownerArgument && hostDataArgument, '参数为生产构建目录、独占宿主URL、报告目录、宿主PID、独占宿主数据目录');
const source = resolve(sourceArgument), out = resolve(outputArgument), base = new URL(baseArgument);
const ownerPid = Number(ownerArgument);
const hostData = resolve(hostDataArgument);
assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0, '须明确受检独占宿主PID');
assert.equal(base.hostname, '127.0.0.1', '浏览器验收仅访问独占本地宿主');
assert.notEqual(base.port, '7031', '不能借验收操作用户预览会话');
await mkdir(out, { recursive: true });
const checks: Json[] = [], captures: string[] = [], requests: Json[] = [];
const deadlineAt = Date.now() + 150000;
const report: Json = { started_at: new Date().toISOString(), source, base: base.origin, checks, captures, requests, passed: false,
  scope: '真实生产页面+独占Rust宿主，xterm输入、IME、按键、粘贴事件、缩放和Codex进入/退出；不提交模型任务、不登录、不操作设备' };
let vite: ViteDevServer | undefined, browser: ChildProcess | undefined;
let browserProtocol: Protocol | undefined, page: Protocol | undefined, sessionId: string | undefined;
let sessionFinished = false;
const ownedSessions = new Set<string>();
let diagnostic = '';
async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const reply = await fetch(new URL(path, base), {
    method, signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = record(await reply.json());
  requests.push({ path, method, status: reply.status, log_id: value['log_id'] });
  assert.ok(reply.ok, path + '：' + reply.status);
  return value['data'];
}
async function evaluate(expression: string): Promise<unknown> {
  assert.ok(page);
  const reply = record(await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }));
  assert.equal(reply['exceptionDetails'], undefined);
  return record(reply['result'])['value'];
}
async function until(read: () => Promise<unknown>, accept: (value: unknown) => boolean, label: string, budget = 15000) {
  const deadline = Math.min(Date.now() + budget, deadlineAt);
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await delay(60); }
  throw new Error(label + '超时');
}
async function capture(name: string) {
  assert.ok(page);
  const result = record(await page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
  await writeFile(join(out, name + '.png'), Buffer.from(text(result['data']), 'base64'));
  captures.push(name + '.png');
}
async function key(keyName: string, code: string, windowsVirtualKeyCode: number, modifiers = 0, value?: string) {
  assert.ok(page);
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode, modifiers, ...(value === undefined ? {} : { text: value }) });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode, modifiers });
}
async function composition(value: string) {
  assert.ok(page);
  await page.call('Input.imeSetComposition', { text: value, selectionStart: value.length, selectionEnd: value.length });
  await delay(30);
  // CDP的insertText在活动IME组合上提交原生compositionend，不直接写xterm内部状态。
  await page.call('Input.insertText', { text: value });
  await delay(30);
}
async function insert(value: string) {
  assert.ok(page);
  for (const character of value) {
    if (character.charCodeAt(0) > 127) { await composition(character); continue; }
    const letter = /^[a-z]$/i.test(character), digit = /^\d$/.test(character);
    const code = letter ? 'Key' + character.toUpperCase() : digit ? 'Digit' + character : 'Unidentified';
    const windowsVirtualKeyCode = letter ? character.toUpperCase().charCodeAt(0) : digit ? character.charCodeAt(0) : 0;
    // 屏幕阅读模式依赖keypress；按真实键盘顺序发送受信任的keydown/char/keyup。
    await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: character, code, windowsVirtualKeyCode });
    await page.call('Input.dispatchKeyEvent', { type: 'char', key: character, text: character, unmodifiedText: character });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: character, code, windowsVirtualKeyCode });
    // 每键都有真实HTTP确认；按人类打字节奏避免探针瞬时填满有界输入队列。
    await delay(20);
  }
}
async function command(value: string) { await insert(value); await key('Enter', 'Enter', 13, 0, '\r'); }
let cursor = 0;
const outputChunks: Uint8Array[] = [];
async function output(): Promise<string> {
  assert.ok(sessionId);
  const value = record(await api(`/api/v2/sessions/${sessionId}/output?after=${cursor}&limit=100`));
  assert.ok(Array.isArray(value['chunks']));
  for (const chunk of value['chunks']) {
    const item = record(chunk); assert.equal(item['sequence'], ++cursor); assert.ok(Array.isArray(item['bytes']));
    outputChunks.push(Uint8Array.from(item['bytes'].map(Number)));
  }
  return Buffer.concat(outputChunks).toString('utf8');
}
async function has(marker: string) { await until(output, (value) => typeof value === 'string' && value.includes(marker), marker); }
async function size(label: string) {
  const marker = 'DFBROWSER:SIZE-' + label + ':';
  const pattern = new RegExp(marker + '(\\d+):(\\d+)');
  await command(`[Console]::WriteLine(('DF'+'BROWSER:SIZE-${label}:')+[Console]::WindowWidth+':'+[Console]::WindowHeight)`);
  const bytes = String(await until(output, (value) => typeof value === 'string' && pattern.test(stripVTControlCharacters(value)), marker));
  const match = stripVTControlCharacters(bytes).match(pattern); assert.ok(match);
  const cols = Number(match[1]), rows = Number(match[2]);
  assert.ok(cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200);
  const viewport = record(await evaluate(`(() => {const box=document.querySelector('[data-product-page="terminal"] .xterm-screen').getBoundingClientRect();return {width:box.width,height:box.height,viewport:innerWidth,documentWidth:document.documentElement.scrollWidth};})()`));
  return { cols, rows, width: Number(viewport['width']), height: Number(viewport['height']), viewport: Number(viewport['viewport']), documentWidth: Number(viewport['documentWidth']) };
}
async function button(label: string) {
  // 页面请求期间按钮会正常禁用；等待真实可用再点击，保留有界超时。
  await until(() => evaluate(`(() => {const target=[...document.querySelectorAll('[data-product-page="terminal"] button')].find(item=>item.getClientRects().length&&(item.textContent.trim()===${JSON.stringify(label)}||item.getAttribute('aria-label')===${JSON.stringify(label)})); if(!target||target.disabled)return false;target.click();return true;})()`), Boolean, '终端按钮可用：' + label);
}
async function terminalPageReady() {
  await until(() => evaluate(`!!document.querySelector('[data-product-page="terminal"]')`), Boolean, '终端页面');
  await until(() => evaluate(`(() => {const item=[...document.querySelectorAll('[data-product-page="terminal"] button')].find(item=>item.textContent.trim()==='新会话');return item&&!item.disabled})()`), Boolean, '可打开的终端档案');
}
async function complete(id: string) {
  const ending = record(await until(() => api(`/api/v2/sessions/${id}`), (value) => object(value) && value['status'] === 'finished', '终端会话清理完成'));
  // 先保存真实终态；断言失败时也必须保留后端错误及清理证据。
  const completions = object(report['session_completions']) ? report['session_completions'] : {};
  completions[id] = ending;
  report['session_completions'] = completions;
  const completion = record(ending['completion']);
  assert.equal(completion['cleanup'], 'complete'); assert.equal(completion['process_exited'], true);
  return ending;
}
async function historyAction(id: string, action: '删除记录' | '关闭并释放') {
  const label = action + ' ' + id.slice(0, 8);
  await until(() => evaluate(`(() => {const item=[...document.querySelectorAll('[aria-label="服务器终端记录"] button')].find(item=>item.getAttribute('aria-label')===${JSON.stringify(label)});return item&&!item.disabled})()`), Boolean, '历史记录操作：' + label);
  await button(label);
}
async function absent(id: string) {
  await until(() => api('/api/v2/sessions'), (value) => Array.isArray(value) && !value.some((entry) => object(entry) && entry['id'] === id), '记录从真实服务器删除');
}
async function released(id: string, generation: string) {
  const observations: Json[] = [];
  await until(async () => {
    const reply = await fetch(new URL(`/api/v2/sessions/${id}`, base), { signal: AbortSignal.timeout(15000) });
    const value = record(await reply.json());
    requests.push({ path: `/api/v2/sessions/${id}`, method: 'GET', status: reply.status, log_id: value['log_id'] });
    observations.push({ status: reply.status, data: value['data'], error: value['error'] });
    if (reply.status === 404) { assert.equal(record(value['error'])['code'], 'not_found'); return true; }
    assert.equal(reply.status, 200);
    const current = record(value['data']);
    if (current['status'] === 'finished') {
      assert.equal(record(current['completion'])['cleanup'], 'complete');
      assert.equal(record(current['completion'])['process_exited'], true);
    }
    return false;
  }, Boolean, 'release确认清理后的自动删除');
  const logDirectory = join(hostData, 'logs');
  const endLog = record(await until(async () => {
    const paths = (await readdir(logDirectory)).filter(name => name.endsWith('.jsonl'));
    for (const name of paths) {
      const content = await readFile(join(logDirectory, name), 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        const entry = record(JSON.parse(line));
        if (object(entry['fields']) && entry['fields']['session_id'] === id && entry['fields']['message'] === '交互会话已结束') return entry;
      }
    }
    return undefined;
  }, object, '同会话结束审计日志'));
  assert.equal(record(endLog['fields'])['cleanup'], 'Some(Complete)', '404还必须对应同会话Complete审计日志');
  const plugins = await api('/api/v2/plugins'); assert.ok(Array.isArray(plugins));
  const plugin = record(plugins.find(entry => object(entry) && entry['id'] === 'terminal'));
  assert.equal(plugin['generation'], generation); assert.equal(plugin['cleanup_failed'], false); assert.equal(plugin['protected'], false);
  await absent(id);
  return { id, generation, observations, end_log: endLog, plugin_after_release: plugin };
}
async function refreshAndHistory() {
  assert.ok(page);
  await terminalPageReady();
  await button('新会话');
  const refreshSessions = await until(() => api('/api/v2/sessions'), (value) => Array.isArray(value) && value.some((entry) => object(entry) && entry['status'] !== 'finished'), '刷新前真实运行终端');
  assert.ok(Array.isArray(refreshSessions));
  const refreshSession = record(refreshSessions.find((entry) => object(entry) && entry['status'] !== 'finished'));
  const refreshId = text(refreshSession['id']); ownedSessions.add(refreshId);
  await until(() => evaluate(`!!document.querySelector('.xterm-helper-textarea')`), Boolean, '刷新前xterm绑定');
  await page.call('Page.reload', { ignoreCache: true });
  await terminalPageReady();
  const releasedRefresh = await released(refreshId, text(refreshSession['generation']));
  await button('刷新记录');
  checks.push({ name: '真实页面刷新keepalive释放，Complete审计与自动删除记录', passed: true });
  report['refresh_release'] = releasedRefresh;
  const historical = record(await api('/api/v2/sessions', 'POST', { operation: 'plugin.terminal.open', input: { profile: 'powershell', terminal: { protocol: 'deviceforge.terminal.v1', cols: 100, rows: 28 } } }));
  const historicalId = text(historical['id']); ownedSessions.add(historicalId);
  assert.equal(historical['generation'], refreshSession['generation'], '刷新释放后历史新会话仍须原代次准入');
  await button('刷新记录');
  await until(() => evaluate(`[...document.querySelectorAll('[aria-label="服务器终端记录"] button')].some(item=>item.getAttribute('aria-label')===${JSON.stringify('关闭并释放 ' + historicalId.slice(0, 8))})`), Boolean, '服务器历史活终端可见');
  await capture('history-active-terminal');
  await historyAction(historicalId, '关闭并释放');
  const closed = await released(historicalId, text(historical['generation']));
  await button('刷新记录');
  const removable = record(await api('/api/v2/sessions', 'POST', { operation: 'plugin.terminal.open', input: { profile: 'powershell', terminal: { protocol: 'deviceforge.terminal.v1', cols: 100, rows: 28 } } }));
  const removableId = text(removable['id']); ownedSessions.add(removableId);
  assert.equal(removable['generation'], historical['generation']);
  await api(`/api/v2/sessions/${removableId}/cancel`, 'POST');
  const cancelled = await complete(removableId);
  await button('刷新记录');
  await historyAction(removableId, '删除记录'); await absent(removableId);
  await capture('history-cleaned-terminal');
  report['history_release'] = closed;
  report['history_delete'] = { id: removableId, completion: cancelled['completion'] };
  checks.push({ name: '仅释放指定历史活终端、确认Complete自动删除，再删除cancel结束记录', passed: true });
}

try {
  const existing = await api('/api/v2/sessions');
  assert.ok(Array.isArray(existing));
  assert.equal(existing.length, 0, '独占验收宿主必须没有既有会话');
  const windowsBefore = await windowsObservation(ownerPid);
  report['windows_before'] = windowsBefore;
  vite = await createServer({ root: source, configFile: false, appType: 'spa', logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': base.origin, '/mcp': base.origin } } });
  await vite.listen();
  const address = vite.httpServer?.address(); assert.ok(address && typeof address === 'object');
  report['frontend'] = `http://127.0.0.1:${address.port}`;
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
    '--headless=new', '--disable-gpu', '--disable-background-mode', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(out, 'edge-profile')}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  report['browser_pid'] = browser.pid;
  browser.stderr?.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-16384); });
  browser.once('error', (error) => { diagnostic += '\n浏览器启动失败：' + error.message; });
  const browserUrl = text(await until(async () => diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1], (value) => typeof value === 'string', '浏览器调试地址'));
  browserProtocol = await protocol(browserUrl);
  report['browser_version'] = await browserProtocol.call('Browser.getVersion');
  const endpoint = new URL(browserUrl); endpoint.protocol = 'http:'; endpoint.pathname = '/json/new'; endpoint.search = '?' + encodeURIComponent(String(report['frontend']) + '/#terminal');
  const target = record(await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(10000) }).then((reply) => reply.json()));
  page = await protocol(text(target['webSocketDebuggerUrl']));
  await page.call('Page.enable'); await page.call('Runtime.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await terminalPageReady();
  await button('新会话');
  const sessions = await until(() => api('/api/v2/sessions'), (value) => Array.isArray(value) && value.length === 1, '新建PTY会话');
  assert.ok(Array.isArray(sessions)); sessionId = text(record(sessions[0])['id']); ownedSessions.add(sessionId); report['session_id'] = sessionId;
  await until(() => evaluate(`!!document.querySelector('[data-product-page="terminal"] .xterm-helper-textarea')`), Boolean, 'xterm真实输入节点');
  await has('PS ');
  // 初始connecting切到running时表面可能重建，在提示符后同一次DOM操作绑定输入。
  await until(() => evaluate(`(() => {const field=document.querySelector('[data-product-page="terminal"] .xterm-helper-textarea');if(!field)return false;field.focus();if(document.activeElement!==field)return false;window.terminalProbeInputEvents=[];for(const kind of ['keydown','keypress','keyup','compositionstart','compositionupdate','compositionend'])field.addEventListener(kind,event=>{if(window.terminalProbeInputEvents.length<6000)window.terminalProbeInputEvents.push({type:event.type,trusted:event.isTrusted,...(event.type.startsWith('composition')?{data:event.data}:{})});},true);return true;})()`), Boolean, '真实PowerShell就绪后的xterm聚焦');
  checks.push({ name: '生产页面打开真实xterm与PowerShell', passed: true });
  await command("[Console]::WriteLine(('DF'+'BROWSER:TTY:')+[Console]::IsInputRedirected+':'+[Console]::IsOutputRedirected)");
  await has('DFBROWSER:TTY:False:False');
  const desktopSize = await size('DESKTOP');
  await command("$dfCompletionValue='DF'+'BROWSER:TAB'; Write-Output ('DF'+'BROWSER:HISTORY')");
  await has('DFBROWSER:HISTORY');
  await key('ArrowUp', 'ArrowUp', 38); await key('Enter', 'Enter', 13, 0, '\r');
  await until(output, (value) => typeof value === 'string' && value.split('DFBROWSER:HISTORY').length >= 3, '方向键命令历史');
  await insert('Write-Output $dfCompletionV'); await key('Tab', 'Tab', 9, 0, '\t'); await key('Enter', 'Enter', 13, 0, '\r');
  await has('DFBROWSER:TAB');
  checks.push({ name: '真实键盘方向历史与Tab补全', passed: true });
  await insert("[Console]::WriteLine(('DF'+'BROWSER:IME:')+'");
  await composition('中文'); await insert("')"); await key('Enter', 'Enter', 13, 0, '\r');
  await has('DFBROWSER:IME:中文');
  const inputEvents = await evaluate('window.terminalProbeInputEvents');
  assert.ok(Array.isArray(inputEvents));
  for (const kind of ['keydown', 'keypress', 'keyup', 'compositionstart', 'compositionupdate']) {
    assert.ok(inputEvents.some((value) => object(value) && value['type'] === kind && value['trusted'] === true), '须观察到浏览器受信任输入事件：' + kind);
  }
  // Edge的CDP提交会产生isTrusted=false的compositionend，独立空白页亦相同；不伪称物理输入法验证。
  assert.ok(inputEvents.some((value) => object(value) && value['type'] === 'compositionend' && value['data'] === '中文'));
  report['input_event_counts'] = Object.fromEntries(['keydown', 'keypress', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend'].map((kind) => [kind, {
    trusted: inputEvents.filter((value) => object(value) && value['type'] === kind && value['trusted'] === true).length,
    untrusted: inputEvents.filter((value) => object(value) && value['type'] === kind && value['trusted'] === false).length,
  }]));
  report['ime_scope'] = '通过Chromium CDP触发浏览器组合输入，start/update受信任、协议提交的end为非受信任；未使用操作系统物理输入法。';
  checks.push({ name: 'CDP浏览器IME组合事件与中文UTF8提交', passed: true });
  await evaluate(`(() => {const field=document.querySelector('.xterm-helper-textarea');const data=new DataTransfer();data.setData('text/plain',"[Console]::WriteLine('DF'+'BROWSER:PASTE:一')\\r\\n[Console]::WriteLine('DF'+'BROWSER:PASTE:二')\\r\\n".replaceAll('\\\\r','\\r').replaceAll('\\\\n','\\n'));field.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);
  await has('DFBROWSER:PASTE:一'); await has('DFBROWSER:PASTE:二');
  checks.push({ name: 'xterm粘贴事件处理多行中文（合成剪贴板事件）', passed: true });
  await command('Start-Sleep -Seconds 60'); await delay(400);
  const beforeInterrupt = (await output()).length;
  await key('c', 'KeyC', 67, 2);
  await until(output, (value) => typeof value === 'string' && /PS [^\r\n]*>/.test(stripVTControlCharacters(value.slice(beforeInterrupt))), 'Ctrl+C后原shell重新就绪');
  await command("[Console]::WriteLine('DF'+'BROWSER:AFTER-CTRL-C')"); await has('DFBROWSER:AFTER-CTRL-C');
  checks.push({ name: 'Ctrl+C打断后继续同一shell', passed: true });
  assert.equal(await evaluate(`(() => {const item=document.querySelector('[data-navigation-route="settings"]');if(!item||!item.getClientRects().length)return false;item.click();return true;})()`), true);
  await until(() => evaluate(`document.querySelector('[data-route="terminal"]')?.hidden === true && location.hash === '#settings'`), Boolean, '路由离开时隐藏终端');
  const hiddenSession = record(await api(`/api/v2/sessions/${sessionId}`));
  assert.notEqual(hiddenSession['status'], 'finished', '普通路由离开不能终止正在运行的终端');
  assert.equal(await evaluate(`(() => {const item=document.querySelector('[data-navigation-route="terminal"]');if(!item||!item.getClientRects().length)return false;item.click();return true;})()`), true);
  await until(() => evaluate(`document.querySelector('[data-route="terminal"]')?.hidden === false && !!document.querySelector('[data-product-page="terminal"] .xterm-helper-textarea')`), Boolean, '路由返回显示原终端');
  await evaluate(`document.querySelector('[data-product-page="terminal"] .xterm-helper-textarea').focus()`);
  await command("[Console]::WriteLine('DF'+'BROWSER:ROUTE-RETURN')"); await has('DFBROWSER:ROUTE-RETURN');
  report['route_return'] = { session_id: sessionId, hidden_status: hiddenSession['status'] };
  checks.push({ name: '路由离开仅隐藏终端、返回后同一真实shell继续输入', passed: true });
  await capture('desktop-terminal');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false }); await delay(450);
  const narrowSize = await size('NARROW');
  assert.ok(narrowSize.cols < desktopSize.cols, '窄屏须使真实PTY列数减小');
  assert.ok(Number(narrowSize['documentWidth']) <= Number(narrowSize['viewport']) + 1, '窄屏不应产生文档横向溢出');
  report['resize'] = { desktop: desktopSize, narrow: narrowSize };
  await capture('narrow-terminal');
  checks.push({ name: '浏览器fit与窄屏实际缩放', passed: true });
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(350);
  const codexDirectory = join(out, 'codex-workspace');
  await mkdir(codexDirectory);
  await command("Set-Location -LiteralPath '" + codexDirectory.replaceAll("'", "''") + "'; [Console]::WriteLine('DF'+'BROWSER:WORKSPACE')");
  await has('DFBROWSER:WORKSPACE');
  await command("[Console]::WriteLine(('DF'+'BROWSER:CODEX-COMMAND:')+(Get-Command codex).Source)");
  await has('DFBROWSER:CODEX-COMMAND:');
  await command("[Console]::WriteLine(('DF'+'BROWSER:PATHEXT:')+$env:PATHEXT)");
  await has('DFBROWSER:PATHEXT:.COM;.EXE');
  await command("[Console]::WriteLine(('DF'+'BROWSER:NODE-COMMAND:')+(Get-Command node).Source); [Console]::WriteLine(('DF'+'BROWSER:PATH-NODE:')+($env:PATH.Split(';') -contains (Split-Path (Get-Command node).Source)))");
  await has('DFBROWSER:PATH-NODE:True');
  await command(`node -e "console.log('DF'+'BROWSER:NODE-CHILD')"`);
  await has('DFBROWSER:NODE-CHILD');
  const resolution = stripVTControlCharacters(await output());
  report['command_resolution'] = {
    codex: resolution.match(/DFBROWSER:CODEX-COMMAND:([^\r\n]+)/)?.[1],
    node: resolution.match(/DFBROWSER:NODE-COMMAND:([^\r\n]+)/)?.[1],
    pathext: resolution.match(/DFBROWSER:PATHEXT:([^\r\n]+)/)?.[1],
    path_contains_node: resolution.includes('DFBROWSER:PATH-NODE:True'),
    ordinary_node_output: resolution.includes('DFBROWSER:NODE-CHILD'),
  };
  const versionStart = (await output()).length;
  await command("codex --version; [Console]::WriteLine(('DF'+'BROWSER:CODEX-VERSION-EXIT:')+$LASTEXITCODE)");
  await has('DFBROWSER:CODEX-VERSION-EXIT:');
  const versionOutput = stripVTControlCharacters((await output()).slice(versionStart));
  report['codex_version_diagnostic'] = versionOutput.slice(-5000);
  assert.match(versionOutput, /codex-cli \d+\.\d+\.\d+/, '普通codex命令须输出真实CLI版本');
  report['codex_version'] = versionOutput.match(/codex-cli \d+\.\d+\.\d+/)?.[0];
  await command('Clear-Host');
  await delay(200);
  const codexStart = (await output()).length;
  await command('codex --no-alt-screen');
  const codexBytes = String(await until(output, (value) => typeof value === 'string' && /(?:OpenAI Codex|Welcome to Codex|Sign in with|Do you trust|trust.*directory|登录|信任此目录)/i.test(stripVTControlCharacters(value.slice(codexStart))), 'Codex真实界面', 30000));
  report['codex_screen_text'] = stripVTControlCharacters(codexBytes.slice(codexStart)).slice(-12000);
  const codexWindows = await windowsObservation(ownerPid);
  const codexProcesses = codexWindows.processes.filter((entry) => /^codex(?:[.-].*)?\.exe$/i.test(entry.executable));
  assert.ok(codexProcesses.length > 0, 'Codex界面必须对应独占宿主派生的真实CLI进程');
  assert.deepEqual(newConsoleWindows(windowsBefore, codexWindows), [], 'Codex及派生程序不得打开可见原生控制台');
  report['codex_windows'] = codexWindows;
  report['codex_processes'] = codexProcesses;
  await capture('codex-entry');
  await key('c', 'KeyC', 67, 2); await delay(300); await key('c', 'KeyC', 67, 2); await delay(500);
  await command("[Console]::WriteLine('DF'+'BROWSER:CODEX-RETURN')"); await has('DFBROWSER:CODEX-RETURN');
  const returnedWindows = await windowsObservation(ownerPid);
  for (const entry of codexProcesses) assert.ok(!returnedWindows.processes.some((item) => item.pid === entry.pid), '退出后的Codex PID须已消失');
  assert.deepEqual(newConsoleWindows(windowsBefore, returnedWindows), []);
  report['windows_after_codex'] = returnedWindows;
  checks.push({ name: '真实Codex界面及归属PID、无新窗口、Ctrl+C退出原shell（截图须独立图审）', passed: true });
  await button('关闭会话');
  const ending = record(await until(() => api(`/api/v2/sessions/${sessionId}`), (value) => object(value) && value['status'] === 'finished', '网页关闭后的服务终态'));
  const completion = record(ending['completion']); assert.equal(completion['cleanup'], 'complete'); assert.equal(completion['process_exited'], true);
  assert.equal(record(completion['failure'])['code'], 'cancelled'); sessionFinished = true;
  checks.push({ name: '页面关闭会话并确认清理完成', passed: true });
  await refreshAndHistory();
  report['passed'] = true;
} catch (error) {
  report['failure'] = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  report['failure_terminal_tail'] = stripVTControlCharacters(Buffer.concat(outputChunks).toString('utf8')).slice(-12000);
  try { await capture('failure'); } catch { /* 浏览器本身失败时仍保留HTTP和错误报告。 */ }
} finally {
  if (sessionId && !sessionFinished) {
    try { await api(`/api/v2/sessions/${sessionId}/cancel`, 'POST'); }
    catch (error) { report['session_cleanup_failure'] = String(error); report['passed'] = false; }
  }
  for (const id of ownedSessions) {
    try {
      const records = await api('/api/v2/sessions'); assert.ok(Array.isArray(records));
      const remaining = records.find((value) => object(value) && value['id'] === id);
      if (object(remaining) && remaining['status'] !== 'finished') await api(`/api/v2/sessions/${id}/cancel`, 'POST');
    } catch (error) { report['owned_session_cleanup_failure'] = String(error); report['passed'] = false; }
  }
  if (browserProtocol) { try { await browserProtocol.call('Browser.close'); } catch { /* 浏览器关闭可能先断开调试通道。 */ } }
  page?.close(); browserProtocol?.close();
  if (browser && browser.exitCode === null) await Promise.race([new Promise<void>((done) => browser?.once('exit', () => done())), delay(15000)]);
  if (browser && browser.exitCode === null) {
    report['browser_normal_exit_timeout_ms'] = 15000;
    browser.kill(); report['browser_forced_exit'] = true; report['passed'] = false;
    await Promise.race([new Promise<void>((done) => browser?.once('exit', () => done())), delay(5000)]);
  }
  if (browser) report['browser_exit'] = { code: browser.exitCode, signal: browser.signalCode };
  if (browser?.pid) {
    try {
      const remaining = await windowsObservation(browser.pid);
      report['browser_remaining_processes'] = remaining.processes;
      if (remaining.processes.length > 0) report['passed'] = false;
    } catch (error) { report['browser_process_observation_failure'] = String(error); report['passed'] = false; }
  }
  await vite?.close();
  report['completed_at'] = new Date().toISOString();
  await writeFile(join(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(out, 'browser-diagnostic.txt'), diagnostic);
  console.log(JSON.stringify({ out, passed: report['passed'], checks: checks.length, failure: report['failure'] }));
  if (!report['passed']) process.exitCode = 1;
}
