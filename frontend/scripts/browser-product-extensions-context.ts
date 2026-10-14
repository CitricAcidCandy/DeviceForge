import type { ProductServices } from '../src/app/product/services.ts';
import type { createExtensionBrowserFixture } from './browser-product-extensions-fixture.ts';
import { check, click, pause, until } from './session-browser-actions.ts';

export interface ExtensionBrowserContext {
  readonly target: HTMLElement;
  readonly extensionRoot: HTMLElement;
  readonly services: ProductServices;
  readonly fixture: ReturnType<typeof createExtensionBrowserFixture>;
  readonly passed: (name: string) => void;
}
export async function navigateExtensionPage(
  route: 'plugins' | 'settings' | 'tasks',
  label: string,
) {
  const navigation = document.querySelector('.desktop-tools');
  check(navigation, '真实产品导航不存在');
  await click(label, navigation);
  await until(
    () => document.querySelector(`[data-route="${route}"]`)?.hasAttribute('hidden') === false,
    `路由未展示：${route}`,
  );
}
export async function closeExtensionDialog() {
  const dialog = document.querySelector('[role="dialog"]');
  check(dialog instanceof HTMLElement, '公开扩展弹窗不存在');
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => !document.querySelector('[role="dialog"]'), '弹窗未释放');
  await pause();
}
