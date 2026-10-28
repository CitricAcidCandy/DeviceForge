import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { App } from '../src/app/product/App.tsx';
import { createSettingsV6Fixture } from './settings-v6-fixture.ts';
import type { SettingsV6Fixture } from './settings-v6-fixture.ts';
import '../src/app/styles.css';
import '../src/app/product/layout.css';

let root: Root | null = null;
let fixture: SettingsV6Fixture | null = null;
const checks: string[] = [];
function requireFixture(): SettingsV6Fixture {
  if (!fixture) throw new Error('设置浏览器夹具尚未挂载');
  return fixture;
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!condition() && Date.now() < deadline) await pause();
  check(condition(), message);
}
function visible(element: Element) {
  return !element.closest('[hidden]') && getComputedStyle(element).display !== 'none' && element.getClientRects().length > 0;
}
function field(selector: string) {
  const node = document.querySelector(selector);
  check(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement, '缺少字段：' + selector);
  return node;
}
async function fill(selector: string, value: string) {
  const node = field(selector);
  const type = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(type, 'value')?.set;
  check(setter, '字段没有可写值');
  setter.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  await pause();
}
async function click(name: string) {
  const node = [...document.querySelectorAll('button')].find((entry) => visible(entry) && entry.textContent?.trim() === name);
  check(node, '缺少可见操作：' + name);
  node.click();
  await pause();
}
export async function choose(name: string) {
  const nav = document.querySelector('nav[aria-label="设置分类"]');
  check(nav, '缺少设置分类目录');
  const node = [...nav.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name);
  check(node, '缺少分类：' + name);
  node.click();
  await until(() => node.getAttribute('aria-current') === 'page', '分类未切换：' + name);
  check(nav.querySelectorAll('[aria-current="page"]').length === 1, '分类当前项不唯一');
}
function accepted(name: string) { checks.push(name); }

export async function mount() {
  const target = document.createElement('div');
  target.id = 'app';
  document.body.append(target);
  fixture = await createSettingsV6Fixture(target);
  root = createRoot(target);
  root.render(createElement(App, { services: fixture.services }));
  await until(() => document.querySelector('#settings-server-url') !== null, '设置页未挂载');
  await until(() => document.querySelector('nav[aria-label="设置分类"] [aria-current="page"]')?.textContent?.trim() === '服务连接', '默认分类错误');
  accepted('真实 App 装配后默认展示服务连接');
}

export async function verifyConnections() {
  const current = requireFixture();
  await fill('#settings-server-url', 'ftp://127.0.0.1:7031');
  await click('测试并应用');
  check(current.reconnects.length === 0, '不支持的地址协议仍触发连接');
  accepted('非法服务地址在连接前拒绝');
  await fill('#settings-server-url', 'http://127.0.0.1:7031');
  current.mode('waiting');
  await click('测试并应用');
  await until(() => current.reconnects.length === 1, '受控连接未开始');
  await fill('#settings-marketplace-url', 'http://127.0.0.1:17440');
  await click('保存并刷新');
  await until(() => current.services.marketplace.currentUrl() === 'http://127.0.0.1:17440', '市场覆盖未保存');
  check(current.reconnects[0]?.signal.aborted === false, '保存市场取消了连接');
  check(current.writes.length === 0, '市场地址进入了服务器配置');
  accepted('市场覆盖仅保存在浏览器且不取消连接');
  current.complete();
  await until(() => [...document.querySelectorAll('button')].some((node) => visible(node) && node.textContent?.trim() === '测试并应用' && !node.disabled), '连接按钮未恢复');
  await click('恢复默认');
  check(current.services.marketplace.currentUrl() === current.services.marketplace.defaultUrl, '恢复市场默认失败');
  check(localStorage.getItem('deviceforge.marketplace.url') === null, '恢复默认没有删除浏览器覆盖');
  accepted('恢复默认只撤销市场覆盖');
  // 自然等待前序成功提示退出，再进入独立失败场景；不主动隐藏当前错误。
  await until(() => ![...document.querySelectorAll('.global-message[data-message-kind="success"]')].some(visible), '前序市场成功提示未自然退出');
  current.mode('network');
  await click('测试并应用');
  await until(() => document.body.textContent?.includes('未取得日志 ID') === true, '无响应错误没有呈现');
  check(document.body.textContent?.includes('无法连接服务'), '错误原因缺失');
  check(!document.body.textContent?.includes('log_demo'), '网络错误伪造日志');
  accepted('连接失败保留草稿并明确没有日志 ID');
}

