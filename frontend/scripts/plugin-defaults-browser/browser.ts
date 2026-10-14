import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

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
  assert.ok(object(value), '浏览器协议对象格式错误');
  return value;
}
const protocolModule = (value: unknown): value is ProtocolModule =>
  object(value) && typeof value['themeProtocol'] === 'function';

export async function listenerReleased(port: number) {
  const probe = createServer();
  try {
    await new Promise<void>((done, fail) => {
      probe.once('error', fail);
      probe.listen(port, '127.0.0.1', done);
    });
    return true;
  } catch { return false; }
  finally {
    if (probe.listening) await new Promise<void>((done) => probe.close(() => done()));
  }
}

// 仅管理本次隐藏浏览器，不操作现有 Vite、Rust 或浏览器进程。
export async function createDefaultsBrowser(project: string, profile: string, evidence: RecordValue) {
  const executable = process.env['DEVICEFORGE_TEST_BROWSER'] ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await access(executable);
  let child: ChildProcess | null = null;
  let browser: Protocol | null = null;
  let page: Protocol | null = null;
  let diagnostic = '';
  let port = 0;
  const close = async () => {
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
    if (port) evidence['listener'] = { port, released: await listenerReleased(port) };
  };
  try {
    child = spawn(executable, [
      '--headless=new', '--disable-gpu', '--in-process-gpu', '--no-first-run',
      '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    evidence['pid'] = child.pid;
    child.stderr?.on('data', (value: Buffer) => { diagnostic = (diagnostic + value.toString()).slice(-16000); });
    const deadline = Date.now() + 15000;
    let endpoint = '';
    while (!endpoint && Date.now() < deadline) {
      endpoint = diagnostic.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1] ?? '';
      assert.equal(child.exitCode, null, '独立浏览器提前退出');
      await delay(50);
    }
    assert.ok(endpoint, '独立浏览器调试端口未就绪');
    port = Number(new URL(endpoint).port);
    const module: unknown = await import(pathToFileURL(join(project, 'scripts/browser-theme-smoke/cdp.mjs')).href);
    assert.ok(protocolModule(module));
    browser = await module.themeProtocol(endpoint, evidence);
    evidence['runtime'] = await browser.call('Browser.getVersion');
    const origin = new URL(endpoint);
    origin.protocol = 'http:';
    origin.pathname = '/json/new';
    origin.search = '?about:blank';
    const response = await fetch(origin, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok);
    const target = record(await response.json());
    assert.equal(typeof target['webSocketDebuggerUrl'], 'string');
    page = await module.themeProtocol(String(target['webSocketDebuggerUrl']), evidence);
    await page.call('Runtime.enable');
    await page.call('Page.enable');
    const currentPage = page;
    async function evaluate(expression: string): Promise<unknown> {
      const reply = record(await currentPage.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 60000));
      if (reply['exceptionDetails']) throw new Error(JSON.stringify(reply['exceptionDetails']));
      return record(reply['result'])['value'];
    }
    async function wait(expression: string, name: string) {
      const until = Date.now() + 15000;
      while (Date.now() < until) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error(name + '未就绪');
    }
    return {
      evaluate, wait, close,
      async navigate(url: string) {
        await currentPage.call('Page.navigate', { url });
        await wait(`location.href===${JSON.stringify(url)}&&document.readyState!=='loading'`, '导航');
      },
      async capture(path: string, width: number, height: number) {
        await currentPage.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await evaluate('document.fonts.ready');
        await delay(300);
        const reply = record(await currentPage.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }));
        assert.equal(typeof reply['data'], 'string');
        await writeFile(path, Buffer.from(String(reply['data']), 'base64'));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
