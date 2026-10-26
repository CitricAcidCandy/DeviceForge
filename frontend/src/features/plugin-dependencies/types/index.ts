import type { ApiResult } from '../../../services/api/index.ts';
import type { JobOptions, JobTicket, TaskRecord } from '../../../shared/jobs/index.ts';

export interface DependencyTarget {
  readonly kind: 'release' | 'server' | 'browser';
  readonly id: string;
}

// 生成契约接入前的消费模型；后续由适配器索引 DTO，页面不依赖生成文件。
export interface PluginDependency {
  readonly id: string;
  readonly name: string;
  readonly version_requirement: string;
  readonly required: boolean;
  readonly status: 'ready' | 'missing' | 'incompatible' | 'failed';
  readonly source: 'environment' | 'shared' | 'local' | null;
  readonly version: string | null;
  readonly installable: boolean;
  readonly message: string | null;
}

export interface PluginDependenciesView {
  readonly target: DependencyTarget;
  readonly revision: string;
  readonly dependencies: readonly PluginDependency[];
  readonly ready: boolean;
}

export interface DependencyCommand {
  readonly target: DependencyTarget;
  readonly expected_revision: string;
  readonly dependency_ids?: readonly string[];
}

export interface DependencyIssue {
  readonly message: string;
  readonly logId: string | null;
}

export interface PluginDependenciesState {
  readonly phase: 'idle' | 'loading' | 'scanning' | 'installing' | 'querying';
  readonly result: ApiResult<PluginDependenciesView> | null;
  readonly stale: boolean;
  readonly job: TaskRecord | null;
  readonly ticket: JobTicket | null;
  readonly notice: string | null;
  readonly issues: readonly DependencyIssue[];
}

export interface PluginDependenciesOptions extends JobOptions {
  readonly waitTimeoutMs?: number;
}
