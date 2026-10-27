import { createRoot } from 'react-dom/client';
import { createNamedSlotAdapter } from '/__production_host__';
import type { RuntimeOptions } from '/__production_host__';
import { App } from '../src/app/product/App.tsx';
import { createProductServices } from '../src/app/product/services.ts';
import { pluginRoute, routeHash } from '../src/app/product/routes.ts';
import { pageSlotId } from '../src/plugin-sdk/index.ts';
import type { SlotAdapter, SlotHost } from '../src/plugin-sdk/index.ts';

const consumerId = 'example.service-consumer';
const providerId = 'example.service-provider';
type RunCheck = (name: string, action: () => Promise<void>) => Promise<void>;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function until(read: () => boolean, message: string) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (read()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
async function createRouteHost(options: RuntimeOptions) {
  const directory = gate();
  const mounting = gate();
  const failure = gate();
  const entered = { directory: false, mounting: false, failure: false };
  const target = document.createElement('section');
  const slots = await createNamedSlotAdapter([]);
  const transport = options.transport ?? fetch.bind(globalThis);
  // 只延迟真实响应和公开槽位生命周期，不伪造安装目录、插件贡献或产品状态。
  const slotAdapter = {
    ...slots,
    acquire: async (request, signal) => {
      if (request.componentId === `${consumerId}.page`) {
        entered.mounting = true;
        await mounting.promise;
      }
      return slots.acquire(request, signal);
    },
    define: async (definition) => {
      if (definition.id === pageSlotId(consumerId, '/service-independent')) {
        entered.failure = true;
        await failure.promise;
        throw new Error('验收注入的页面槽位定义失败');
      }
      return slots.define(definition);
    },
  } satisfies SlotAdapter & SlotHost;
  const services = createProductServices({
    ...options,
    slotAdapter,
    transport: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.pathname === '/api/v2/plugin-packages/browser') {
        entered.directory = true;
        await directory.promise;
      }
      return transport(input, init);
    },
  });
  document.body.append(target);
  return { services, slots, target, root: createRoot(target), directory, mounting, failure, entered };
}
type RouteHost = Awaited<ReturnType<typeof createRouteHost>>;
function page(host: RouteHost, route: string): HTMLElement | null {
  return host.target.querySelector<HTMLElement>(`[data-plugin-page="${pluginRoute(consumerId, route)}"]`);
}
async function verifyArrival(host: RouteHost, startup: Promise<unknown>, runCheck: RunCheck) {
  const hash = location.hash;
  await runCheck('产品启动目录未就绪保留直达hash', async () => {
    await until(() => host.entered.directory && host.target.querySelector('[data-navigation-route="devices"]') !== null, '产品启动未进入真实目录等待');
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    check(host.services.pluginDefaults.snapshot().phase === 'running', '启动目录等待未覆盖默认启用进行态');
    check(location.hash === hash && !page(host, '/catalog'), '目录未就绪时产品丢失直达地址或提前生成页面');
    check(!host.target.querySelector('[data-route="devices"]'), '目录未就绪时错误回到设备页');
  });
  await runCheck('产品模块就绪后直达页面与服务调用可用', async () => {
    host.directory.release();
    await startup;
    const results = host.services.pluginDefaults.snapshot().results;
    check(results.every((entry) => entry.status !== 'failed') && [consumerId, providerId].every((id) => results.some((entry) => entry.kind === 'browser' && entry.id === id)), '两个真实安装包没有全部默认启用');
    await until(() => host.entered.mounting && page(host, '/catalog')?.hidden === false, '迟到模块未进入产品路由');
    check(page(host, '/catalog')?.textContent?.includes('插件页面正在装载'), '接管尚未完成就移除了默认内容');
    host.mounting.release();
    await until(() => !!page(host, '/catalog')?.querySelector('[data-deviceforge-slot] button') && !page(host, '/catalog')?.textContent?.includes('插件页面正在装载'), '产品路由没有完成真实模板接管');
    const button = page(host, '/catalog')?.querySelector('[data-deviceforge-slot] button');
    check(button instanceof HTMLButtonElement, '产品页面缺少真实服务按钮');
    button.click();
    await until(() => page(host, '/catalog')?.querySelector('output')?.textContent === '组合服务已就绪', '产品路由公开服务调用失败');
    check(location.hash === hash && !page(host, '/catalog')?.textContent?.includes('插件页面正在装载'), '成功接管后地址或默认内容无效');
  });
}
async function verifyFallback(host: RouteHost, runCheck: RunCheck) {
  await runCheck('产品接管等待与失败保留默认内容', async () => {
    location.hash = routeHash(pluginRoute(consumerId, '/service-independent'));
    await until(() => host.entered.failure && page(host, '/service-independent')?.hidden === false, '产品未进入槽位定义等待');
    check(page(host, '/service-independent')?.textContent?.includes('插件页面正在装载'), '接管等待时默认内容消失');
    host.failure.release();
    await until(() => !!page(host, '/service-independent')?.textContent?.includes('验收注入的页面槽位定义失败'), '产品未显示实际接管失败');
    check(page(host, '/service-independent')?.textContent?.includes('插件页面正在装载'), '接管失败后没有保留默认内容');
  });
}

export async function verifyServiceProductRoutes(options: RuntimeOptions, signal: AbortSignal, runCheck: RunCheck) {
  const previousHash = location.hash;
  const host = await createRouteHost(options);
  const current = host.services.runtime;
  location.hash = routeHash(pluginRoute(consumerId, '/catalog'));
  host.root.render(<App services={host.services} />);
  const startup = host.services.pluginDefaults.start(signal);
  void startup.catch(() => undefined);
  try {
    await verifyArrival(host, startup, runCheck);
    await verifyFallback(host, runCheck);
    await runCheck('产品卸载当前插件页回到devices', async () => {
      location.hash = routeHash(pluginRoute(consumerId, '/catalog'));
      await until(() => page(host, '/catalog')?.hidden === false, '卸载前产品没有回到已成功挂载页面');
      await current.pluginPackages.remove('browser', consumerId, signal);
      await until(() => location.hash === '#devices' && host.target.querySelector<HTMLElement>('[data-route="devices"]')?.hidden === false, '卸载当前模块后产品没有回到设备页');
      check(!host.target.querySelector('[data-plugin-page]') && ['/catalog', '/service-independent'].every((route) => !host.target.querySelector(`[data-navigation-route="${pluginRoute(consumerId, route)}"]`)), '卸载后仍有页面或导航入口');
    });
    await runCheck('删除安装包撤销全部本轮贡献与挂载', async () => {
      await current.pluginPackages.remove('browser', providerId, signal);
      // 生产服务还拥有宿主内置贡献，只核对本轮两个已删除插件的所有权。
      const remaining = Object.values(current.extensions.catalog()).flat()
        .filter((entry) => entry.pluginId === consumerId || entry.pluginId === providerId);
      check(remaining.length === 0, '卸载后仍有本轮插件贡献');
      check(current.webPlugins.snapshot().length === 0 && !host.target.querySelector('[data-deviceforge-slot-owner]'), '卸载后仍有运行插件或挂载');
      check((await current.pluginPackages.refresh('browser', signal)).data.length === 0, '真实安装目录不为空');
    });
  } finally {
    host.directory.release(); host.mounting.release(); host.failure.release();
    host.root.unmount();
    try { await host.services.dispose(); }
    finally {
      try { await host.slots.dispose(); }
      finally { host.target.remove(); location.hash = previousHash; }
    }
  }
}
