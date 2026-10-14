import { Button } from '../../components/ui/button.tsx';
import { PRODUCT_ROUTES } from './routes.ts';
import type { ProductRoute } from './routes.ts';

export interface ProductNavigationProps {
  readonly route: ProductRoute;
  readonly collapsed?: boolean;
  readonly onNavigate: (route: ProductRoute) => void;
}
// 导航只呈现既有路由元数据并发出选择事件，不持有业务状态或执行网络请求。
export function ProductNavigation({ route, collapsed = false, onNavigate }: ProductNavigationProps) {
  const groups = [...new Set(PRODUCT_ROUTES.map(entry => entry.group))];
  return <nav className="tool-navigation" aria-label="工坊工具" data-navigation-collapsed={collapsed}>
    {groups.map(group => <div className="navigation-group" data-navigation-group={group} key={group}>
      <h2 className="navigation-group-title">{group}</h2>
      <ul className="navigation-list">
        {PRODUCT_ROUTES.filter(entry => entry.group === group).map(entry => <li key={entry.id}>
          <Button type="button" variant="ghost" className={route === entry.id ? 'tool-link is-current' : 'tool-link'}
            aria-label={entry.label} aria-current={route === entry.id ? 'page' : undefined}
            title={collapsed ? entry.label : undefined} data-navigation-route={entry.id}
            onClick={() => onNavigate(entry.id)}>
            <entry.icon aria-hidden="true" /><span className="navigation-label">{entry.label}</span>
          </Button>
        </li>)}
      </ul>
    </div>)}
  </nav>;
}
