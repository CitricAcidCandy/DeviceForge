import {
  installationRequiresRecovery,
  type InstallationClientState,
  type PluginInstallation,
} from './installations.ts';

/** 仅消费公开浏览器管理目录，不持有或启动插件运行实例。 */
export interface BrowserRuntime {
  readonly id: string;
  readonly generation: number;
  readonly state: 'loading' | 'loaded';
}

export interface InstallationBrowserStatus {
  readonly phase: 'not_required' | 'disabled' | 'loading' | 'ready' | 'failed' | 'missing' | 'unknown';
  readonly canActivate: boolean;
}

/** 服务器启用与本客户端运行分别确认；历史客户端结果不能证明当前实例仍在运行。 */
export function installationBrowserStatus(
  installation: PluginInstallation,
  client: InstallationClientState | undefined,
  runtime: readonly BrowserRuntime[] | null,
): InstallationBrowserStatus {
  const components = installation.components.filter((entry) => entry.kind === 'browser');
  if (!components.length) return { phase: 'not_required', canActivate: false };
  if (!installation.enabled || installationRequiresRecovery(installation) ||
      installation.status === 'configuration_required' || installation.status === 'dependencies_required')
    return { phase: 'disabled', canActivate: false };
  if (runtime === null) return { phase: 'unknown', canActivate: false };
  const current = client?.id === installation.id && client.revision === installation.revision ? client : undefined;
  const instances = components.map((component) => runtime.find((entry) => entry.id === component.id));
  if (current?.phase === 'activating' || instances.some((entry) => entry?.state === 'loading'))
    return { phase: 'loading', canActivate: false };
  if (current?.phase === 'failed') return { phase: 'failed', canActivate: true };
  if (current?.phase === 'enabled' && instances.every((entry) => entry?.state === 'loaded'))
    return { phase: 'ready', canActivate: false };
  return { phase: 'missing', canActivate: true };
}
