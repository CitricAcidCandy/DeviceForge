import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { MarketplaceServices } from '../../services.ts';
import { createUiDirectoryClient } from '../../ui-directory.ts';
import type { UiDirectory } from '../../ui-directory.ts';
import { errorLogId } from '../../hooks.ts';

/** 晚注册槽位未出现只代表当前未确认，不能据此判定插件写错名字。 */
export function SlotAudit({ services }: { services: MarketplaceServices }) {
  const [directory, setDirectory] = useState<UiDirectory | null>(null), [error, setError] = useState<unknown>(null);
  const [components, setComponents] = useState(services.context.extensions?.catalog().components ?? []);
  useEffect(() => {
    const api = createUiDirectoryClient(services.context), lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, services.context.signal]);
    let revision = 0;
    async function read() {
      const current = ++revision;
      try {
        const result = await api.snapshot(signal);
        if (!signal.aborted && revision === current) { setDirectory(result.data); setError(null); }
      } catch (error) { if (!signal.aborted && revision === current) { setError(error); setDirectory(null); } }
    }
    const release = api.subscribe(() => { void read(); });
    const extensions = services.context.extensions?.subscribeEvent('host.plugins.changed', () => {
      if (!signal.aborted) setComponents(services.context.extensions?.catalog().components ?? []);
    });
    void read();
    return () => { lifetime.abort(); revision++; void release(); void extensions?.(); };
  }, [services]);
  const waiting = components.filter((entry) => !directory?.slots.known ||
    !directory.slots.entries.some((slot) => slot.id === entry.slot && slot.ready));
  const points = directory?.points.contributions.filter((entry) => entry.state !== 'active') ?? [];
  if (!error && !waiting.length && !points.length) return null;
  const labels = { waiting: '等待扩展点', version_mismatch: '版本不匹配', invalid: '贡献校验未通过', active: '可用' };
  return <section role="status" aria-label="界面挂载对账" className="flex flex-col gap-1.5 rounded-lg border border-warning/30 bg-warning/[0.07] px-4 py-3">
    <p className="flex items-center gap-2 text-[13px] font-medium text-warning"><TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {error ? '界面目录未确认' : '部分界面贡献等待挂载或依赖'}</p>
    {error !== null && <p className="text-xs">{error instanceof Error ? error.message : '目录读取失败'}{errorLogId(error) && <> · 日志 ID：<code>{errorLogId(error)}</code></>}</p>}
    <ul className="flex flex-col gap-1">
      {waiting.map((entry) => <li key={`${entry.pluginId}:${entry.id}`} className="flex flex-wrap gap-2 text-xs">
        <span>{entry.pluginId} · {entry.title}</span><code>{entry.slot}</code><span>当前页面尚未确认挂载点</span>
      </li>)}
      {points.map((entry) => <li key={`${entry.provider.pluginId}:${entry.id}`} className="flex flex-wrap gap-2 text-xs">
        <span>{entry.provider.pluginId} · {entry.id}</span><code>{entry.point.id}@{entry.point.version}</code><span>{labels[entry.state]}</span>
      </li>)}
    </ul>
    <p className="text-xs text-muted-foreground">槽位随页面和插件挂载；未出现在当前目录不代表名字无效。可进入对应页面后重新查看。</p>
  </section>;
}
