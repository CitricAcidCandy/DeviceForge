import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { themeProtocol } from './browser-theme-smoke/cdp.mjs';
import { observeChild } from './unified-discovery-browser/lifecycle.mjs';
import { serverFixture } from '../backend/scripts/online-plugins/fixtures.mjs';
import { themeFixtures } from './browser-theme-smoke/fixtures.mjs';
import { deviceProviderFixture } from './browser-plugin-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(
  root,
  'artifacts/product-ui',
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8),
);
await mkdir(out, { recursive: true });
const report = {
  timestamp: new Date().toISOString(),
  out,
  scope:
    '真实隔离Rust宿主与生产React界面的浏览器行为、14路由桌面/窄屏截图；不操作设备、模拟器或桌面输入，不证明媒体播放与Root资格',
  cases: [],
  pages: [],
  screenshots: [],
  processes: {},
};
let host, hostObserved, vite, browserChild, browserObserved, browser, page, base;
const routes = [
  'devices',
  'packages',
  'files',
  'media',
  'performance',
  'frida',
  'automation',
  'terminal',
  'ai',
  'analysis',
  'plugins',
  'tasks',
  'tools',
  'settings',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function digestTree(directory) {
  const result = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else {
        const bytes = await readFile(child);
        result.push({
          path: child.slice(directory.length + 1),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
      }
    }
  }
  await walk(directory);
  return result;
}
async function port() {
  const listener = netServer();
  await new Promise((done, fail) => {
    listener.once('error', fail);
    listener.listen(0, '127.0.0.1', done);
  });
  const value = listener.address().port;
  await new Promise((done) => listener.close(done));
  return value;
}
async function api(path, options = {}) {
  const response = await fetch(base + path, { ...options, signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${body.error?.code ?? ''}`);
  return body.data;
}
async function evaluate(expression) {
  const reply = await page.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (reply.exceptionDetails)
    throw new Error(reply.exceptionDetails.exception?.description ?? '页面表达式失败');
  return reply.result.value;
}
async function wait(expression, label = '页面状态', milliseconds = 8000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    try {
      if (await evaluate(expression)) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`${label}未就绪`);
}
async function capture(name) {
  await evaluate('document.fonts.ready');
  await delay(120);
  const shot = await page.call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  const path = join(out, name + '.png');
  await writeFile(path, Buffer.from(shot.data, 'base64'));
  report.screenshots.push({ name, path });
  return path;
}
async function viewport(width, height) {
  await page.call('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(50);
}
async function route(id) {
  await evaluate(`location.hash=${JSON.stringify(id)}`);
  await wait(`document.querySelector('[data-route="${id}"]')?.hidden===false`, id);
  await evaluate('document.querySelector("#workplane").scrollTop=0');
}
const active = '[data-route]:not([hidden])';
async function click(text, scope = active) {
  const result = await evaluate(
    `(() => {const buttons=[...document.querySelectorAll(${JSON.stringify(scope)}+' button')].filter(b=>b.getClientRects().length&&!b.closest('[hidden]'));const b=buttons.find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b) return {error:'找不到按钮',buttons:buttons.map(b=>b.textContent.trim())};if(b.disabled)return {error:'按钮禁用'};b.focus();b.click();return {clicked:true};})()`,
  );
  assert.ok(result.clicked, `${text}: ${JSON.stringify(result)}`);
  await delay(70);
}
async function field(label, value) {
  return evaluate(
    `(() => {const labels=[...document.querySelectorAll('${active} label')];const l=labels.find(l=>l.textContent.trim()===${JSON.stringify(label)});if(!l)throw new Error('找不到标签');const el=document.querySelector('${active} [id="'+l.htmlFor+'"]');if(!el)throw new Error('找不到输入');el.focus();const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
  );
}
async function file(selector, path) {
  const document = await page.call('DOM.getDocument');
  const node = await page.call('DOM.querySelector', { nodeId: document.root.nodeId, selector });
  assert.ok(node.nodeId, '文件输入不存在');
  await page.call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] });
  await delay(100);
}
async function key(key, code, virtual) {
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: virtual,
    nativeVirtualKeyCode: virtual,
  });
  await page.call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: virtual,
    nativeVirtualKeyCode: virtual,
  });
  await delay(50);
}
async function check(name, action) {
  try {
    const result = await action();
    report.cases.push({ name, passed: true, result: result ?? null });
  } catch (error) {
    report.cases.push({ name, passed: false, error: error.message });
    await capture('failure-' + report.cases.length).catch(() => {});
  }
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
}
async function pluginButton(id, text) {
  const result = await evaluate(
    `(() => {const row=[...document.querySelectorAll('${active} .plugin-row')].find(r=>r.querySelector('h3')?.textContent.includes(${JSON.stringify(id)}));const b=[...(row?.querySelectorAll('button')??[])].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)return false;b.focus();b.click();return true;})()`,
  );
  assert.ok(result, `${id} ${text} 不可用`);
  await delay(100);
}

