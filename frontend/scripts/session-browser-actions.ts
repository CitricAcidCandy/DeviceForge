export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 16));
export async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await pause();
  }
}
const visible = (element: Element) => !element.closest('[hidden]');
export function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll('button')].find(
    (item) =>
      visible(item) &&
      (item.textContent?.trim() === label || item.getAttribute('aria-label') === label),
  );
  check(element instanceof HTMLButtonElement, `未找到可见按钮：${label}`);
  return element;
}
export async function click(label: string, scope: ParentNode = document) {
  const target = button(label, scope);
  check(!target.disabled, `操作已禁用：${label}`);
  target.click();
  await pause();
}
export function field(
  label: string,
  scope: ParentNode = document,
): HTMLInputElement | HTMLTextAreaElement {
  const element = [...scope.querySelectorAll('label')].find(
    (item) => visible(item) && item.textContent?.trim() === label,
  );
  const target =
    element instanceof HTMLLabelElement ? document.getElementById(element.htmlFor) : null;
  check(
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement,
    `未找到可见字段：${label}`,
  );
  return target;
}
export async function fill(label: string, value: string, scope: ParentNode = document) {
  const target = field(label, scope);
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  check(setter, '浏览器缺少原生字段 setter');
  setter.call(target, value);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  await pause();
}
export async function select(label: string, text: string) {
  const fieldLabel = [...document.querySelectorAll('label')].find(
    (item) => visible(item) && item.textContent?.trim() === label,
  );
  const labelled =
    fieldLabel instanceof HTMLLabelElement ? document.getElementById(fieldLabel.htmlFor) : null;
  const target = labelled instanceof HTMLButtonElement ? labelled : button(label);
  target.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      pointerType: 'mouse',
      isPrimary: true,
    }),
  );
  await pause();
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent?.trim() === text,
  );
  check(option instanceof HTMLElement, `未找到选项：${text}`);
  option.focus();
  option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => target.textContent?.trim() === text, `选择项未应用：${text}`);
}
export async function upload(label: string, name: string) {
  const target = field(label);
  check(target instanceof HTMLInputElement, '上传字段不是文件输入');
  const transfer = new DataTransfer();
  transfer.items.add(new File(['受控 UTF-8 脚本'], name));
  target.files = transfer.files;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await pause();
}
