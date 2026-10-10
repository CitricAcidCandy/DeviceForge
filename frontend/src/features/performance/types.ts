import type { components } from '../../shared/api/generated.ts';
import type { HostContext, Job } from '../../plugin-sdk/index.ts';

// HTTP 会话模型只索引生成契约；公开 SDK 不因此依赖生成类型。
export type PerformanceSession = components['schemas']['PerformanceSession'];
export type PerformanceSource = PerformanceSession['source'];
export type PerformanceDevice = NonNullable<PerformanceSource>['device'];
export type PerformancePage = components['schemas']['PerformancePage'];
export type PerformanceSessions = components['schemas']['PerformanceSessions'];
export type PerformanceStart = PerformanceSession['request'];
export type PerformanceReading = PerformancePage['readings'][number];
export type PerformanceGateway = Pick<HostContext, 'submit' | 'getJob'>;
export type PerformanceAction = 'start' | 'inspect' | 'pause' | 'resume' | 'stop' | 'samples' | 'list' | 'capabilities';

// 能力响应目前没有生成组件；这里只定义校验后的消费视图。
export interface PerformanceCapabilities {
  readonly metrics: readonly string[];
  readonly fps: boolean;
  readonly sourceLabel: string;
  readonly scope: 'main_process';
  readonly maxSamples: number;
  readonly sampleTimeoutMs: number;
}
export interface PerformanceOutcome<T> {
  readonly data: T;
  readonly job: Job;
  readonly submitLogId: string | null;
  readonly logId: string | null;
}
export interface PerformanceSnapshot {
  readonly selection: string | null;
  readonly session: PerformanceSession | null;
  readonly readings: readonly PerformanceReading[];
  readonly nextAfter: number;
  readonly pending: boolean;
  readonly needsReconcile: boolean;
  readonly liveAvailable: boolean;
  readonly error: unknown;
}
export interface PerformanceOptions {
  readonly pollIntervalMs?: number;
}
