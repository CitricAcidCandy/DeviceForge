import { startFrontendApp } from '../../src/app/main.ts';
import { createProductServices } from '../../src/app/product/services.ts';
import { pluginIds } from './fixture.ts';

const pause = (duration = 70) => new Promise<void>((done) => setTimeout(done, duration));
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
async function wait(read: () => boolean, name: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (read()) return;
    await pause(25);
  }
  throw new Error(name + '未就绪');
}
const count = (key: string) => Number(document.documentElement.dataset[key] ?? '0');
const row = (id: string, kind: string) => document.querySelector(
  `[data-default-plugin-id="${id}"][data-default-plugin-kind="${kind}"]`,
);
async function button(text: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll('button')].find(
    (item) => item.getClientRects().length > 0 && item.textContent?.trim() === text,
  );
  check(target instanceof HTMLButtonElement && !target.disabled, '按钮不可用：' + text);
  target.click();
  await pause();
}
async function kind(value: string) {
  const target = [...document.querySelectorAll('[role="tab"]')].find(
    (item) => item.textContent?.trim() === value,
  );
  check(target instanceof HTMLElement, '安装包种类页签缺失');
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  target.click();
  await pause();
}
async function stop(id: string) {
  const target = [...document.querySelectorAll('.plugin-row')].find(
    (item) => item.querySelector('h3')?.textContent?.startsWith(id),
  );
  check(target instanceof HTMLElement, '已安装包行缺失：' + id);
  await button('停用', target);
}
async function evidence(): Promise<Record<string, unknown>> {
  const response = await fetch('/__defaults_evidence__');
  const value: unknown = await response.json();
  check(object(value), '受控服务证据格式错误');
  return value;
}
function mutationCount(value: Record<string, unknown>, id: string, action: string) {
  const requests = value['requests'];
  check(Array.isArray(requests), '请求记录缺失');
  return requests.filter((item: unknown) => object(item) &&
    item['method'] === 'POST' && item['path'] === `/api/v2/plugins/${id}/${action}`).length;
}
let application: Awaited<ReturnType<typeof startFrontendApp>> | null = null;
let factoryRequests = -1;

export async function mount() {
  // 静态导入 main 时页面尚无 app 节点，随后只显式装配一次真实入口。
  let calls = 0;
  const standalone = createProductServices({
    baseUrl: location.origin,
    transport: (resource, options) => { calls++; return fetch(resource, options); },
    panelTarget: () => document.createElement('div'),
  });
  await pause();
  factoryRequests = calls;
  await standalone.dispose();
  const target = document.createElement('div');
  target.id = 'app';
  document.body.append(target);
  application = await startFrontendApp(document, window);
}

