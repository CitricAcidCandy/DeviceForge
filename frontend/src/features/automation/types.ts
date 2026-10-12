export type AutomationAction = { readonly kind: 'tap'; readonly x: number; readonly y: number }
  | { readonly kind: 'swipe'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly duration_ms: number }
  | { readonly kind: 'key'; readonly code: number }
  | { readonly kind: 'text'; readonly text: string };
export interface AutomationSequence { readonly device_id: string; readonly steps: readonly { readonly at_ms: number; readonly action: AutomationAction }[] }
export interface RepeatedClick { readonly device_id: string; readonly x: number; readonly y: number; readonly count: number; readonly interval_ms: number }
export interface AutomationResult { readonly device_id: string; readonly dispatched: number; readonly completed: true; readonly effect_confirmed: false }
