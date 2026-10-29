import type { Dispose, JsonValue } from './models.js';
export interface DebugOwner {
    readonly pluginId: string;
    readonly generation: number;
    readonly instanceId?: string;
}
export type DebugMetadata = {
    readonly [key: string]: JsonValue;
};
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
export interface DebugDataSnapshot {
    readonly revision: string;
    readonly value: JsonValue;
}
export interface DebugDataWrite {
    readonly expectedRevision: string;
    readonly value: JsonValue;
}
export interface DebugDataSourceDefinition {
    readonly id: string;
    readonly label: string;
    readonly schema: JsonValue;
    readonly persistence: 'memory' | 'persistent';
    readonly applyPolicy: 'immediate' | 'next_invocation' | 'reload';
    readonly read: (query: JsonValue, signal: AbortSignal) => Promise<DebugDataSnapshot>;
    readonly write?: (request: DebugDataWrite, signal: AbortSignal) => Promise<void>;
}
export interface DebugDataSourceInfo {
    readonly id: string;
    readonly label: string;
    readonly schema: JsonValue;
    readonly schema_complete: boolean;
    readonly omitted_schema_paths: readonly string[];
    readonly writable: boolean;
    readonly persistence: DebugDataSourceDefinition['persistence'];
    readonly apply_policy: DebugDataSourceDefinition['applyPolicy'];
}
export interface DebugAccess {
    readonly registerNode: (definition: DebugNodeDefinition) => DebugNodeHandle;
    readonly emit: (event: DebugEventInput) => void;
    readonly registerResource: (definition: DebugResourceDefinition, release: Dispose) => Dispose;
    readonly registerSession?: (sessionId: string) => Dispose;
    readonly registerDataSource?: (definition: DebugDataSourceDefinition) => Dispose;
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
