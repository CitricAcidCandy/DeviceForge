import { createFrontendRuntime } from '../src/app/runtime.ts';
import type {
  DeviceAccess, DeviceCapability, DeviceRef, DeviceSnapshot, HostContext, HostResult, Job, Operation,
} from '../src/plugin-sdk/index.ts';

export const reference: DeviceRef = { providerId: 'android', generation: 'generation-a', localId: 'device-a' };
export const operation: Operation = {
  id: 'plugin.device.packages', title: '应用列表',
  input_schema: { properties: { input: { type: 'object', properties: {}, required: [] } } },
};
export function deviceState(target: DeviceRef | null = reference,
  extra: readonly DeviceCapability[] = []): DeviceSnapshot {
  const provider = target ?? reference;
  const capability = { id: 'packages', version: 1, operation: operation.id,
    scope: 'device', access: 'read' } satisfies DeviceSnapshot['providers'][number]['definition']['capabilities'][number];
  return {
    providers: [{
      id: provider.providerId, generation: provider.generation, version: '1',
      definition: { apiVersion: 3, platform: 'android', discoverOperation: 'discover', capabilities: [capability, ...extra] },
    }],
    directories: [], selection: target,
    selected: target ? { reference: target, state: 'online', model: null,
      capabilities: [capability, ...extra].map((item) => ({
        id: item.id, version: item.version, available: true, reason: null,
      })) } : null,
  };
}
export function completed(): HostResult<Job> {
  return { data: { id: 'app-job', operation: operation.id, status: 'succeeded',
    result: { result: { output: 'package:com.example.app\n' }, artifacts: [] }, error: null }, logId: 'apps-log' };
}
export function fixture(options: { replayOperations?: boolean } = {}) {
  const runtime = createFrontendRuntime({
    baseUrl: 'http://127.0.0.1:7031', workspaceStorage: null, panelTarget: () => null,
    transport: async () => { throw new Error('本单元不得联网'); },
  });
  let state = deviceState(), invocations = 0, uploads = 0, operationReads = 0;
  const listeners = new Set<(value: DeviceSnapshot) => void>();
  const operationListeners = new Set<(value: readonly Operation[]) => void>();
  let operationCatalog: readonly Operation[] = [operation];
  const lifetime = new AbortController();
  const disposals: (() => void | Promise<void>)[] = [];
  let invoke: DeviceAccess['invoke'] = async () => completed();
  const devices: DeviceAccess = {
    snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select() { throw new Error('实例不得更改全局选择'); },
    refreshProviders: async () => { throw new Error('不得自动刷新'); },
    refreshDirectories: async () => { throw new Error('不得自动发现'); },
    refreshProvider: async () => { throw new Error('不得自动发现'); },
    async invoke(action, signal) { invocations++; return invoke(action, signal); },
  };
  const context: HostContext = {
    ...runtime.host, devices, signal: lifetime.signal,
    onDispose(callback) { disposals.push(callback); return callback; },
    artifacts: {
      async upload(filename, content) {
        uploads++;
        return { data: { id: 'uploaded', filename, mediaType: content.type,
          size: content.size, sha256: 'a'.repeat(64), createdAt: 1 }, logId: 'upload-log' };
      },
      async download() { throw new Error('未请求下载'); },
    },
    subscribeOperations(listener) {
      operationListeners.add(listener);
      if (options.replayOperations !== false) listener(operationCatalog);
      return () => { operationListeners.delete(listener); };
    },
    async listOperations() { operationReads++; return { data: operationCatalog, logId: 'operations-log' }; },
  };
  return {
    context, runtime, devices, lifetime,
    get counts() { return { invocations, uploads, operationReads, listeners: listeners.size }; },
    setInvoke(next: DeviceAccess['invoke']) { invoke = next; },
    setOperations(next: readonly Operation[]) {
      operationCatalog = next;
      for (const listener of [...operationListeners]) listener(next);
    },
    change(next: DeviceSnapshot) { state = next; for (const listener of [...listeners]) listener(state); },
    async dispose() {
      lifetime.abort();
      for (const release of disposals.reverse()) await release();
      await runtime.dispose();
    },
  };
}

