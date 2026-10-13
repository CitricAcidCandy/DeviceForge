export type AutomationAction = { readonly kind: 'tap'; readonly x: number; readonly y: number }
  | { readonly kind: 'swipe'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly duration_ms: number }
  | { readonly kind: 'key'; readonly code: number }
  | { readonly kind: 'text'; readonly text: string };
export interface AutomationSequence { readonly device_id: string; readonly steps: readonly { readonly at_ms: number; readonly action: AutomationAction }[] }
export interface RepeatedClick { readonly device_id: string; readonly x: number; readonly y: number; readonly count: number; readonly interval_ms: number }
export interface AutomationResult { readonly device_id: string; readonly dispatched: number; readonly completed: true; readonly effect_confirmed: false }
import type { ApiError, ApiResult, OperationDto } from '../../shared/api/index.ts';
import type { JobOptions } from '../../shared/jobs/index.ts';

export type AutomationOperation = 'sequence.run' | 'click.repeat' | 'windows.mouse.position' | 'windows.mouse.click' | 'windows.mouse.repeat' | 'input_trace.record' | 'input_trace.playback';
export type DesktopAutomationOperation = Exclude<AutomationOperation, 'sequence.run' | 'click.repeat'>;
export interface AutomationOperationReader { readonly list: (signal: AbortSignal) => Promise<ApiResult<unknown>> }
export interface AutomationOptions extends JobOptions { readonly operations?: AutomationOperationReader }
export interface AutomationCatalogSnapshot {
  readonly operations: readonly Readonly<OperationDto>[];
  readonly refreshing: boolean;
  readonly logId: string | null;
  readonly error: ApiError | null;
}
