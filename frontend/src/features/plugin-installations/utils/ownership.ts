import type { InstallationComponent, PluginInstallation } from '../types/index.ts';

export function installationComponentKey(component: Pick<InstallationComponent, 'id' | 'kind'>): string {
  return `${component.kind}:${component.id}`;
}
export function ownedInstallationComponents(installations: readonly PluginInstallation[]): ReadonlySet<string> {
  return new Set(installations.flatMap((installation) => installation.components.map(installationComponentKey)));
}
export function installationForComponent(installations: readonly PluginInstallation[], kind: 'server' | 'browser', id: string): PluginInstallation | undefined {
  return installations.find((installation) => installation.components.some((component) => component.kind === kind && component.id === id));
}
