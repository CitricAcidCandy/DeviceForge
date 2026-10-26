import type { MarketplaceEntry } from '../../../../features/marketplace/index.ts';
import type { DependencyTarget } from '../../../../features/plugin-dependencies/index.ts';
import { isReleaseEntry } from '../../../../features/plugin-installations/index.ts';

export function dependencyTarget(entry: MarketplaceEntry): DependencyTarget | null {
  if (isReleaseEntry(entry)) return { kind: 'release', id: entry.id };
  const kind = entry.details['plugin_kind'];
  return entry.kind === 'plugin' && (kind === 'server' || kind === 'browser') ? { kind, id: entry.id } : null;
}
