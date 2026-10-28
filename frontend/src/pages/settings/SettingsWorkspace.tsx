import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/Select/index.tsx';
import { ExtensionSurface, useSlotAppends } from '../../app/product/slots.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import { cn } from '../../utils/classnames.ts';
import { ConnectionSettings } from './ConnectionSettings.tsx';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import { ToolSettings } from './ToolSettings.tsx';
import { settingsInputClass } from './primitives.tsx';

const categories = [
  { id: 'connection', title: '服务连接' },
  { id: 'appearance', title: '外观与主题' },
  { id: 'tools', title: '工具配置' },
  { id: 'plugins', title: '插件扩展' },
] as const;
type Category = (typeof categories)[number]['id'];
function isCategory(value: string): value is Category {
  return categories.some((entry) => entry.id === value);
}

export function SettingsWorkspace({ services }: { services: ProductServices }) {
  const [category, setCategory] = useState<Category>('connection');
  const hasPluginSettings = useSlotAppends(services, 'settings.plugin.section');
  return (
    <>
      <header className="flex h-[70px] shrink-0 items-start">
        <h1 className="text-[22px]! leading-9! font-semibold text-ink">设置</h1>
      </header>
      <div className="mb-6 shrink-0 min-[1100px]:hidden">
        <Select value={category} onValueChange={(value) => { if (isCategory(value)) setCategory(value); }}>
          <SelectTrigger className={`${settingsInputClass} w-full`} aria-label="设置分类">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categories.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.title}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[209px_minmax(0,1fr)]">
        <nav aria-label="设置分类" className="hidden min-h-0 overflow-y-auto overscroll-contain border-r border-hairline pr-6 min-[1100px]:block">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {categories.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={entry.id === category ? 'page' : undefined}
                  aria-controls={`settings-panel-${entry.id}`}
                  onClick={() => setCategory(entry.id)}
                  className={cn(
                    'min-h-9 w-full rounded-[5px] px-[14px] py-1.5 text-left text-[13px]! leading-6! break-words outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    entry.id === category ? 'bg-primary/5 font-medium text-primary' : 'font-normal text-body',
                  )}
                >
                  {entry.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-h-0 min-w-0 min-[1100px]:pl-8">
          {/* 分类只隐藏不卸载，保留草稿、请求、MCP 订阅和插件挂载实例。 */}
          {categories.map((entry) => (
            <section
              key={entry.id}
              id={`settings-panel-${entry.id}`}
              data-settings-category={entry.id}
              hidden={entry.id !== category}
              aria-labelledby={`settings-title-${entry.id}`}
              className="h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain pr-1 pb-2"
              tabIndex={-1}
            >
              <div className="max-w-[840px]">
                <h2 id={`settings-title-${entry.id}`} className="text-[18px]! leading-[30px]! font-medium! text-ink">{entry.title}</h2>
                {entry.id === 'connection' ? <ConnectionSettings services={services} />
                  : entry.id === 'appearance' ? <AppearanceSettings services={services} />
                    : entry.id === 'tools' ? <ToolSettings services={services} />
                      : <div className="mt-7">
                        {!hasPluginSettings && <p className="text-[13px] leading-6 text-muted-foreground">当前没有插件提供设置项。</p>}
                        <ExtensionSurface services={services} slot="settings.plugin.section" fallback={null} />
                      </div>}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
