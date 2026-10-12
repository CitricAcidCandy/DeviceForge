export interface DesktopPosition { readonly x: number; readonly y: number }
export interface DesktopClick { readonly button: 'left' | 'right' | 'middle'; readonly click: 'single' | 'double'; readonly position?: DesktopPosition }
export type DesktopRepeatLimit = { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'duration'; readonly duration_ms: number }
  | { readonly kind: 'manual'; readonly max_duration_ms: number };
export interface DesktopRepeat extends DesktopClick { readonly interval_ms: number; readonly repeat: DesktopRepeatLimit; readonly stop_on_f9?: boolean }
export interface InputTraceRecord { readonly event_type: 0 | 1 | 2; readonly interval_ms: number; readonly duration_ms: number }
export interface InputTracePlayback { readonly artifact_id: string; readonly event_type: 0 | 1 | 2 }
export interface DesktopPositionResult extends DesktopPosition { readonly coordinate_space: 'virtual_desktop'; readonly source: 'GetCursorPos' }
export interface DesktopClickResult { readonly dispatched: 1; readonly button: DesktopClick['button']; readonly click: DesktopClick['click']; readonly position: DesktopPosition; readonly effect_confirmed: false }
export interface DesktopRepeatResult { readonly dispatched: number; readonly stop_reason: 'count_limit' | 'duration' | 'manual_limit' | 'f9'; readonly button: DesktopClick['button']; readonly click: DesktopClick['click']; readonly position: DesktopPosition; readonly elapsed_ms: number; readonly effect_confirmed: false }
export interface InputTraceRecorded { readonly recorded: true; readonly event_type: 0 | 1 | 2; readonly duration_ms: number; readonly events: number; readonly stop: 'stdin_exit'; readonly format: 'input_trace.msgpack.v1'; readonly effect_confirmed: false }
export interface InputTracePlayed { readonly completed: true; readonly event_type: 0 | 1 | 2; readonly events: number; readonly format: 'input_trace.msgpack.v1'; readonly effect_confirmed: false }
