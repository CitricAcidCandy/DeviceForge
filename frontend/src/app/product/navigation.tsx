import { Puzzle } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { VISIBLE_ROUTES } from './routes.ts';
import type { ProductRoute } from './routes.ts';
import type { PluginPageInfo } from './slots.tsx';

export interface ProductNavigationProps {
  readonly route: ProductRoute;
  readonly pluginPages?: readonly PluginPageInfo[];
  readonly replacedRoutes?: ReadonlySet<string>;
  readonly collapsed?: boolean;
  readonly onNavigate: (route: ProductRoute) => void;
}
// 导航只呈现既有路由元数据并发出选择事件，不持有业务状态或执行网络请求。
export function ProductNavigation({
  route,
  pluginPages = [],
  replacedRoutes,
  collapsed = false,
  onNavigate,
}: ProductNavigationProps) {
  const groups = [...new Set(VISIBLE_ROUTES.map((entry) => entry.group))];
  return (
    <nav className="tool-navigation" aria-label="工坊工具" data-navigation-collapsed={collapsed}>
      {groups.map((group) => (
        <div className="navigation-group" data-navigation-group={group} key={group}>
          <h2 className="navigation-group-title">{group}</h2>
          <ul className="navigation-list">
            {VISIBLE_ROUTES.filter((entry) => entry.group === group).map((entry) => (
              <li key={entry.id}>
                <Button
                  type="button"
                  variant="ghost"
                  className={route === entry.id ? 'tool-link is-current' : 'tool-link'}
                  aria-label={entry.label}
                  aria-current={route === entry.id ? 'page' : undefined}
                  title={collapsed ? entry.label : undefined}
                  data-navigation-route={entry.id}
                  onClick={() => onNavigate(entry.id)}
                >
                  <entry.icon aria-hidden="true" />
                  <span className="navigation-label">{entry.label}</span>
                  {replacedRoutes?.has(entry.id) ? (
                    <span
                      className="ml-auto rounded bg-primary/10 px-1.5 text-[0.6875rem] leading-4 text-primary"
                      aria-label="此页由插件接管"
                    >
                      插件
                    </span>
                  ) : null}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {pluginPages.length === 0 ? null : (
        <div className="navigation-group" data-navigation-group="插件">
          <h2 className="navigation-group-title">插件</h2>
          <ul className="navigation-list">
            {pluginPages.map((page) => (
              <li key={page.key}>
                <Button
                  type="button"
                  variant="ghost"
                  className={route === page.key ? 'tool-link is-current' : 'tool-link'}
                  aria-label={page.title}
                  aria-current={route === page.key ? 'page' : undefined}
                  title={collapsed ? page.title : undefined}
                  data-navigation-route={page.key}
                  data-navigation-plugin={page.pluginId}
                  onClick={() => onNavigate(page.key)}
                >
                  <Puzzle aria-hidden="true" />
                  <span className="navigation-label">{page.title}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
