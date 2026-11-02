import type { HostContext, HostEvent, HostResult, JsonValue, PluginJsonRequest } from '@deviceforge/plugin-sdk';

export function marketContext(options: {
  request?: (input: PluginJsonRequest, signal: AbortSignal) => Promise<HostResult<JsonValue>>;
  call?: (input: JsonValue, signal: AbortSignal) => Promise<HostResult<JsonValue>>;
  upload?: NonNullable<HostContext['artifacts']>['upload'];
  debuggerAvailable?: boolean;
} = {}): HostContext & { emitHostEvent(name: string): void; listenerCount(): number } {
  const unavailable = () => Promise.reject(new Error('本单元未提供此能力'));
  const events = new Map<string, Set<(event: HostEvent) => void>>();
  return {
    apiVersion: 2, signal: new AbortController().signal, onDispose: (release) => release,
    listOperations: unavailable, submit: unavailable, getJob: unavailable, cancelJob: unavailable,
    subscribeOperations: () => () => undefined,
    emitHostEvent(name) {
      for (const listener of events.get(name) ?? []) listener({ name, data: null, pluginId: 'host', generation: 0 });
    },
    listenerCount: () => [...events.values()].reduce((total, set) => total + set.size, 0),
    extensions: {
      catalog: () => ({ components: [], modules: [], commands: [], services: [] }),
      register: () => () => undefined, executeCommand: unavailable, callService: unavailable,
      subscribeEvent(name, listener) {
        const group = events.get(name) ?? new Set();
        group.add(listener); events.set(name, group);
        return () => { group.delete(listener); };
      },
      emitEvent: () => undefined, getState: () => undefined, setState: () => undefined, subscribeState: () => () => undefined,
    },
    transport: { request: options.request ?? unavailable, bytes: unavailable, stream: unavailable },
    artifacts: { upload: options.upload ?? unavailable, download: unavailable },
    services: {
      catalog: () => options.debuggerAvailable ? [{
        service: { id: 'host.debugger', version: '1' }, available: true, reason: null,
        operation: null, contract: { inputSchema: {}, outputSchema: {} },
        provider: { id: 'host', version: '1', generation: '0' },
      }] : [], call: (_reference, input, signal) => (options.call ?? unavailable)(input, signal),
      callTyped: unavailable, diagnostics: () => [], whenAvailable: () => () => undefined,
    },
  };
}