export async function verifyDrafts() {
  const initial = field('#settings-server-url');
  await choose('工具配置');
  const draft = field('#settings-content');
  await fill('#settings-content', '{"草稿":"分类和路由切换后保留"}');
  await choose('外观与主题');
  check(document.querySelector('#settings-theme'), '已有主题选择缺失');
  await choose('服务连接');
  check(field('#settings-server-url') === initial, '分类切换重建了连接字段');
  await choose('工具配置');
  check(field('#settings-content') === draft && draft.value.includes('分类和路由切换后保留'), '工具草稿丢失');
  accepted('分类切换保留连接与工具配置草稿');
  const nav = document.querySelector('nav[aria-label="设置分类"]');
  const category = nav?.querySelector('button');
  check(category instanceof HTMLButtonElement, '分类未使用原生按钮');
  category.focus();
  check(document.activeElement === category, '分类按钮不能聚焦');
  accepted('设置分类使用可聚焦原生按钮');
}

export function prepareKeyboardNavigation() {
  const nav = document.querySelector('nav[aria-label="设置分类"]');
  const current = nav?.querySelector('button');
  check(current instanceof HTMLButtonElement, '键盘分类起点缺失');
  current.focus();
  check(document.activeElement === current, '键盘分类起点无法聚焦');
}

export async function verifyKeyboardNavigation() {
  await until(() => document.querySelector('#settings-panel-appearance')?.hasAttribute('hidden') === false, 'Tab 后按 Enter 没有切换外观分类');
  const active = document.activeElement;
  check(active instanceof HTMLButtonElement && active.textContent?.trim() === '外观与主题', '键盘激活后焦点未保持在分类按钮');
  accepted('真实 Tab 移动焦点、Enter 激活下一设置分类');
}

export async function verifyPlugin() {
  const current = requireFixture();
  await current.loadPlugin();
  await choose('插件扩展');
  await until(() => document.querySelector('[aria-label="插件草稿"]') !== null, '插件追加未挂载');
  const input = field('[aria-label="插件草稿"]');
  await fill('[aria-label="插件草稿"]', '插件设置草稿保留');
  const count = current.mounted.count;
  await choose('服务连接');
  await choose('插件扩展');
  check(field('[aria-label="插件草稿"]') === input && input.value === '插件设置草稿保留', '分类切换撤销了插件草稿');
  check(count === current.mounted.count, '分类切换重复挂载插件');
  accepted('插件设置在分类切换中保持同一挂载和草稿');
}

export async function verifyNarrow() {
  check(document.documentElement.scrollWidth <= innerWidth + 1, '窄屏发生整页横向溢出');
  const trigger = [...document.querySelectorAll('[aria-label="设置分类"]')].find((node) => node.getAttribute('role') === 'combobox' && visible(node));
  check(trigger instanceof HTMLElement, '窄屏未显示分类选择器');
  trigger.click();
  await until(() => document.querySelector('[role="option"]') !== null, '窄屏分类列表未打开');
  const tools = [...document.querySelectorAll('[role="option"]')].find((node) => node.textContent?.trim() === '工具配置');
  check(tools instanceof HTMLElement, '窄屏分类缺少工具配置');
  tools.click();
  await until(() => field('#settings-content').closest('[hidden]') === null, '窄屏分类未切换');
  check(document.documentElement.scrollWidth <= innerWidth + 1, '窄屏工具配置横向溢出');
  accepted('窄屏分类选择器可切换且无整页横向溢出');
}

export function snapshot() {
  const current = requireFixture();
  const nav = document.querySelector('nav[aria-label="设置分类"]');
  const dimensions = ['#settings-server-url', '#settings-server-token', '#settings-marketplace-url'].map((selector) => {
    const node = field(selector);
    const rect = node.getBoundingClientRect();
    return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const typography = [...document.querySelectorAll('[data-settings-page] h2, [data-settings-page] h3, [data-settings-page] label')].filter(visible).map((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return { text: node.textContent?.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight };
  });
  const appearance = [...document.querySelectorAll('#settings-panel-connection button[type="submit"], #settings-panel-connection input, #settings-panel-connection [role="alert"], #settings-panel-connection [role="alert"] svg')].filter(visible).map((node) => {
    const style = getComputedStyle(node);
    return { element: node.tagName, id: node.id, text: node instanceof HTMLInputElement ? null : node.textContent?.trim(),
      color: style.color, background: style.backgroundColor, border: style.borderColor, stroke: style.stroke };
  });
  return {
    checks: [...checks], viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    currentCategory: nav?.querySelector('[aria-current="page"]')?.textContent?.trim(),
    dimensions, typography, appearance, fonts: { status: document.fonts.status, family: getComputedStyle(document.body).fontFamily },
    consoleScope: '真实 App 与受控服务回调，不表示真实 Rust 服务连接通过',
    pluginMounts: { ...current.mounted },
  };
}

export async function dispose() {
  root?.unmount();
  root = null;
  const current = fixture;
  await current?.dispose();
  fixture = null;
  check(!current || current.mounted.count === current.mounted.released, '测试结束插件挂载未全部回收');
  return { disposed: true, pluginMounts: current?.mounted ?? null };
}
