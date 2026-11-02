import type { MarketplaceEntry } from '../../../model/index.ts';
import type { DependencyTarget } from '../../dependencies/index.ts';
import { isReleaseEntry } from '../../installations.ts';

export function dependencyTarget(entry: MarketplaceEntry): DependencyTarget | null {
  if (isReleaseEntry(entry)) return { kind: 'release', id: entry.id };
  const kind = entry.details['plugin_kind'];
  return entry.kind === 'plugin' && (kind === 'server' || kind === 'browser') ? { kind, id: entry.id } : null;
}
