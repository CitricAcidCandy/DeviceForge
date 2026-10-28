import type { DebugMetadata, DebugOwner } from '../../plugin-sdk/debug.ts';

export interface UiNodeRef {
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
}
export type EvidenceState = 'yes' | 'no' | 'unknown';
export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
export interface UiLayout {
  readonly source: 'client-rects' | 'unavailable';
  readonly rect: LayoutRect | null;
  readonly viewport: LayoutRect | null;
  readonly region: LayoutRect | null;
  readonly intersection: LayoutRect | null;
  readonly nonzeroSize: EvidenceState;
  readonly inViewport: EvidenceState;
  readonly withinRoot: EvidenceState;
  readonly clipped: EvidenceState;
  readonly occluded: 'unknown';
  readonly reason: string;
}
export interface UiNode extends UiNodeRef {
  readonly owner: DebugOwner;
  readonly parentId: string | null;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly kind: 'dom' | 'surface' | 'slot' | 'panel';
  readonly surfaceId: string | null;
  readonly hidden: EvidenceState;
  // 几何交集不能证明像素可见，遮挡证据仍为未知。
  readonly visible: EvidenceState;
  readonly layout: UiLayout;
  readonly disabled: EvidenceState;
  readonly required: EvidenceState;
  readonly invalid: EvidenceState;
  readonly opaque: boolean;
  readonly virtual: 'unknown' | 'declared';
  readonly confirmationRequired: boolean;
  readonly actionPolicy: 'read-only' | 'local' | 'device' | 'unknown';
  readonly metadata: DebugMetadata;
}
export interface TreeCoverage {
  readonly source: 'dom-accessible';
  readonly completeness: 'observed-dom-only';
  readonly visited: number;
  readonly excludedPluginRoots: number;
  readonly opaque: number;
  readonly virtual: 'unknown';
  readonly truncation: readonly ('nodes' | 'bytes' | 'scan')[];
}
export interface TreeSnapshot {
  readonly id: string;
  readonly owner: DebugOwner;
  readonly revision: number;
  readonly observedAt: number;
  readonly nodes: readonly UiNode[];
  readonly coverage: TreeCoverage;
  readonly bytes: number;
  readonly page: {
    readonly snapshotId: string;
    readonly offset: number;
    readonly limit: number;
    readonly nextOffset: number | null;
    readonly total: number;
  };
}
export interface TreeQuery {
  readonly id?: string;
  readonly role?: string;
  readonly name?: string;
  readonly surfaceId?: string;
  readonly descendantOf?: string;
  readonly hidden?: EvidenceState;
  readonly disabled?: EvidenceState;
  readonly limit?: number;
}
export interface TreeQueryResult {
  readonly nodes: readonly UiNode[];
  readonly complete: boolean;
  readonly reason: string | null;
}
export type TreeAssertion =
  | { readonly query: TreeQuery; readonly condition: 'exists' | 'absent' }
  | { readonly query: TreeQuery; readonly condition: 'count'; readonly expected: number }
  | { readonly query: TreeQuery; readonly condition: 'enabled' | 'visible' | 'valid' | 'in_viewport' | 'within_root' | 'unclipped' | 'nonzero_size' };
export interface TreeAssertionResult {
  readonly status: 'passed' | 'failed' | 'indeterminate';
  readonly reason: string;
  readonly matched: number;
}
export interface TreeDiff {
  readonly status: 'comparable' | 'indeterminate';
  readonly truncated: boolean;
  readonly added: readonly UiNode[];
  readonly removed: readonly UiNodeRef[];
  readonly changed: readonly UiNode[];
  readonly reason: string | null;
}
export type DebugActionRequest =
  | { readonly type: 'navigate'; readonly path: string; readonly confirmed?: boolean }
  | { readonly type: 'highlight' | 'click' | 'scroll'; readonly target: UiNodeRef; readonly confirmed?: boolean; readonly allowUnknownSideEffects?: boolean }
  | { readonly type: 'fill'; readonly target: UiNodeRef; readonly value: string; readonly confirmed?: boolean; readonly allowUnknownSideEffects?: boolean }
  | { readonly type: 'select'; readonly target: UiNodeRef; readonly values: readonly string[]; readonly confirmed?: boolean; readonly allowUnknownSideEffects?: boolean }
  | { readonly type: 'wait'; readonly assertion: TreeAssertion; readonly timeoutMs?: number };
export interface DebugActionResult {
  readonly status: 'applied' | 'dispatched' | 'passed' | 'rejected' | 'indeterminate' | 'cancelled';
  readonly reason: string;
  readonly target: UiNodeRef | null;
  readonly businessOutcome: 'unknown';
}
