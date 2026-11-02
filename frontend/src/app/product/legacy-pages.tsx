import type { ReactNode } from 'react';
import { hostUi } from '../../plugin-sdk/index.ts';
import type { WebPlugin, WorkspacePageDefinition, WorkspaceViewDefinition } from '../../plugin-sdk/index.ts';
import type { ProductServices } from './services.ts';
import { PRODUCT_ROUTES } from './routes.ts';
import { DevicesPage } from '../../pages/devices/index.tsx';
import { SettingsPage } from '../../pages/settings/index.tsx';
import { MarketplacePage } from '../../pages/marketplace/index.tsx';
import { TasksPage } from '../../pages/tasks/index.tsx';
import { AdvancedPage } from './advanced.tsx';
import { createPageAdoption } from './page-adoption.ts';
import type { PageAdoptionOptions } from './page-adoption.ts';
import type { Dispose } from '../../plugin-sdk/index.ts';
import { registerLegacySettings } from '../composition/legacy-settings.ts';

/** 只保留尚未迁出的页面；迁出插件即使停用，也不再静默回到旧宿主实现。 */
export function createLegacyProductBridge(
  services: ProductServices, options: PageAdoptionOptions,
): WebPlugin {
  const adoption = createPageAdoption(options);
  const rows = PRODUCT_ROUTES;
  return {
    id: 'host_legacy_pages', version: '0.1.0', apiVersion: 2, panels: [],
    async activate(context) {
      const ui = context.ui;
      if (!ui) throw new Error('迁移适配需要公开工作区能力');
      registerLegacySettings(context, services.runtime.extensions, 'host_legacy_pages');
      const definitions = new Map<string, { page: WorkspacePageDefinition; view: WorkspaceViewDefinition }>();
      const registrations = new Map<string, Dispose>();
      for (const entry of rows) {
        const id = `host_legacy_pages.${entry.id}`;
        const mount: WorkspaceViewDefinition['mount'] = async (target, _host, instance) => {
          let active = instance.snapshot().visible;
          function element(): ReactNode {
            const body = entry.id === 'devices' ? <DevicesPage services={services} active={active} />
              : entry.id === 'settings' ? <SettingsPage services={services} />
                : entry.id === 'marketplace' ? <MarketplacePage services={services} active={active} />
                  : entry.id === 'tasks' ? <TasksPage services={services} />
                    : <AdvancedPage route={entry.id} services={services} active={active} />;
            return body;
          }
          const uiKit = hostUi();
          const root = uiKit.ReactDOMClient.createRoot(target);
          root.render(element());
          const unsubscribe = instance.subscribeVisibility((visible) => { active = visible; root.render(element()); });
          return () => { void unsubscribe(); root.unmount(); };
        };
        const page: WorkspacePageDefinition = {
          id: `${id}.page`, title: entry.label, route: `/${entry.id}`, mount,
          navigation: {
            group: entry.group, order: PRODUCT_ROUTES.indexOf(entry) * 10,
            icon: entry.icon.displayName ?? entry.id, description: entry.description,
            ...(entry.hidden ? { hidden: true } : {}),
          },
        };
        definitions.set(`/${entry.id}`, { page, view: { id, title: entry.label, mount } });
      }
      let updating = false;
      const refresh = () => {
        if (updating || context.signal.aborted) return;
        updating = true;
        try {
          adoption.observe(ui.catalog().pages, services.runtime.webPlugins.diagnosticSnapshot(), 'host_legacy_pages');
          for (const [route, definition] of definitions) {
            if (adoption.has(route)) {
              const release = registrations.get(route);
              registrations.delete(route); void release?.();
            } else if (!registrations.has(route)) {
              registrations.set(route, ui.register({ pages: [definition.page], views: [definition.view] }));
            }
          }
        } finally { updating = false; }
      };
      context.onDispose(ui.subscribe(refresh));
      if (context.extensions) context.onDispose(context.extensions.subscribeEvent('host.plugins.changed', refresh));
      refresh();
      if (adoption.error()) console.warn('旧页面迁移记录未持久化', adoption.error());
    },
  };
}
