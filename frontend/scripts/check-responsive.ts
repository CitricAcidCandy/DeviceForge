import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * 响应式验证（硬性规则的运行时部分）：
 * 每个路由在 1024×640 / 1366×720 / 1920×1080 三档视口下，横向不得溢出。
 * 需要 dev server（默认 127.0.0.1:5173）与 Chrome 调试端口（默认 9333）；
 * 环境不满足时跳过并提示——CI 机器请用 npm run preview + chrome 起一个实例。
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const DEV_URL = process.env.DEV_URL ?? 'http://127.0.0.1:5173';
const CDP_URL = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const VIEWPORTS = [
  [1024, 640],
  [1366, 720],
  [1920, 1080],
] as const;

const routesSource = await readFile(join2(root, 'src/app/product/routes.ts'), 'utf8');
const routes = [...routesSource.matchAll(/id: '([\w-]+)'/g)].map((match) => match[1]);

function join2(base: string, path: string): string {
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

async function probe(url: string, timeout = 1500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

const devUp = await probe(DEV_URL);
const chromeUp = await probe(join2(CDP_URL, 'json/version'));
if (!devUp || !chromeUp) {
  console.log(
    `响应式检查跳过：${!devUp ? `dev server ${DEV_URL} 未启动` : ''}${!devUp && !chromeUp ? '；' : ''}${!chromeUp ? `Chrome 调试端口 ${CDP_URL} 未启动` : ''}。启动后重跑 npm run check:responsive。`,
  );
  process.exit(0);
}

const targets = await (await fetch(join2(CDP_URL, 'json/list'))).json();
const page = targets.find((target: { type: string; url: string }) => target.type === 'page' && target.url.includes('5173'))
  ?? targets.find((target: { type: string }) => target.type === 'page');
if (!page) {
  console.error('响应式检查失败：Chrome 里没有可用页面');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map<number, (result: unknown) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data as string);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  }
};
await new Promise((resolve) => (ws.onopen = resolve));

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression: string): Promise<unknown> {
  const result = (await send('Runtime.evaluate', { expression, returnByValue: true })) as {
    result?: { value?: unknown };
  };
  return result.result?.value;
}

const failures: string[] = [];
await send('Page.enable');
for (const [width, height] of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  for (const route of routes) {
    await send('Page.navigate', { url: join2(DEV_URL, `?v=${width}x${height}#${route}`) });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const report = (await evaluate(
      `(() => {
        const root = document.documentElement;
        const overflowing = [...document.querySelectorAll('body *')]
          .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1)
          .slice(0, 3)
          .map((el) => el.tagName + '.' + String(el.className).split(' ').slice(0, 2).join('.'));
        return JSON.stringify({ sw: root.scrollWidth, cw: root.clientWidth, overflowing });
      })()`,
    )) as string;
    const parsed = JSON.parse(report) as {
      sw: number;
      cw: number;
      overflowing: string[];
    };
    if (parsed.sw > parsed.cw) {
      failures.push(
        `${width}x${height} #${route}：横向溢出 ${parsed.sw - parsed.cw}px` +
          (parsed.overflowing.length ? `（${parsed.overflowing.join('、')}）` : ''),
      );
    }
  }
}
ws.close();

if (failures.length) {
  console.error(`响应式检查未通过（${failures.length} 处）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`响应式检查通过：${routes.length} 个路由 × ${VIEWPORTS.length} 档视口，无横向溢出`);
