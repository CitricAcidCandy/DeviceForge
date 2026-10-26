import { TriangleAlert } from 'lucide-react';
import { HOST_SLOTS, isKnownSlot } from '../../../../app/product/slots.ts';
import { useExtensionCatalog } from '../../../../app/product/slots.tsx';
import type { ProductServices } from '../../../../app/product/services.ts';

/**
 * 槽位对账。
 *
 * 插件把 slot 写成宿主没开放的名字时不会报错，只是永远挂不上去——
 * 用户看到的是「装了却什么都没变」，排查时最容易怀疑错地方。
 * 这里把这类组件挑出来摊在市场页，并列出宿主实际开放的名字。
 */
export function SlotAudit({ services }: { services: ProductServices }) {
  const catalog = useExtensionCatalog(services);
  const orphans = catalog.components.filter((entry) => !isKnownSlot(entry.slot));
  if (orphans.length === 0) return null;
  return (
    <section
      role="status"
      aria-label="槽位对账"
      className="flex flex-col gap-1.5 rounded-lg border border-warning/30 bg-warning/[0.07] px-4 py-3"
    >
      <p className="flex items-center gap-2 text-[13px] font-medium text-warning">
        <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        宿主未开放此槽位
      </p>
      <ul className="flex flex-col gap-1">
        {orphans.map((entry) => (
          <li key={`${entry.pluginId}:${entry.id}`} className="flex flex-wrap items-baseline gap-2">
            <span className="text-[12px] text-[color:var(--text-body)]">
              {entry.pluginId} · {entry.title}
            </span>
            <span className="mono text-[11px] text-[color:var(--text-faint)]">{entry.slot}</span>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-[color:var(--text-faint)]">
        这些组件永远不会被挂载；改成下面任一名字才会生效。
      </p>
      <p className="mono text-[11px] leading-relaxed text-[color:var(--text-faint)]">
        {HOST_SLOTS.map((slot) => slot.id).join('  ·  ')}  ·  page.&lt;插件ID&gt;.&lt;页面&gt;
      </p>
    </section>
  );
}
