import type { ApiResult, DependencyChangeDto, DependencyTargetDto, JobEventDto, PluginDependenciesDto } from '../../../services/api/index.ts';
import type { JobOptions, JobTicket, TaskRecord } from '../../../shared/jobs/index.ts';

export type DependencyTarget = Readonly<DependencyTargetDto>;
export type PluginDependency = Readonly<PluginDependenciesDto['dependencies'][number]>;
export type PluginDependenciesView = Readonly<Omit<PluginDependenciesDto, 'dependencies' | 'target'>> & {
  readonly target: DependencyTarget;
  readonly dependencies: readonly PluginDependency[];
};

export type DependencyCommand = Readonly<Omit<DependencyChangeDto, 'dependency_ids'>> & {
  readonly target: DependencyTarget;
  readonly dependency_ids?: Readonly<NonNullable<DependencyChangeDto['dependency_ids']>>;
};

export interface DependencyIssue {
  readonly message: string;
  readonly logId: string | null;
}

export interface PluginDependenciesState {
  readonly phase: 'idle' | 'loading' | 'scanning' | 'installing' | 'querying';
  readonly result: ApiResult<PluginDependenciesView> | null;
  readonly stale: boolean;
  readonly job: TaskRecord | null;
  readonly progress: NonNullable<JobEventDto['progress']> | null;
  readonly logId: string | null;
  readonly ticket: JobTicket | null;
  readonly notice: string | null;
  readonly issues: readonly DependencyIssue[];
}

export interface PluginDependenciesOptions extends JobOptions {
  readonly waitTimeoutMs?: number;
}
