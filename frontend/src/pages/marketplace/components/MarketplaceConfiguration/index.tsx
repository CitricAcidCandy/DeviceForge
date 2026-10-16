import { PluginConfigurationDialog } from '../../../../components/PluginConfigurationDialog/index.tsx';
import type { ProductServices } from '../../../../app/product/services.ts';
import type { MarketplaceEntry } from '../../../../features/marketplace/index.ts';
import { pluginKind } from '../../presentation.ts';

export function MarketplaceConfiguration({ entry, services, onClose }: {
  entry: MarketplaceEntry | null; services: ProductServices; onClose(): void;
}) {
  const kind = entry && pluginKind(entry);
  if (!entry || !kind) return null;
  const target = { kind, id: entry.id };
  return <PluginConfigurationDialog open title={entry.name} onClose={onClose}
    load={(signal) => services.pluginConfigurations.get(target, signal)}
    save={(revision, values, signal) => services.pluginConfigurations.save(target, revision, values, signal)}
    reset={(revision, signal) => services.pluginConfigurations.reset(target, revision, signal)}
    apply={(revision, signal) => services.pluginConfigurations.apply(target, revision, signal)} />;
}
