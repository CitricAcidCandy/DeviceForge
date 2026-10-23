import { useState } from 'react';
import { PluginConfigurationDialog } from '../../../../components/PluginConfigurationDialog/index.tsx';
import { Button, DialogShell } from '../../../../components/index.ts';
import type { ProductServices } from '../../../../app/product/services.ts';
import type { MarketplaceEntry } from '../../../../features/marketplace/index.ts';
import type { PluginInstallation } from '../../../../features/plugin-installations/index.ts';
import type { PluginConfigurationTarget } from '../../../../features/plugin-configurations/index.ts';
import { entryConfigurationTargets } from '../../presentation.ts';

export function MarketplaceConfiguration({ entry, installations, services, onClose, onApplied }: {
  entry: MarketplaceEntry | null; installations: readonly PluginInstallation[];
  services: ProductServices; onClose(): void; onApplied(): void;
}) {
  const [selection, setSelection] = useState<PluginConfigurationTarget | null>(null);
  if (!entry) return null;
  const targets = entryConfigurationTargets(entry, installations);
  const target = targets.length === 1 ? targets[0] : targets.find((item) => item.kind === selection?.kind && item.id === selection.id);
  if (!target) return <DialogShell open title={`配置 · ${entry.name}`} onOpenChange={(open) => { if (!open) onClose(); }}
    description="选择需要配置的插件组件。" footer={<Button variant="outline" onClick={onClose}>关闭</Button>}>
    {targets.length ? targets.map((item) => <Button key={`${item.kind}:${item.id}`} variant="outline" onClick={() => setSelection(item)}>
      {item.kind === 'server' ? '服务器组件' : '浏览器组件'} · {item.id}
    </Button>) : <p role="status">安装目录中没有可配置组件，请刷新后重试。</p>}
  </DialogShell>;
  return <PluginConfigurationDialog key={`${target.kind}:${target.id}`} open title={`${entry.name}${targets.length > 1 ? ` · ${target.id}` : ''}`} onClose={() => { if (targets.length > 1) setSelection(null); else onClose(); }}
    load={(signal) => services.pluginConfigurations.get(target, signal)}
    save={(revision, values, signal) => services.pluginConfigurations.save(target, revision, values, signal)}
    reset={(revision, signal) => services.pluginConfigurations.reset(target, revision, signal)}
    apply={(revision, signal) => services.pluginConfigurations.apply(target, revision, signal)} onApplied={onApplied} />;
}