try {
  const frozen = join(out, 'frozen-dist');
  await cp(resolve(root, 'frontend/dist'), frozen, { recursive: true });
  report.inputs = await digestTree(frozen);
  const binary = resolve(root, 'backend/target/debug/apk-server.exe');
  const binaryBytes = await readFile(binary);
  report.host = { path: binary, bytes: binaryBytes.length, sha256: hash(binaryBytes) };
  const hostPort = await port();
  base = `http://127.0.0.1:${hostPort}`;
  report.base = base;
  host = spawn(binary, [], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      APK_API_TOKEN: '',
      APK_BIND: `127.0.0.1:${hostPort}`,
      APK_DATA_DIR: join(out, 'session/data'),
      APK_PLUGIN_DIR: join(out, 'session/server-plugins'),
      APK_BROWSER_PLUGIN_DIR: join(out, 'session/browser-plugins'),
      DEVICEFORGE_NODE: process.execPath,
    },
  });
  hostObserved = observeChild(host, (report.processes.host = {}));
  for (let i = 0; ; i++) {
    try {
      report.operations = await api('/api/v2/operations');
      break;
    } catch {
      if (i > 100 || host.exitCode !== null) throw new Error('隔离宿主启动失败');
      await delay(100);
    }
  }
  vite = await createServer({
    root: frozen,
    configFile: false,
    appType: 'spa',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': base } },
  });
  await vite.listen();
  report.frontend = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const executable = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browserChild = spawn(
    executable,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(out, 'session/edge-profile')}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  browserObserved = observeChild(browserChild, (report.processes.browser = {}));
  let browserUrl;
  for (let i = 0; ; i++) {
    browserUrl = report.processes.browser.diagnostic.match(
      /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/,
    )?.[1];
    if (browserUrl) break;
    if (i > 150 || browserChild.exitCode !== null) throw new Error('隔离Edge未就绪');
    await delay(100);
  }
  browser = await themeProtocol(browserUrl, { socket_events: [] });
  report.browser = await browser.call('Browser.getVersion');
  const endpoint = new URL(browserUrl);
  endpoint.protocol = 'http:';
  endpoint.pathname = '/json/new';
  endpoint.search = '?' + encodeURIComponent(report.frontend);
  const target = await fetch(endpoint, { method: 'PUT' }).then((r) => r.json());
  page = await themeProtocol(target.webSocketDebuggerUrl, { socket_events: [] });
  await page.call('Runtime.enable');
  await page.call('Page.enable');
  await page.call('DOM.enable');
  await viewport(1366, 768);
  await wait('!!document.querySelector(".product-shell")', '生产React页面');
  await wait(
    'document.querySelector(".connection-state")?.textContent.includes("服务器已连接")',
    '实际目录连接',
  );
  report.initialProviders = await api('/api/v2/device-providers');
  for (const id of routes) {
    await route(id);
    for (const [width, height, size] of [
      [1366, 768, 'desktop'],
      [390, 844, 'narrow'],
    ]) {
      await viewport(width, height);
      const observation = await evaluate(
        `(() => { const current=document.querySelector('${active}');return {heading:current?.querySelector('h1')?.textContent,text:current?.innerText,documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,workplaneHeight:document.querySelector('#workplane').getBoundingClientRect().height,controls:[...current.querySelectorAll('button')].filter(b=>b.getClientRects().length).map(b=>({text:b.textContent.trim(),disabled:b.disabled}))};})()`,
      );
      report.pages.push({ id, width, height, ...observation });
      await capture(`${size}-${id}`);
    }
  }
  await viewport(1366, 768);
  await check('路由保留表单草稿', async () => {
    await route('settings');
    await field('归属 ID', '审图草稿-保留');
    await route('files');
    await route('settings');
    const value = await evaluate(`document.querySelector('${active} [id="field-归属 ID"]').value`);
    assert.equal(value, '审图草稿-保留');
    return { value };
  });
  await check('窄屏菜单键盘与焦点返回', async () => {
    await viewport(390, 844);
    await evaluate(`document.querySelector('.compact-tools button').focus()`);
    await key('Enter', 'Enter', 13);
    await wait('!!document.querySelector("[role=menu]")', '全部工具菜单');
    const count = await evaluate('document.querySelectorAll("[role=menuitem]").length');
    assert.equal(count, 14);
    await key('ArrowDown', 'ArrowDown', 40);
    const focused = await evaluate('document.activeElement.getAttribute("role")');
    assert.equal(focused, 'menuitem');
    await capture('state-menu-keyboard');
    await key('Escape', 'Escape', 27);
    await wait('!document.querySelector("[role=menu]")');
    assert.equal(
      await evaluate('document.activeElement===document.querySelector(".compact-tools button")'),
      true,
    );
    await viewport(1366, 768);
    return { entries: count, focusReturned: true };
  });
  await check('原文件上传、已知ID、Dialog焦点与删除', async () => {
    const path = join(out, '审图-长文件名-真实上传-UTF8.txt');
    await writeFile(path, '设备工坊生产页面验收\n只写入隔离服务，不涉及设备文件。\n', 'utf8');
    await route('files');
    await file(`${active} #artifact-upload`, path);
    await wait(
      `document.querySelector('${active} h2')?.textContent.includes('审图-长文件名')`,
      '真实上传元数据',
    );
    const id = await evaluate(`document.querySelector('${active} [id="field-公开产物 ID"]').value`);
    assert.ok(id);
    await capture('state-file-uploaded');
    await field('公开产物 ID', id);
    await click('读取文件元数据');
    await wait(`document.querySelector('${active} h2')?.textContent.includes('审图-长文件名')`);
    await click('删除产物');
    await wait('!!document.querySelector("[role=dialog]")', '删除确认');
    assert.equal(await evaluate('!!document.activeElement.closest("[role=dialog]")'), true);
    for (let i = 0; i < 6; i++) {
      await key('Tab', 'Tab', 9);
      assert.equal(await evaluate('!!document.activeElement.closest("[role=dialog]")'), true);
    }
    await capture('state-file-delete-dialog');
    await key('Escape', 'Escape', 27);
    await wait('!document.querySelector("[role=dialog]")');
    assert.equal(await evaluate('document.activeElement.textContent.trim()==="删除产物"'), true);
    await click('删除产物');
    await click('确认删除', '[role=dialog]');
    await wait(
      `document.querySelector('${active}')?.innerText.includes('尚未选择产物')`,
      '删除后的空态',
    );
    const response = await fetch(base + '/api/v2/artifacts/' + id);
    assert.equal(response.status, 404);
    return { id, deletedStatus: response.status, focusTrap: true, focusReturned: true };
  });
  await check('公开ID失败常驻与真实日志ID', async () => {
    await route('files');
    await field('公开产物 ID', '00000000-0000-4000-8000-000000000099');
    await click('读取文件元数据');
    await wait(`!!document.querySelector('${active} [role=alert]')`, '真实读取失败');
    const text = await evaluate(`document.querySelector('${active} [role=alert]').innerText`);
    assert.ok(text.includes('日志 ID'));
    await capture('state-file-error');
    return { text };
  });
  await check('专注与减少动态效果', async () => {
    await click('专注', '.global-actions');
    assert.equal(
      await evaluate('document.querySelector(".product-shell").classList.contains("is-focused")'),
      true,
    );
    await capture('state-focus');
    await click('退出专注', '.global-actions');
    await evaluate('document.querySelector("[aria-label=更多设置]").click()');
    await wait('!!document.querySelector("[role=menu]")');
    await evaluate(
      '[...document.querySelectorAll("[role=menuitemcheckbox]")].find(e=>e.textContent.includes("减少动态效果")).click()',
    );
    assert.equal(
      await evaluate(
        'document.querySelector(".product-shell").classList.contains("reduce-motion")',
      ),
      true,
    );
    await key('Escape', 'Escape', 27);
    return { focused: true, reduced: true };
  });
  const fixtureDirectory = join(out, 'fixtures');
  await mkdir(fixtureDirectory);
  const echo = serverFixture(2);
  const theme = themeFixtures().first;
  const device = await deviceProviderFixture();
  const echoPath = join(fixtureDirectory, echo.id + '.tgz'),
    themePath = join(fixtureDirectory, theme.id + '.tgz'),
    devicePath = join(fixtureDirectory, device.id + '.tgz');
  await writeFile(echoPath, echo.archive);
  await writeFile(themePath, theme.archive);
  await writeFile(devicePath, device.archive);
  report.fixtures = [
    { id: echo.id, kind: 'server_echo', sha256: hash(echo.archive) },
    { id: theme.id, kind: 'browser_theme', sha256: hash(theme.archive) },
    { id: device.id, kind: 'synthetic_device_provider', sha256: hash(device.archive) },
  ];
  await check('服务器包UI提交启停与能力收敛', async () => {
    await route('plugins');
    await file(`${active} #plugin-file`, echoPath);
    await click('提交插件包');
    await wait(
      `document.querySelector('${active}').innerText.includes('${echo.id}')`,
      '服务器包目录',
    );
    const operation = `plugin.${echo.id}.echo`;
    assert.equal(
      (await api('/api/v2/operations')).some((item) => item.id === operation),
      false,
    );
    await pluginButton(echo.id, '启用');
    await wait(
      `document.querySelector('${active} .plugin-row')?.innerText.includes('已启用')`,
      '启用状态',
    );
    assert.equal(
      (await api('/api/v2/operations')).some((item) => item.id === operation),
      true,
    );
    await capture('state-server-plugin-enabled');
    await pluginButton(echo.id, '停用');
    await wait(`!document.querySelector('${active} .operation-progress')`, '停用等待');
    for (
      let i = 0;
      i < 50 && (await api('/api/v2/operations')).some((item) => item.id === operation);
      i++
    )
      await delay(100);
    assert.equal(
      (await api('/api/v2/operations')).some((item) => item.id === operation),
      false,
    );
    return { operation, availableAfterEnable: true, absentAfterDisable: true };
  });
  await check('合成设备提供者目录与选择', async () => {
    await route('plugins');
    await file(`${active} #plugin-file`, devicePath);
    await click('提交插件包');
    await wait(`document.querySelector('${active}').innerText.includes('${device.id}')`);
    await pluginButton(device.id, '启用');
    await route('devices');
    await click('刷新设备');
    await wait(`document.querySelector('${active}').innerText.includes('${device.id}')`);
    const clicked = await evaluate(
      `(() => {const strip=[...document.querySelectorAll('${active} .provider-strip>div')].find(r=>r.innerText.includes('${device.id}'));const b=strip?.querySelector('button');if(!b)return false;b.focus();b.click();return true;})()`,
    );
    assert.equal(clicked, true);
    await wait(
      `document.querySelector('${active}').innerText.includes('demo-device')`,
      '合成设备发现',
    );
    await click('选择设备');
    await capture('state-synthetic-device');
    const selection = await evaluate('document.querySelector(".dock-device").innerText');
    assert.ok(selection.includes('在线'));
    return { fixture: '公开独立Node示例，不是真机或模拟器', selection };
  });
  await check('浏览器包UI挂载、主题选择与停用恢复', async () => {
    await route('plugins');
    await click('浏览器插件');
    await file(`${active} #plugin-file`, themePath);
    await click('提交插件包');
    await wait(`document.querySelector('${active}').innerText.includes('${theme.id}')`);
    await pluginButton(theme.id, '启用');
    await wait(
      `document.querySelector('${active}').innerText.includes('释放动态主题')`,
      '真实主题贡献',
    );
    await evaluate(`document.querySelector('${active} [aria-label="选择主题"]').click()`);
    await wait('!!document.querySelector("[role=listbox]")');
    await evaluate(
      '[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.trim()==="在线主题").click()',
    );
    await wait(
      'document.querySelector("#app").style.getPropertyValue("--df-theme-smoke-color")==="rgb(71, 81, 91)"',
    );
    await capture('state-theme-selected');
    const selectedDevice = await evaluate('document.querySelector(".dock-device").innerText');
    assert.ok(selectedDevice.includes('在线'));
    await pluginButton(theme.id, '停用');
    await wait(
      'document.querySelector("#app").style.getPropertyValue("--df-theme-smoke-color")===""',
      '默认主题恢复',
    );
    assert.equal(await evaluate('document.querySelector("#app").style.colorScheme'), '');
    assert.ok(
      (await evaluate('document.querySelector(".dock-device").innerText')).includes('在线'),
    );
    await capture('state-theme-restored');
    return {
      currentDevicePreserved: true,
      themeVariablesRestored: true,
      colorSchemeRestored: true,
    };
  });
  await check('设备提供者停用后选择与目录收敛', async () => {
    await route('plugins');
    await click('服务器插件');
    await pluginButton(device.id, '停用');
    await route('devices');
    await wait(
      'document.querySelector(".dock-device").innerText.includes("尚未选择设备")',
      '选择撤销',
    );
    assert.equal(
      (await api('/api/v2/device-providers')).some((item) => item.id === device.id),
      false,
    );
    await capture('state-provider-removed');
    return { providerAbsent: true, selectionCleared: true };
  });
  await check('断连真实错误与手动恢复', async () => {
    await viewport(1366, 768);
    await page.call('Network.enable');
    await page.call('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await evaluate('document.querySelector("[aria-label=重新连接服务器]").click()');
    await wait(
      'document.querySelector(".connection-state").innerText.includes("失败")',
      '断连反馈',
    );
    await capture('state-server-disconnected');
    await page.call('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await evaluate('document.querySelector("[aria-label=重新连接服务器]").click()');
    await wait(
      'document.querySelector(".connection-state").innerText.includes("已连接")',
      '恢复服务目录',
    );
    return { disconnectedVisible: true, reconnected: true };
  });
  report.passed = report.cases.every((item) => item.passed) && report.pages.length === 28;
  report.visualReview = '截图待视觉子代理亲自查看；自动通过不代表图审通过';
} catch (error) {
  report.error = error.message;
  report.passed = false;
  process.exitCode = 1;
} finally {
  page?.close();
  if (browser) {
    try {
      await browser.call('Browser.close', {}, 5000);
    } catch (error) {
      report.browserCloseError = error.message;
    }
    browser.close();
  }
  if (browserObserved) {
    try {
      await browserObserved.wait(5000);
    } catch {
      await browserObserved.force().catch((error) => {
        report.browserCleanupError = error.message;
      });
    }
  }
  if (vite) {
    vite.httpServer?.closeAllConnections();
    await vite.close().catch((error) => {
      report.proxyCleanupError = error.message;
    });
  }
  if (host && host.exitCode === null && host.signalCode === null) {
    try {
      await api('/api/v2/system/shutdown', { method: 'POST' });
      await hostObserved.wait(10000);
    } catch {
      await hostObserved.force().catch((error) => {
        report.hostCleanupError = error.message;
      });
    }
  }
  report.completedAt = new Date().toISOString();
  report.cleanup = {
    browserClosed: !!report.processes.browser?.close,
    hostClosed: !!report.processes.host?.close,
    browserNormal: report.processes.browser?.close?.code === 0 && !report.processes.browser?.forced,
    hostNormal: report.processes.host?.close?.code === 0 && !report.processes.host?.forced,
  };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(
    JSON.stringify({
      out,
      passed: report.passed,
      cases: report.cases.map((item) => ({
        name: item.name,
        passed: item.passed,
        error: item.error,
      })),
      error: report.error,
      cleanup: report.cleanup,
    }),
  );
}
