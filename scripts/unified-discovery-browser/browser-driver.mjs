import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { bounded, digest, observeChild, normalExit } from './lifecycle.mjs';

async function executable() {
  for (const path of [
    process.env.DEVICEFORGE_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean)) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error('未找到测试浏览器，请设置 DEVICEFORGE_TEST_BROWSER');
}

async function endpoint(child, evidence) {
  let done;
  let failed;
  const pending = new Promise((resolve, reject) => {
    done = resolve;
    failed = reject;
  });
  const onData = () => {
    const found = evidence.diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
    if (found) done(found[1]);
  };
  const onClose = () => failed(new Error('浏览器在调试端口就绪前退出'));
  const onError = () => failed(new Error('浏览器启动失败'));
  child.stderr.on('data', onData);
  child.once('close', onClose);
  child.once('error', onError);
  try {
    return await bounded(pending, 15000, '浏览器调试端口未就绪');
  } finally {
    child.stderr.off('data', onData);
    child.off('close', onClose);
    child.off('error', onError);
  }
}

async function protocol(url, observeEvent) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  const failAll = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('浏览器调试连接已关闭'));
    }
    pending.clear();
  };
  socket.addEventListener('close', failAll);
  socket.addEventListener('error', failAll);
  socket.addEventListener('message', (event) => {
    let reply;
    try {
      reply = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (reply.method) {
      observeEvent?.(reply);
      return;
    }
    const entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.error) entry.reject(new Error(`浏览器调试命令失败 ${reply.error.code}`));
    else entry.resolve(reply.result);
  });
  let onOpen;
  let onError;
  let onClose;
  try {
    await bounded(
      new Promise((resolve, reject) => {
        onOpen = resolve;
        onError = () => reject(new Error('浏览器调试连接失败'));
        onClose = onError;
        socket.addEventListener('open', onOpen);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
      }),
      10000,
      '浏览器调试连接超时',
    );
  } catch (error) {
    socket.close();
    throw error;
  } finally {
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('error', onError);
    socket.removeEventListener('close', onClose);
  }
  return {
    call(method, params = {}, timeout = 10000) {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('浏览器调试连接不可用'));
          return;
        }
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`浏览器调试命令超时 ${method}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    close() {
      failAll();
      socket.close();
    },
  };
}

// 本轮独立驱动记录实际版本与 OS exit/close；仅终止自己创建的浏览器进程。
export async function runBrowser({
  pageUrl,
  expression,
  profileDirectory,
  evidence,
  observeResult,
}) {
  const binary = await executable();
  evidence.executable_path = binary;
  evidence.binary = await digest(binary);
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDirectory}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const observer = observeChild(child, evidence);
  let browser;
  let page;
  try {
    const browserUrl = await endpoint(child, evidence);
    browser = await protocol(browserUrl);
    const version = await browser.call('Browser.getVersion');
    evidence.version = {
      product: version.product,
      revision: version.revision,
      protocol: version.protocolVersion,
    };
    const url = new URL(browserUrl);
    url.protocol = 'http:';
    url.pathname = '/json/new';
    url.search = `?${encodeURIComponent(pageUrl)}`;
    const response = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('真实浏览器验收页创建失败');
    const target = await response.json();
    evidence.uncaught = [];
    page = await protocol(target.webSocketDebuggerUrl, (event) => {
      if (event.method === 'Runtime.exceptionThrown' && evidence.uncaught.length < 16) {
        const details = event.params.exceptionDetails;
        evidence.uncaught.push(
          String(details.exception?.description ?? details.text).slice(0, 500),
        );
      }
    });
    await page.call('Runtime.enable');
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        const ready = await page.call('Runtime.evaluate', {
          expression: `location.href === ${JSON.stringify(pageUrl)} && document.readyState !== 'loading'`,
          returnByValue: true,
        });
        if (ready.result.value === true) break;
      } catch {}
      if (Date.now() >= deadline) throw new Error('真实浏览器导航未就绪');
      await delay(50);
    }
    const result = await page.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      90000,
    );
    if (result.exceptionDetails) {
      evidence.evaluation_error = String(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      ).slice(0, 1500);
      throw new Error('真实浏览器执行抛出异常，详见报告');
    }
    observeResult?.(result.result.value);
    if (evidence.uncaught.length) throw new Error('浏览器存在未捕获异常，详见报告');
    return result.result.value;
  } finally {
    page?.close();
    if (browser) {
      try {
        await browser.call('Browser.close', {}, 3000);
      } catch {}
      browser.close();
    }
    try {
      await observer.wait(5000);
    } catch {
      await observer.force();
    }
    evidence.normal_exit = normalExit(evidence);
    if (!evidence.normal_exit) throw new Error('浏览器未正常退出，详见 OS 退出证据');
  }
}
