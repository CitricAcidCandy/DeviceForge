import type { Dispose, JsonValue } from './models.ts';

// 这里只公开主动登记的语义信息，不开放宿主状态、组件 props 或任意对象路径。
export interface DebugOwner {
  readonly pluginId: string;
  readonly generation: number;
  readonly instanceId?: string;
}
export type DebugMetadata = { readonly [key: string]: JsonValue };
export interface DebugNodeDefinition {
  readonly id: string;
  readonly parentId?: string;
  readonly role: string;
  readonly label: string;
  readonly metadata?: DebugMetadata;
}
export interface DebugNodeRecord {
  readonly id: string;
  readonly generation: number;
  readonly revision: number;
  readonly parentId: string | null;
  readonly role: string;
  readonly label: string;
  readonly metadata: DebugMetadata;
}
export interface DebugNodeHandle {
  readonly id: string;
  readonly generation: number;
  readonly update: (definition: Omit<DebugNodeDefinition, 'id'>) => void;
  readonly dispose: Dispose;
}
export interface DebugEventInput {
  readonly name: string;
  readonly nodeId?: string;
  readonly metadata?: DebugMetadata;
}
export interface DebugEventRecord {
  readonly sequence: number;
  readonly observedAt: number;
  readonly name: string;
  readonly nodeId: string | null;
  readonly metadata: DebugMetadata;
}
export interface DebugResourceDefinition {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly metadata?: DebugMetadata;
}
export interface DebugResourceRecord {
  readonly id: string;
  readonly generation: number;
  readonly kind: string;
  readonly label: string;
  readonly metadata: DebugMetadata;
  readonly state: 'registered' | 'released' | 'release_failed';
}
export interface DebugAccess {
  readonly registerNode: (definition: DebugNodeDefinition) => DebugNodeHandle;
  readonly emit: (event: DebugEventInput) => void;
  readonly registerResource: (definition: DebugResourceDefinition, release: Dispose) => Dispose;
  // 仅登记调用方已经明确取得的会话；宿主在本作用域释放时关闭，不影响其他观察者。
  readonly registerSession?: (sessionId: string) => Dispose;
}
export interface DebugRegistrySnapshot {
  readonly owner: DebugOwner;
  readonly revision: number;
  readonly disposed: boolean;
  readonly nodes: readonly DebugNodeRecord[];
  readonly events: readonly DebugEventRecord[];
  readonly resources: readonly DebugResourceRecord[];
  readonly droppedEvents: number;
  readonly truncated: boolean;
}
