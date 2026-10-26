import type { PluginDependenciesView, PluginDependency } from '../src/features/plugin-dependencies/index.ts';
import type { JobDto, JobEventDto } from '../src/services/api/index.ts';

export function dependency(overrides: Partial<PluginDependency> = {}): PluginDependency {
  return { id: 'adb', name: 'ADB 工具', version_requirement: '>=1.0.0', required: true,
    status: 'missing', source: null, version: null, installable: true, message: null, ...overrides };
}
export function dependenciesView(overrides: Partial<PluginDependenciesView> = {}): PluginDependenciesView {
  return { target: { kind: 'release', id: 'example' }, revision: 'revision-1',
    dependencies: [dependency()], ready: false, ...overrides };
}
export function noBrowserDependencies(): PluginDependenciesView {
  return dependenciesView({ target: { kind: 'browser', id: 'example' }, dependencies: [], ready: true });
}
export function dependencyJob(overrides: Partial<JobDto> = {}): JobDto {
  return { id: 'dependency-task', operation: 'dependency.install', input: {}, created_at: 1,
    status: 'succeeded', result: null, ...overrides };
}
export function dependencyEvent(overrides: Partial<JobEventDto> = {}): JobEventDto {
  return { job_id: 'dependency-task', sequence: 1, timestamp: 1, status: 'running',
    progress: { stage: 'downloading', resource_id: 'adb', completed_bytes: 25, total_bytes: 100 }, ...overrides };
}
