import type { createPluginPackages } from '../../plugin-packages/index.ts';
import type { createServerPlugins } from '../../server-plugins/index.ts';
import type { WebPluginRuntimeInfo } from '../../../plugin-sdk/index.ts';
import type { PackageKind } from '../../../services/api/index.ts';
import type { PluginInstallations } from '../../plugin-installations/index.ts';

export interface PluginDefaultsGateway {
  readonly packages: Pick<ReturnType<typeof createPluginPackages>, 'refresh' | 'enable'>;
  readonly serverPlugins: Pick<ReturnType<typeof createServerPlugins>, 'refresh'>;
  readonly browserPlugins: { snapshot(): readonly WebPluginRuntimeInfo[] };
  readonly installations?: Pick<PluginInstallations, 'restore' | 'snapshot'>;
  readonly signal?: AbortSignal;
}
export interface PluginDefaultsResult {
  readonly kind: PackageKind;
  readonly id: string | null;
  readonly status: 'enabled' | 'already_enabled' | 'failed';
  readonly message: string | null;
  readonly logId: string | null;
}
export interface PluginDefaultsSnapshot {
  readonly round: number;
  readonly phase: 'idle' | 'running' | 'completed' | 'cancelled' | 'closed';
  readonly results: readonly PluginDefaultsResult[];
}
