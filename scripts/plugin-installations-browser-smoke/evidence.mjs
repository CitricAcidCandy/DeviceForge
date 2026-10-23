// 只连接本轮独占配置目录创建的浏览器，收集协议证据与真实页面截图。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { poll } from '../plugin-installations-smoke/host.mjs';

async function connect(url, observe) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  await new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true });
    socket.addEventListener('error', () => fail(new Error('证据调试连接失败')), { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(String(data));
    if (value.method) { observe(value.method, value.params); return; }
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id); clearTimeout(entry.timer);
    if (value.error) entry.fail(new Error(`证据协议失败：${value.error.code}`));
    else entry.done(value.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.fail(new Error('证据连接已关闭')); }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((done, fail) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); fail(new Error(`证据命令超时：${method}`)); }, 10000);
        pending.set(id, { done, fail, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

export function createBrowserEvidence({ profile, directory, report, origin }) {
  let protocol;
  const requests = new Map();
  report.browser_console = []; report.browser_network = []; report.screenshots = [];
  function observe(method, value) {
    if (method === 'Runtime.consoleAPICalled') report.browser_console.push({
      kind: value.type, text: value.args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 1500),
    });
    if (method === 'Runtime.exceptionThrown') report.browser_console.push({
      kind: 'exception', text: String(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text).slice(0, 1500),
    });
    if (method === 'Network.requestWillBeSent') {
      const url = new URL(value.request.url);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      const header = Object.entries(value.request.headers).find(([key]) => key.toLowerCase() === 'x-deviceforge-plugin-release')?.[1];
      const entry = { request_id: value.requestId, method: value.request.method, origin: url.origin, path: url.pathname,
        ...(header ? { plugin_release: header } : {}) };
      requests.set(value.requestId, entry); report.browser_network.push(entry);
    }
    if (method === 'Network.responseReceived') {
      const entry = requests.get(value.requestId);
      if (entry) {
        entry.status = value.response.status;
        entry.log_id = Object.entries(value.response.headers).find(([key]) => key.toLowerCase() === 'x-deviceforge-log-id')?.[1] ?? null;
      }
    }
    if (method === 'Network.loadingFailed') {
      const entry = requests.get(value.requestId);
      if (entry) { entry.failure = value.errorText; entry.cancelled = value.canceled ?? false; }
    }
  }
  async function attach() {
    if (protocol) return;
    const active = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
    const port = Number(active.split('\n')[0]);
    const target = await poll(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      return (await response.json()).find((item) => item.type === 'page' && item.url.startsWith(origin()));
    }, Boolean, '本轮产品页面调试目标');
    protocol = await connect(target.webSocketDebuggerUrl, observe);
    await protocol.call('Runtime.enable'); await protocol.call('Network.enable'); await protocol.call('Page.enable');
    await protocol.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
  return {
    attach,
    async screenshot(name) {
      if (!/^\d{2}-[a-z-]+$/.test(name)) throw new Error('截图名称无效');
      await attach();
      const image = await protocol.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const path = join(directory, `${name}.png`);
      await writeFile(path, Buffer.from(image.data, 'base64'));
      report.screenshots.push({ name, path, width: 1440, height: 1000, visual_review: '等待director_visual审核' });
      return { path };
    },
    close() { protocol?.close(); },
  };
}
