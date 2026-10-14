import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
interface Protocol {
  call(method: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown>;
  close(): void;
}
async function protocol(url: string): Promise<Protocol> {
  const socket = new WebSocket(url);
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('媒体浏览器 CDP 连接超时'));
    }, 10000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('媒体浏览器 CDP 连接失败'));
      },
      { once: true },
    );
  });
  socket.addEventListener('message', (event) => {
    let reply: unknown;
    try {
      reply = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!record(reply) || typeof reply['id'] !== 'number') return;
    const entry = pending.get(reply['id']);
    if (!entry) return;
    pending.delete(reply['id']);
    clearTimeout(entry.timer);
    if (reply['error']) entry.reject(new Error('媒体浏览器 CDP 命令失败'));
    else entry.resolve(reply['result']);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('媒体浏览器 CDP 连接已关闭'));
    }
    pending.clear();
  });
  return {
    call(method, params = {}, timeout = 30000) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`媒体浏览器 CDP 超时：${method}`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}
function endpoint(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let diagnostic = '';
    const timer = setTimeout(() => finish(new Error('媒体浏览器调试端口未就绪')), 15000);
    const data = (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-65536);
      const found = diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/);
      if (found?.[1]) finish(null, found[1]);
    };
    const exit = () => finish(new Error('媒体浏览器在端口就绪前退出'));
    const failure = () => finish(new Error('媒体浏览器启动失败'));
    function finish(error: Error | null, value = '') {
      clearTimeout(timer);
      child.stderr?.off('data', data);
      child.off('exit', exit);
      child.off('error', failure);
      if (error) reject(error);
      else resolve(value);
    }
    child.stderr?.on('data', data);
    child.once('exit', exit);
    child.once('error', failure);
  });
}
async function binary(): Promise<string> {
  const candidates = [
    process.env.DEVICEFORGE_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ];
  for (const candidate of candidates) {
    if (candidate) {
      try {
        await access(candidate);
        return candidate;
      } catch {}
    }
  }
  throw new Error('未找到原生媒体验收浏览器');
}

// 只启动本次独立隐藏浏览器；CDP 的 userGesture 用于本次用户播放动作，不改变产品自动播放规则。
export async function runMediaBrowser(
  pageUrl: string,
  temporary: string,
  evidence: Record<string, unknown>,
  inProcessGpu: boolean,
): Promise<unknown> {
  const executable = await binary();
  const flags = [
    '--headless=new',
    '--disable-gpu',
    ...(inProcessGpu ? ['--in-process-gpu'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${join(temporary, 'browser-profile')}`,
    'about:blank',
  ];
  const child = spawn(executable, flags, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  evidence['pid'] = child.pid;
  evidence['executable'] = executable;
  evidence['flags'] = flags;
  evidence['forced'] = false;
  let diagnostic = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-16384);
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let browser: Protocol | null = null;
  let page: Protocol | null = null;
  let listener: string | null = null;
  let failure = false;
  try {
    evidence['stage'] = '连接本次原生浏览器';
    listener = await endpoint(child);
    browser = await protocol(listener);
    evidence['version'] = await browser.call('Browser.getVersion');
    const url = new URL(listener);
    url.protocol = 'http:';
    url.pathname = '/json/new';
    url.search = '?' + encodeURIComponent(pageUrl);
    const response = await fetch(url, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, '媒体浏览器测试页面未创建');
    const target: unknown = await response.json();
    assert.ok(record(target) && typeof target['webSocketDebuggerUrl'] === 'string');
    page = await protocol(target['webSocketDebuggerUrl']);
    await page.call('Runtime.enable');
    evidence['stage'] = '等待测试页面导航';
    const deadline = Date.now() + 10000;
    while (true) {
      const ready = await page.call('Runtime.evaluate', {
        expression: `location.href === ${JSON.stringify(pageUrl)} && document.readyState !== 'loading'`,
        returnByValue: true,
      });
      if (record(ready) && record(ready['result']) && ready['result']['value'] === true) break;
      if (Date.now() >= deadline) throw new Error('原生媒体验收页面导航超时');
      await delay(50);
    }
    evidence['stage'] = '执行真实产品媒体行为';
    evidence['activation'] = 'CDP userGesture=true 仅用于本次播放按钮；未修改生产自动播放规则';
    const evaluated = await page.call(
      'Runtime.evaluate',
      {
        expression:
          '(async()=>{const harness=await import("/assets/browser-media-harness.js");return await harness.verifyMediaPage();})()',
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      60000,
    );
    assert.ok(record(evaluated));
    if (evaluated['exceptionDetails']) {
      const details = evaluated['exceptionDetails'];
      const exception = record(details) ? details['exception'] : null;
      throw new Error(
        record(exception) && typeof exception['description'] === 'string'
          ? exception['description']
          : '原生媒体浏览器脚本异常',
      );
    }
    assert.ok(record(evaluated['result']));
    return evaluated['result']['value'];
  } catch (error) {
    failure = true;
    evidence['failure_stage'] = evidence['stage'];
    throw error;
  } finally {
    page?.close();
    if (browser) {
      try {
        await browser.call('Browser.close', {}, 5000);
      } catch {}
      browser.close();
    }
    if (child.exitCode === null && child.signalCode === null)
      await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      evidence['forced'] = true;
      child.kill();
      await Promise.race([closed, delay(2000)]);
    }
    evidence['exit'] = { code: child.exitCode, signal: child.signalCode };
    evidence['normal_exit'] =
      child.exitCode === 0 && child.signalCode === null && evidence['forced'] === false;
    evidence['diagnostic'] = diagnostic;
    if (listener) {
      const url = new URL(listener);
      url.protocol = 'http:';
      url.pathname = '/json/version';
      try {
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        evidence['listener_released'] = false;
      } catch {
        evidence['listener_released'] = true;
      }
    }
    if (!failure) {
      assert.equal(evidence['normal_exit'], true, '媒体验收浏览器未正常退出');
      assert.equal(evidence['listener_released'], true, '媒体验收浏览器端口未释放');
    }
  }
}
