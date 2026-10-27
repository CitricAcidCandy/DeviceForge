import type { HostContext, PluginContributions } from '../../plugin-sdk/index.ts';

export interface ExtensionOwner {
  readonly pluginId: string;
  readonly generation: number;
  readonly version?: string;
  readonly context: HostContext;
}
export interface Owned<T> {
  readonly contribution: T;
  readonly owner: ExtensionOwner;
}
export function contributionIds(value: PluginContributions): string[] {
  return [
    ...(value.components ?? []),
    ...(value.modules ?? []),
    ...(value.commands ?? []),
    ...(value.services ?? []),
    ...(value.beforeTaskSubmit ?? []),
    ...(value.themes ?? []),
  ].map((entry) => entry.id);
}
