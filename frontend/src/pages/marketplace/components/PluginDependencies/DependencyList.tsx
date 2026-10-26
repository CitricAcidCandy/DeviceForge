import { Badge, Button } from '../../../../components/index.ts';
import { canInstallDependency } from '../../../../features/plugin-dependencies/index.ts';
import type { PluginDependency } from '../../../../features/plugin-dependencies/index.ts';

const statusLabels = { ready: '已就绪', missing: '缺失', incompatible: '版本不兼容', failed: '检测或安装失败' };
const sourceLabels = { environment: '电脑环境', shared: '共享工具', local: '插件本地' };

export function DependencyList({ dependencies, disabled, onInstall }: {
  dependencies: readonly PluginDependency[];
  disabled: boolean;
  onInstall(id: string): void;
}) {
  if (!dependencies.length) return <p role="status" className="rounded-lg border border-dashed border-[color:var(--hairline)] p-5 text-center text-sm text-[color:var(--text-muted)]">
    此插件没有声明依赖，无需安装。
  </p>;
  return <ul className="flex flex-col gap-3" aria-label="插件依赖清单">
    {dependencies.map((item) => <li key={item.id} className="min-w-0 rounded-lg border border-[color:var(--hairline)] p-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-medium text-[color:var(--text-strong)]">{item.name}</h3>
          <p className="break-all font-mono text-xs text-[color:var(--text-faint)]">{item.id}</p>
        </div>
        <Badge variant={item.status === 'ready' ? 'outline' : 'warning'}>{statusLabels[item.status]}</Badge>
        <Badge variant="outline">{item.required ? '必需' : '可选'}</Badge>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-[color:var(--text-muted)]">
        <dt>版本要求</dt><dd className="min-w-0 break-all">{item.version_requirement || '未限定'}</dd>
        <dt>当前版本</dt><dd className="min-w-0 break-all">{item.version ?? '未发现'}</dd>
        <dt>来源</dt><dd>{item.source ? sourceLabels[item.source] : '尚未发现'}</dd>
      </dl>
      {item.message && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-[color:var(--text-muted)]">{item.message}</p>}
      {item.status !== 'ready' && <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={disabled || !canInstallDependency(item)}
          aria-label={`安装${item.required ? '依赖' : '可选依赖'} ${item.name}`} onClick={() => onInstall(item.id)}>
          {item.required ? '安装此依赖' : '安装可选依赖'}
        </Button>
        {!item.installable && <span className="text-xs text-[color:var(--text-faint)]">仅支持发现，请在后端电脑配置后重新检测。</span>}
      </div>}
    </li>)}
  </ul>;
}
