import type { DebugAccess, JsonValue } from '../../plugin-sdk/index.ts';
import type { createPluginManager, PluginLifecycleObservation } from '../../plugins/manager.ts';
import type { ExtensionRegistry } from '../../plugins/extensions/registry.ts';
import type { PluginScope } from '../../plugins/scope.ts';
import type { DebugRegistry, UiCollector, DebugActions } from '../../plugins/debugger/index.ts';

export interface DebugTarget {
  readonly plugin_id: string;
  readonly generation: string | null;
}
export interface LocalDebuggerOptions {
  readonly document: Document;
  readonly signal: AbortSignal;
  readonly manager: () => ReturnType<typeof createPluginManager>;
  readonly extensions: ExtensionRegistry;
  readonly readHostRoutes?: () => readonly HostDebugRoute[];
  readonly navigate?: (path: string, signal: AbortSignal) => void | Promise<void>;
  readonly reloadPlugin?: (target: ResolvedTarget, signal: AbortSignal) => Promise<JsonValue>;
  readonly closeSession?: (sessionId: string) => Promise<void>;
  readonly slots?: readonly {
    readonly id: string;
    readonly label: string;
    readonly modes: readonly ('append' | 'replace')[];
    readonly route?: string | null;
    readonly description: string;
  }[];
}
export interface HostDebugRoute {
  readonly path: string;
  readonly label: string;
  readonly slotIds?: readonly string[];
}
export interface LocalDebugger {
  attach(pluginId: string, generation: string, scope: PluginScope): DebugAccess;
  observe(event: PluginLifecycleObservation): void;
  directory(): readonly { plugin_id: string; generation: string; version: string | null }[];
  select(targets: readonly DebugTarget[]): void;
  execute(tool: string, target: DebugTarget, parameters: JsonValue, signal: AbortSignal): Promise<JsonValue>;
  dispose(): void;
}
export interface AttachedDebug {
  readonly pluginId: string;
  readonly generation: string;
  readonly scope: PluginScope;
  readonly lifetime: AbortController;
  readonly registry: DebugRegistry;
  readonly access: DebugAccess;
  readonly lifecycle: PluginLifecycleObservation[];
  readonly collectors: Map<string, { collector: UiCollector; actions: DebugActions }>;
  session: AbortController;
  eventFloor: number;
  registrationFailures: number;
}
export interface ResolvedTarget {
  readonly plugin_id: string;
  readonly generation: string;
}