export async function verify() {
  const cases: { name: string; passed: boolean }[] = [];
  const accept = (name: string) => cases.push({ name, passed: true });
  try {
    check(application?.runtime, '真实启动实例缺失');
    const runtime = application.runtime;
    check(factoryRequests === 0, '工厂构造发送网络请求');
    accept('产品服务工厂构造零网络请求');
    await wait(() => document.querySelector('[data-plugin-defaults]')?.getAttribute('data-plugin-defaults') === 'completed', '默认启用终态');
    accept('真实 main 显式启动并在插件页显示完成状态');
    const initial = await evidence();
    check(mutationCount(initial, pluginIds.running, 'load') === 0, '已运行服务器插件重复 load');
    check(row(pluginIds.running, 'server')?.getAttribute('data-default-plugin-status') === 'already_enabled', '已运行服务器结果缺失');
    accept('已运行服务器插件保持原代次且零重复加载');
    check(mutationCount(initial, pluginIds.idle, 'load') === 1, '未运行服务器插件未默认加载或重复加载');
    check(row(pluginIds.idle, 'server')?.getAttribute('data-default-plugin-status') === 'enabled', '服务器默认加载结果缺失');
    accept('已安装未运行服务器插件默认加载一次');
    check(count('defaultFailureImported') === 1 && count('defaultSuccessImported') === 1, '原生 ESM 模块未执行');
    const assets = initial['assets'];
    check(Array.isArray(assets) && assets.some((item: unknown) => object(item) && item['id'] === pluginIds.failure) &&
      assets.some((item: unknown) => object(item) && item['id'] === pluginIds.success), '运行代次 HTTP 资源请求缺失');
    accept('实际 HTTP 代次资源与浏览器原生 ESM 导入');
    check(row(pluginIds.failure, 'browser')?.getAttribute('data-default-plugin-status') === 'failed', '失败包结果未隔离');
    check(row(pluginIds.failure, 'browser')?.textContent?.includes('受控 SDK v2 插件启动失败'), '实际错误未显示');
    check(row(pluginIds.success, 'browser')?.getAttribute('data-default-plugin-status') === 'enabled', '后续成功包未加载');
    check(runtime.webPlugins.snapshot().find((item) => item.id === pluginIds.success)?.state === 'loaded', '成功插件未在运行');
    check(runtime.extensions.catalog().commands.some((item) => item.id === pluginIds.success + '.ping'), '真实插件贡献缺失');
    check(count('defaultFailureReleased') === 1, '失败激活登记资源未回收');
    accept('SDK v2 单包失败隔离、后续包启用及失败资源回收');
    await kind('浏览器插件');
    await stop(pluginIds.success);
    await wait(() => !runtime.webPlugins.snapshot().some((item) => item.id === pluginIds.success), '浏览器手动停用');
    check(count('defaultSuccessReleased') === 1 && count('defaultSuccessDeactivated') === 1, '手动停用未释放资源');
    accept('插件页手动停用浏览器插件及贡献回收');
    await kind('服务器插件');
    await stop(pluginIds.idle);
    await wait(() => runtime.serverPlugins.snapshot().result?.data.find((item) => item.id === pluginIds.idle)?.state === 'unloaded', '服务器手动停用');
    accept('插件页手动停用服务器插件');
    location.hash = 'devices';
    await wait(() => document.querySelector('[data-route="devices"]') !== null, '设备路由');
    location.hash = 'plugins';
    await wait(() => document.querySelector('[data-plugin-defaults]') !== null, '插件路由恢复');
    await pause(600);
    check(count('defaultSuccessActivated') === 1, '路由重进恢复了手动停用浏览器插件');
    check(mutationCount(await evidence(), pluginIds.idle, 'load') === 1, '路由重进恢复了手动停用服务器插件');
    accept('等待与路由重新进入保持本实例手动停用');
    await button('重试失败项');
    await wait(() => count('defaultFailureActivated') === 2 &&
      document.querySelector('[data-plugin-defaults]')?.getAttribute('data-plugin-defaults') === 'completed', '限定失败重试');
    check(count('defaultSuccessActivated') === 1, '失败重试恢复了手动停用浏览器插件');
    check(mutationCount(await evidence(), pluginIds.idle, 'load') === 1, '失败重试恢复了手动停用服务器插件');
    accept('仅重试失败包，不恢复用户停用的成功包');
    await button('重新执行默认启用');
    await wait(() => count('defaultSuccessActivated') === 2 &&
      document.querySelector('[data-plugin-defaults]')?.getAttribute('data-plugin-defaults') === 'completed', '显式重新执行');
    check(count('defaultSuccessImported') === 2, '新轮仍使用旧 ESM 执行结果');
    check(mutationCount(await evidence(), pluginIds.running, 'load') === 0, '显式新轮重复加载原运行服务器插件');
    check(mutationCount(await evidence(), pluginIds.idle, 'load') === 2, '显式新轮未加载停用服务器插件');
    accept('用户显式新轮恢复停用包并使用新原生 ESM 代次');
    return { passed: true, cases, factoryRequests, counters: { ...document.documentElement.dataset } };
  } catch (error) {
    return { passed: false, cases, error: error instanceof Error ? error.message : String(error), text: document.body.innerText };
  }
}

export async function dispose() {
  await application?.dispose();
  check(document.querySelector('#product-root') === null, '应用关闭后工作区未移除');
  check(count('defaultSuccessReleased') === count('defaultSuccessActivated'), '应用关闭未回收最后一代成功插件');
  return { disposed: true, counters: { ...document.documentElement.dataset } };
}
