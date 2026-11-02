import { useState } from 'react';
import { PluginConfigurationDialog } from '../PluginConfigurationDialog/index.tsx';
import { Button, DialogShell } from '../../ui.tsx';
import type { MarketplaceServices } from '../../services.ts';
import type { MarketplaceEntry } from '../../../model/index.ts';
import type { PluginInstallation } from '../../installations.ts';
import type { PluginConfigurationTarget } from '../../configuration.ts';
import { entryConfigurationTargets } from '../../presentation.ts';

export function MarketplaceConfiguration({ entry, installations, services, onClose, onApplied, visible = true }: {
  entry: MarketplaceEntry | null; installations: readonly PluginInstallation[];
  services: MarketplaceServices; onClose(): void; onApplied(): void; visible?: boolean;
}) {
  const [selection, setSelection] = useState<PluginConfigurationTarget | null>(null);
  if (!entry) return null;
  const targets = entryConfigurationTargets(entry, installations);
  const target = targets.length === 1 ? targets[0] : targets.find((item) => item.kind === selection?.kind && item.id === selection.id);
  if (!target) return <DialogShell open={visible} title={`配置 · ${entry.name}`} onOpenChange={(open) => { if (!open) onClose(); }}
    description="选择需要配置的插件组件。" footer={<Button variant="outline" onClick={onClose}>关闭</Button>}>
    {targets.length ? targets.map((item) => <Button key={`${item.kind}:${item.id}`} variant="outline" onClick={() => setSelection(item)}>
      {item.kind === 'server' ? '服务器组件' : '浏览器组件'} · {item.id}
    </Button>) : <p role="status">安装目录中没有可配置组件，请刷新后重试。</p>}
  </DialogShell>;
  return <PluginConfigurationDialog key={`${target.kind}:${target.id}`} open visible={visible} title={`${entry.name}${targets.length > 1 ? ` · ${target.id}` : ''}`} onClose={() => { if (targets.length > 1) setSelection(null); else onClose(); }}
    load={(signal) => services.pluginConfigurations.get(target, signal)}
    save={(revision, values, signal) => services.pluginConfigurations.save(target, revision, values, signal)}
    reset={(revision, signal) => services.pluginConfigurations.reset(target, revision, signal)}
    apply={(revision, signal) => services.pluginConfigurations.apply(target, revision, signal)} onApplied={onApplied} />;
}
