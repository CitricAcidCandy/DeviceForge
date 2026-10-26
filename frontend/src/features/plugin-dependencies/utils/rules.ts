import type { PluginDependency, PluginDependenciesState } from '../types/index.ts';

export function initialPluginDependenciesState(): PluginDependenciesState {
  return { phase: 'idle', result: null, stale: true, job: null, ticket: null, notice: null, issues: [] };
}

export function canInstallDependency(value: PluginDependency): boolean {
  return value.status !== 'ready' && value.installable;
}

export function missingRequiredDependencies(values: readonly PluginDependency[]): readonly string[] {
  return values.filter((value) => value.required && value.status === 'missing' && value.installable)
    .map((value) => value.id);
}
