import type { DebugActionRequest, DebugActionResult, UiNodeRef } from './contracts.ts';
import type { DebugOwner } from '../../plugin-sdk/debug.ts';

export interface DebugActionsOptions {
  readonly signal: AbortSignal;
  readonly allowedRoutes?: readonly string[];
  readonly navigate?: (path: string, signal: AbortSignal) => void | Promise<void>;
}
export interface DebugPickResult {
  readonly status: 'picked' | 'cancelled' | 'indeterminate';
  readonly target: UiNodeRef | null;
  readonly owner: DebugOwner | null;
  readonly reason: string;
  readonly source?: 'host-dom';
  readonly host?: {
    readonly tag: string;
    readonly role: string;
    readonly label: string;
    readonly nearest_slot?: string;
    readonly route?: string;
    readonly insertable: false;
  };
}
export interface DebugActions {
  readonly execute: (request: DebugActionRequest, signal: AbortSignal) => Promise<DebugActionResult>;
  readonly pickOnce: (signal: AbortSignal) => Promise<DebugPickResult>;
  readonly dispose: () => void;
}
