import type { DeviceRef, HostContext } from '../../plugin-sdk/index.ts';
import type { components } from '../../shared/api/generated.ts';

// 插件业务结果尚无 OpenAPI 模型；任务和产物继续引用共享生成契约。
export interface ProfileRequest { readonly package: string; readonly duration_ms: number; readonly interval_ms: number; readonly capture_frames?: boolean }
export interface ProbeResult {
  readonly format_version: 1; readonly device_id: string; readonly package: string;
  readonly root_access: 'none' | 'adbd_root' | 'su'; readonly simpleperf_available: boolean; readonly clock: 'boottime';
  readonly supported: boolean; readonly reason: string | null;
}
export interface ProfileIdentity {
  readonly format_version: 1; readonly device_id: string; readonly package: string;
  readonly pid: number; readonly process_start_ticks: string; readonly clock: 'boottime';
  readonly frame_kind: 'sampled_screenshot' | 'scrcpy_sampled_frame'; readonly display_frame_complete: false;
  readonly root_access: 'none' | 'adbd_root' | 'su'; readonly stack_status: 'captured' | 'unavailable'; readonly stack_reason: string | null;
  readonly frame_status?: 'captured' | 'unavailable' | 'disabled'; readonly frame_reason?: string | null;
}
export interface ProfileResult extends ProfileIdentity {
  readonly sample_count: number; readonly stack_sample_count: number; readonly lost_count: string; readonly reported_sample_count?: string; readonly frame_count: number;
  readonly index_filename: 'profile-index.json'; readonly archive_filename: 'profile.zip';
}
export type DeviceObservation = NonNullable<components['schemas']['PerformancePage']['readings'][number]['device_observation']>;
export interface ProfileMetrics {
  readonly captured_at: number; readonly pid: number; readonly process_start_ticks: number; readonly process_ticks: number;
  readonly system_ticks: number; readonly logical_cpus: number; readonly pss_kib: number; readonly rss_kib?: number | null;
  readonly frame_window?: { readonly frames: number; readonly duration_ms: number; readonly source: string } | null;
  readonly device_observation?: DeviceObservation | null;
}
export interface ProfileFrame {
  readonly index: number; readonly filename: string; readonly begin_ns: string; readonly end_ns: string;
  readonly source?: 'scrcpy'; readonly epoch?: number; readonly video_frame_index?: number; readonly pts_us?: string;
  readonly device_time_ns?: string; readonly selection_delta_ns?: string; readonly clock_error_ns?: string;
}
export interface ProfileDerived {
  readonly api_version: 1; readonly cpu_share_percent: number | null; readonly cpu_core_percent: number | null; readonly cpu_reason: string | null;
  readonly fps: number | null; readonly fps_reason: string | null; readonly battery_net_power_mw: number | null; readonly battery_reason: string | null;
}
export interface ProfileSample {
  readonly index: number; readonly begin_ns: string; readonly end_ns: string; readonly target_ns?: string; readonly metrics: ProfileMetrics; readonly derived?: ProfileDerived;
  readonly frame: ProfileFrame | null; readonly stack_sample_indices: readonly number[];
}
export interface ProfileIndex extends ProfileIdentity {
  readonly samples: readonly ProfileSample[]; readonly stack_sample_count: number; readonly lost_count: string; readonly reported_sample_count?: string;
  readonly symbolication: 'reported_symbols_only';
}
export interface StackFrame {
  readonly file: string | null; readonly symbol: string | null; readonly address: string;
  readonly execution_type: 'native' | 'interpreted_jvm' | 'jit_jvm' | 'art';
}
export interface StackSample {
  readonly time_ns: string; readonly thread_id: number; readonly process_id: number | null; readonly thread_name: string | null;
  readonly event_count: string; readonly event_type: string | null; readonly callchain: readonly StackFrame[];
  readonly unwinding: { readonly raw_error_code: number | null; readonly error_code: number | null; readonly error_address: string | null } | null;
}
export interface ProfileTimeline {
  readonly rootAccess: ProfileIdentity['root_access']; readonly stackStatus: ProfileIdentity['stack_status']; readonly stackReason: string | null;
  readonly frameStatus: 'captured' | 'unavailable' | 'disabled'; readonly frameReason: string | null;
  readonly clock: 'boottime'; readonly frameKind: ProfileIdentity['frame_kind']; readonly displayFrameComplete: false;
  readonly symbolication: 'reported_symbols_only';
  readonly samples: readonly { readonly sample: ProfileSample; readonly stacks: readonly ProfileFrameAssociation[]; readonly frameStacks: readonly ProfileFrameAssociation[] }[];
  readonly unassociated: readonly ProfileFrameAssociation[]; readonly withoutFrame: readonly ProfileFrameAssociation[];
}
export type ProfileHost = Pick<HostContext, 'devices' | 'getJob' | 'cancelJob' | 'signal' | 'onDispose'>;
export type ProfileReference = DeviceRef;

export interface ProfileFrameAssociation { readonly index: number; readonly sample: StackSample }
