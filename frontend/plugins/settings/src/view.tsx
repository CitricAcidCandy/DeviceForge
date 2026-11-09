import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext, WorkspaceViewContext } from '@deviceforge/plugin-sdk';
import { createSettingsServices } from './services.ts';
import type { SettingsServices } from './services.ts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from './view-support.tsx';
import { ToolSettings } from './view/ToolSettings.tsx';
import { ConnectionSettings } from './view/connection.tsx';
import { AppearanceSettings } from './view/appearance.tsx';
import { SettingsExtensions } from './view/extensions.tsx';
import { settingsInputClass } from './view/primitives.tsx';

const categories = [
  { id: 'connection', title: '服务连接' }, { id: 'appearance', title: '外观与主题' },
  { id: 'tools', title: '工具配置' }, { id: 'plugins', title: '插件扩展' },
];
export function SettingsView({ services, instance }: { services: SettingsServices; instance?: WorkspaceViewContext }) {
  const [category, setCategory] = useState('connection');
  const visibilitySource = useMemo(() => ({
    subscribe: (notify: () => void) => {
      const release = instance?.subscribeVisibility(() => notify());
      return () => { if (release) void Promise.resolve().then(release).catch(() => undefined); };
    },
    read: () => instance?.snapshot().visible ?? true,
  }), [instance]);
  const visible = useSyncExternalStore(visibilitySource.subscribe, visibilitySource.read, visibilitySource.read);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [categoryOpen, setCategoryOpen] = useState(false);
  useEffect(() => { if (!visible) setCategoryOpen(false); }, [visible]);
  return <div hidden={!visible} inert={!visible} className="@container/settings-page h-full min-h-0 min-w-0 w-full overflow-hidden">
  <main className="@container/settings flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card px-4 pt-6 pb-7 text-[14px] text-body @min-[640px]/settings-page:px-7" aria-label="设置工作区">
    <header className="flex h-[70px] shrink-0 items-start"><h1 className="text-[22px] font-semibold leading-9 text-ink">设置</h1></header>
    <div className="mb-6 shrink-0 @min-[800px]/settings:hidden">
      <Select open={visible && categoryOpen}
        onOpenChange={(open) => setCategoryOpen(visibleRef.current && open)}
        value={category} onValueChange={(value) => { if (visibleRef.current) setCategory(value); }}>
        <SelectTrigger className={`${settingsInputClass} w-full`} aria-label="设置分类"><SelectValue /></SelectTrigger>
        <SelectContent onCloseAutoFocus={(event) => { if (!visibleRef.current) event.preventDefault(); }}>
          {categories.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.title}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] @min-[800px]/settings:grid-cols-[209px_minmax(0,1fr)]">
      <nav aria-label="设置分类" className="hidden min-h-0 overflow-y-auto overscroll-contain border-r border-hairline pr-6 @min-[800px]/settings:block">
        {categories.map((entry) => <button key={entry.id} type="button" aria-current={entry.id === category ? 'page' : undefined}
          onClick={() => setCategory(entry.id)} className={cn(
            'mb-1.5 min-h-9 w-full rounded-[5px] px-[14px] py-1.5 text-left text-[13px] leading-6 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring',
            entry.id === category ? 'bg-primary/5 font-medium text-primary' : 'text-body',
          )}>{entry.title}</button>)}
      </nav>
      <div className="@container/settings-content min-h-0 min-w-0 @min-[800px]/settings:pl-8">
        {categories.map((entry) => <section key={entry.id} hidden={entry.id !== category}
          aria-label={entry.title} className="h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain pr-1 pb-2">
          <div className="max-w-[840px]">
            <h2 className="text-[18px] font-medium leading-[30px] text-ink">{entry.title}</h2>
            {entry.id === 'connection' ? <ConnectionSettings context={services.context} />
              : entry.id === 'appearance' ? <AppearanceSettings services={services} visible={visible && entry.id === category} />
                : entry.id === 'tools' ? <ToolSettings services={services} visible={visible && entry.id === category} />
                  : <SettingsExtensions context={services.context} pointId={services.sectionsId} workspaceId={services.workspaceId} />}
          </div>
        </section>)}
      </div>
    </div>
  </main>
  </div>;
}
export function mountSettings(target: HTMLElement, context: HostContext, sectionsId: string, workspaceId: string, instance?: WorkspaceViewContext) {
  const services = createSettingsServices(context, sectionsId, workspaceId);
  return hostUi().mountReact(target, <SettingsView services={services} {...(instance ? { instance } : {})} />);
}
