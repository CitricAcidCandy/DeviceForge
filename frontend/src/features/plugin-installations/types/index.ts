import type { ApiResult, EventQuery, JobEventDto, InstalledReleaseDto } from '../../../services/api/index.ts';
import type { TaskRecord } from '../../../shared/jobs/index.ts';

// 页面与生命周期的领域模型，由 HTTP 适配器从生成契约显式映射。
export interface InstallationComponent {
  readonly id: string;
  readonly kind: 'server' | 'browser';
  readonly version: string;
  readonly entryPath: string;
  readonly revision: string;
  readonly entryUrl: string | null;
}
export interface PluginInstallation {
  readonly id: string;
  readonly version: string;
  readonly revision: string;
  readonly enabled: boolean;
  readonly status: 'installed' | 'enabled' | 'configuration_required' | 'recovery_blocked';
  readonly failure?: InstalledReleaseDto['failure'];
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly components: readonly InstallationComponent[];
}
export type InstallationSource =
  | { readonly kind: 'market'; readonly sourceUrl: string; readonly releaseId: string; readonly version: string; readonly releaseDigest: string }
  | { readonly kind: 'offline'; readonly artifactId: string };
export interface InstallationPlan {
  readonly id: string;
  readonly version: string;
  readonly revision: string;
  readonly issues: readonly { readonly code: string; readonly message: string; readonly required: boolean }[];
}
export interface InstallationGateway {
  readonly list: (signal: AbortSignal) => Promise<ApiResult<readonly PluginInstallation[]>>;
  readonly plan: (source: InstallationSource, signal: AbortSignal) => Promise<ApiResult<InstallationPlan>>;
  readonly install: (source: InstallationSource, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
  readonly update: (id: string, revision: string, source: InstallationSource, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
  readonly setEnabled: (id: string, revision: string, enabled: boolean, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
  readonly uninstall: (id: string, revision: string, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
  readonly getJob: (id: string, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
  readonly getEvents?: (id: string, query: EventQuery, signal: AbortSignal) => Promise<ApiResult<readonly JobEventDto[]>>;
  readonly cleanup?: (dryRun: boolean, signal: AbortSignal) => Promise<ApiResult<TaskRecord>>;
}
export interface InstallationBrowserLifecycle {
  readonly enable: (installation: PluginInstallation, component: InstallationComponent, signal: AbortSignal) => Promise<void>;
  readonly disable: (component: InstallationComponent, signal: AbortSignal) => Promise<void>;
}
export interface InstallationClientState {
  readonly id: string;
  readonly revision: string;
  readonly phase: 'activating' | 'enabled' | 'disabled' | 'failed';
  readonly message: string | null;
  readonly logId: string | null;
}
export interface InstallationProgress {
  readonly jobId: string;
  readonly operation: string;
  readonly status: TaskRecord['status'];
  readonly progress: NonNullable<JobEventDto['progress']> | null;
  readonly logId: string | null;
}
