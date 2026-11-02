import { useState } from 'react';
import { hostUi } from '@deviceforge/plugin-sdk';
import type { HostContext } from '@deviceforge/plugin-sdk';
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
export function SettingsView({ services }: { services: SettingsServices }) {
  const [category, setCategory] = useState('connection');
  return <main className="@container/settings flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-6" aria-label="设置工作区">
    <header className="flex h-[70px] shrink-0 items-start"><h1 className="text-[22px] font-semibold leading-9 text-ink">设置</h1></header>
    <div className="mb-6 shrink-0 @min-[800px]/settings:hidden">
      <Select value={category} onValueChange={setCategory}>
        <SelectTrigger className={`${settingsInputClass} w-full`} aria-label="设置分类"><SelectValue /></SelectTrigger>
        <SelectContent>{categories.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.title}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] @min-[800px]/settings:grid-cols-[209px_minmax(0,1fr)]">
      <nav aria-label="设置分类" className="hidden overflow-y-auto border-r border-hairline pr-6 @min-[800px]/settings:block">
        {categories.map((entry) => <button key={entry.id} type="button" aria-current={entry.id === category ? 'page' : undefined}
          onClick={() => setCategory(entry.id)} className={cn(
            'mb-1.5 min-h-9 w-full rounded-[5px] px-[14px] py-1.5 text-left text-[13px] leading-6 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring',
            entry.id === category ? 'bg-primary/5 font-medium text-primary' : 'text-body',
          )}>{entry.title}</button>)}
      </nav>
      <div className="@container/settings-content min-h-0 min-w-0 @min-[800px]/settings:pl-8">
        {categories.map((entry) => <section key={entry.id} hidden={entry.id !== category}
          aria-label={entry.title} className="h-full min-h-0 min-w-0 overflow-y-auto pr-1 pb-2">
          <div className="max-w-[840px]">
            <h2 className="text-[18px] font-medium leading-[30px] text-ink">{entry.title}</h2>
            {entry.id === 'connection' ? <ConnectionSettings context={services.context} />
              : entry.id === 'appearance' ? <AppearanceSettings services={services} />
                : entry.id === 'tools' ? <ToolSettings services={services} />
                  : <SettingsExtensions context={services.context} pointId={services.sectionsId} workspaceId={services.workspaceId} />}
          </div>
        </section>)}
      </div>
    </div>
  </main>;
}
export function mountSettings(target: HTMLElement, context: HostContext, sectionsId: string, workspaceId: string) {
  const services = createSettingsServices(context, sectionsId, workspaceId);
  return hostUi().mountReact(target, <SettingsView services={services} />);
}
