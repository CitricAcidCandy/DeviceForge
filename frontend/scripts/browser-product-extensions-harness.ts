import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/app/product/App.tsx';
import { createProductServices } from '../src/app/product/services.ts';
import { createNamedSlotAdapter } from '../src/plugins/index.ts';
import {
  createExtensionBrowserFixture,
  extensionVariable,
} from './browser-product-extensions-fixture.ts';
import { verifyExtensionProductPage } from './browser-product-extensions-plugins.ts';
import { verifySettingsProductPage } from './browser-product-extensions-settings.ts';
import { pause, until } from './session-browser-actions.ts';

export async function verifyProductExtensions() {
  const fixture = createExtensionBrowserFixture();
  const checks: { name: string; passed: true }[] = [];
  const failures: { stage: string; error: string; dom: string | undefined }[] = [];
  const target = document.createElement('div');
  const extensionRoot = document.createElement('section');
  const panel = document.createElement('div');
  const component = document.createElement('div');
  const module = document.createElement('div');
  extensionRoot.append(panel, component, module);
  document.body.append(target, extensionRoot);
  const themeRoot = document.documentElement;
  const previousProbe = themeRoot.style.getPropertyValue(extensionVariable);
  const previousPriority = themeRoot.style.getPropertyPriority(extensionVariable);
  themeRoot.style.setProperty(extensionVariable, '宿主原始值');
  const slots = await createNamedSlotAdapter([
    {
      id: 'workshop.extensions',
      target: component,
      renderDefault(root) {
        const node = document.createElement('span');
        node.dataset.fixtureDefaultSlot = '';
        node.textContent = '公开默认扩展区';
        root.append(node);
        return () => node.remove();
      },
    },
  ]);
  const services = createProductServices({
    baseUrl: location.origin,
    transport: fixture.transport,
    panelTarget: () => panel,
    componentTarget: () => component,
    moduleTarget: () => module,
    slotAdapter: slots,
    themeTarget: themeRoot,
    esmImporter: fixture.importer,
  });
  const root = createRoot(target);
  const previousHash = location.hash;
  location.hash = 'settings';
  root.render(createElement(App, { services }));
  await pause();
  const context = {
    target,
    extensionRoot,
    services,
    fixture,
    passed: (name: string) => checks.push({ name, passed: true }),
  };
  let stage = '配置产品真实交互';
  try {
    await until(
      () =>
        services.runtime.operations.snapshot().result !== null &&
        !services.runtime.operations.snapshot().pending,
      '产品外壳公开目录未就绪',
    );
    await pause();
    for (const [name, verify] of [
      ['配置产品真实交互', verifySettingsProductPage],
      ['插件产品真实交互', verifyExtensionProductPage],
    ] as const) {
      stage = name;
      try {
        await verify(context);
      } catch (error) {
        failures.push({
          stage,
          error: error instanceof Error ? error.message : '未知产品补验失败',
          dom: target.textContent?.slice(0, 3500),
        });
      }
    }
  } catch (error) {
    failures.push({
      stage,
      error: error instanceof Error ? error.message : '初始化失败',
      dom: target.textContent?.slice(0, 3500),
    });
  } finally {
    root.unmount();
    await services.dispose();
    await slots.dispose();
    target.remove();
    extensionRoot.remove();
    location.hash = previousHash;
    if (previousProbe)
      themeRoot.style.setProperty(extensionVariable, previousProbe, previousPriority);
    else themeRoot.style.removeProperty(extensionVariable);
  }
  return {
    passed: failures.length === 0,
    checks,
    failures,
    requests: fixture.requests,
    plugin_lifecycle: fixture.lifecycle,
    import_urls: fixture.imports,
    extension_calls: fixture.calls,
    scope:
      '真实App、官方组件、ProductServices与公开插件SDK；受控HTTP及ESM导入；不含Rust服务器、真实部署包字节或视觉验收',
  };
}
