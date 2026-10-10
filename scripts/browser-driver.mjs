import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function executable() {
  const candidates = [
    process.env.DEVICEFORGE_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('未找到测试浏览器，请配置 DEVICEFORGE_TEST_BROWSER');
}

function endpoint(child) {
  return new Promise((resolve, reject) => {
    let diagnostic = '';
    const timer = setTimeout(() => finish(new Error('浏览器调试端口未在 15 秒内就绪')), 15000);
    const onData = (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-65536);
      const found = diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (found) finish(null, found[1]);
    };
    const onExit = () => finish(new Error('浏览器在调试端口就绪前退出'));
    const onError = () => finish(new Error('测试浏览器启动失败'));
    function finish(error, value) {
      clearTimeout(timer);
      child.stderr.off('data', onData); child.off('exit', onExit); child.off('error', onError);
      if (error) reject(error); else resolve(value);
    }
    child.stderr.on('data', onData); child.once('exit', onExit); child.once('error', onError);
  });
}

async function protocol(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('浏览器调试连接失败')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    let reply;
    try { reply = JSON.parse(String(event.data)); } catch { return; }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    if (reply.error) entry.reject(new Error(`浏览器调试命令失败（${reply.error.code}）`));
    else entry.resolve(reply.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer); entry.reject(new Error('浏览器调试连接已关闭'));
    }
    pending.clear();
  });
  return {
    call(method, params = {}, timeout = 30000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('浏览器调试命令超时')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

// 使用独立临时配置目录与隐藏进程，不连接或操作用户当前浏览器会话。
export async function runBrowser(pageUrl, expression, profileDirectory, observeRuntime) {
  const binary = await executable();
  const child = spawn(binary, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let browser; let page;
  try {
    const browserUrl = await endpoint(child);
    browser = await protocol(browserUrl);
    const version = await browser.call('Browser.getVersion');
    observeRuntime?.({ executable_path: binary, version: version.product, revision: version.revision,
      protocol_version: version.protocolVersion, status: '已记录' });
    const origin = new URL(browserUrl); origin.protocol = 'http:'; origin.pathname = '/json/new';
    origin.search = `?${encodeURIComponent(pageUrl)}`;
    const target = await fetch(origin, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    if (!target.ok) throw new Error('浏览器测试页面创建失败');
    const info = await target.json();
    page = await protocol(info.webSocketDebuggerUrl);
    await page.call('Runtime.enable');
    // 新标签的导航可能销毁初始执行上下文，稳定后再运行长验收 Promise。
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        const ready = await page.call('Runtime.evaluate', { expression: `location.href === ${JSON.stringify(pageUrl)} && document.readyState !== 'loading'`, returnByValue: true });
        if (ready.result.value === true) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error('浏览器验收页面导航未就绪');
      await delay(50);
    }
    const evaluation = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 60000);
    if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description || '浏览器运行验收失败');
    return evaluation.result.value;
  } finally {
    page?.close();
    if (browser) {
      try { await browser.call('Browser.close', {}, 5000); } catch {}
      browser.close();
    }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
