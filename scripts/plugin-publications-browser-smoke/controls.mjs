// 只操作真实产品的可访问控件；公开接口读取用于核对，不替代页面提交。
export const pause = (ms = 30) => new Promise((done) => setTimeout(done, ms));
export const request = (url, options = {}) => fetch(url, { ...options,
  signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
export const visible = (node) => Boolean(node?.getClientRects().length) && getComputedStyle(node).visibility !== 'hidden';
export async function wait(read, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(); }
  throw new Error(`网页完整发布等待超时：${label}`);
}
export function check(condition, message) { if (!condition) throw new Error(message); }
export function button(label, root = document) {
  return [...root.querySelectorAll('button')].find((node) => visible(node) &&
    (typeof label === 'string' ? node.textContent.trim() === label || node.getAttribute('aria-label') === label :
      label.test(node.textContent.trim()) || label.test(node.getAttribute('aria-label') ?? '')));
}
export async function click(label, root = document) {
  const node = await wait(() => { const value = button(label, root); return value && !value.disabled ? value : null; }, `按钮 ${label}`);
  node.click(); await pause();
}
export const dialog = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible).at(-1);
export function control(label, root = document) {
  const field = [...root.querySelectorAll('label')].find((node) => node.textContent.trim().startsWith(label));
  return field?.htmlFor ? document.getElementById(field.htmlFor) : null;
}
export function input(label, value, root = document) {
  const field = control(label, root);
  check((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && !field.disabled, `字段不可编辑 ${label}`);
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
export async function api(path, options = {}, expected = 200) {
  const response = await request(path, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const value = await response.json();
  check(response.status === expected, `${path} 状态 ${response.status}`);
  check(/^[a-f0-9-]{36}$/.test(value.log_id), `${path} 缺少真实日志标识`);
  check(value.log_id === response.headers.get('x-deviceforge-log-id'), `${path} 日志标识不一致`);
  return value;
}
export async function screenshot(name) {
  await pause(120);
  const response = await request(`/__smoke/capture?name=${encodeURIComponent(name)}`);
  check(response.ok, `截图失败 ${name}`);
}
export async function stage(name) {
  const response = await request(`/__smoke/stage?name=${encodeURIComponent(name)}`, { method: 'POST' });
  check(response.ok, `阶段记录失败 ${name}`);
}
export async function closeDialog() {
  if (!dialog()) return;
  await click(button('关闭', dialog()) ? '关闭' : '取消', dialog());
  await wait(() => !dialog(), '关闭发布弹窗');
}
export async function selectZip(config, fixture) {
  const response = await request(new URL(fixture.file, config.gateway));
  check(response.ok, '本轮实际 ZIP 读取失败');
  const file = new File([await response.blob()], fixture.filename, { type: 'application/zip' });
  const field = await wait(() => [...(dialog()?.querySelectorAll('input[type="file"]') ?? [])]
    .find((node) => !node.disabled && !node.hasAttribute('webkitdirectory')), '完整功能 ZIP 文件输入');
  const files = new DataTransfer(); files.items.add(file); field.files = files.files;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => dialog()?.textContent.includes(fixture.filename), '已选完整功能 ZIP');
}
export function releaseCard(id) {
  // 相邻元素的 textContent 不保证有空格，使用产品已公开展示的精确标识。
  return [...document.querySelectorAll('.marketplace-card')].find((node) => visible(node) &&
    [...node.querySelectorAll('[title]')].some((field) => field.getAttribute('title') === id));
}
