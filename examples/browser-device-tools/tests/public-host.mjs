// 仅模拟公开 SDK 的值与回调；不复制生产宿主、HTTP DTO 或平台实现。
export function provider(id, generation) {
  return { id, generation, version: '0.1.0', definition: { apiVersion: 3, platform: 'synthetic_demo',
    discoverOperation: 'discover', capabilities: [
      { id: 'echo', version: 1, operation: 'echo', scope: 'device', access: 'read' },
      { id: 'write', version: 1, operation: 'write', scope: 'device', access: 'write' },
    ] } };
}
export const operation = { id: 'plugin.mock.read', title: '模拟公开操作', input_schema: { type: 'object' },
  execution: { apiVersion: 1, totalTimeoutMs: 60000, source: 'default' } };
export const historicalJob = { id: 'job-history', operation: operation.id, status: 'succeeded',
  result: { result: { value: '原结果' }, artifacts: [] }, error: null };

export function gate() {
  let resolve; let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

export function publicHost({ hasDevices = true } = {}) {
  const lifetime = new AbortController();
  const owned = [];
  const operationListeners = new Set();
  const deviceListeners = new Set();
  const registrations = new Set();
  const calls = { submit: [], invoke: [], getJob: [], cancelJob: [], listOperations: 0 };
  const state = new Map();
  const events = [];
  const behavior = {};
  let operations = [operation];
  let snapshot = { providers: [], directories: [], selection: null, selected: null };
  const reply = (data, name) => ({ data, logId: 'fake-' + name });
  const subscribe = (listeners, listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const context = {
    apiVersion: 2, signal: lifetime.signal,
    async listOperations(signal) {
      signal.throwIfAborted(); ++calls.listOperations;
      return behavior.listOperations ? behavior.listOperations(signal) : reply(operations, 'operations');
    },
    async submit(id, input, signal) {
      signal.throwIfAborted();
      let submission = { operation: id, input };
      for (const value of registrations) for (const hook of value.beforeTaskSubmit ?? []) {
        submission = await hook.transform(submission, context, signal);
      }
      signal.throwIfAborted(); calls.submit.push(submission);
      return reply({ ...historicalJob, id: 'job-submitted', operation: submission.operation, status: 'queued', result: null }, 'submit');
    },
    async getJob(id, signal) { signal.throwIfAborted(); calls.getJob.push(id); return reply(historicalJob, 'history'); },
    async cancelJob(id, signal) { signal.throwIfAborted(); calls.cancelJob.push(id); return reply(historicalJob, 'cancel'); },
    subscribeOperations: (listener) => subscribe(operationListeners, listener),
    onDispose(dispose) { owned.push(dispose); return dispose; },
    extensions: {
      register(value) { registrations.add(value); return () => { registrations.delete(value); }; },
      setState: (key, value) => { state.set(key, value); },
      emitEvent: (name, data) => { events.push({ name, data }); },
    },
  };
  if (hasDevices) context.devices = {
    snapshot: () => snapshot,
    subscribe: (listener) => subscribe(deviceListeners, listener),
    async refreshProviders(signal) { signal.throwIfAborted(); return reply(snapshot.providers, 'providers'); },
    async refreshDirectories(signal) { signal.throwIfAborted(); return reply(snapshot.directories, 'directories'); },
    async refreshProvider(id, generation, signal) {
      signal.throwIfAborted(); return reply(snapshot.directories.find((entry) => entry.provider.id === id
        && entry.provider.generation === generation), 'discover');
    },
    select(reference) {
      snapshot = { ...snapshot, selection: reference, selected: reference
        ? snapshot.directories.flatMap((entry) => entry.devices).find((entry) => entry.reference.providerId === reference.providerId
          && entry.reference.generation === reference.generation && entry.reference.localId === reference.localId) : null };
      for (const listener of deviceListeners) listener(snapshot);
    },
    async invoke(action, signal) {
      signal.throwIfAborted(); calls.invoke.push({ action, signal });
      return behavior.invoke ? behavior.invoke(action, signal) : reply({ ...historicalJob, id: 'job-device' }, 'invoke');
    },
  };
  return { context, calls, state, events, behavior,
    command(name) {
      const found = [...registrations].flatMap((value) => value.commands ?? []).find((entry) => entry.id.endsWith('.' + name));
      if (!found) throw new Error('测试命令不存在：' + name);
      return (input, signal = context.signal) => found.execute(input, context, signal);
    },
    service(name) {
      const found = [...registrations].flatMap((value) => value.services ?? []).find((entry) => entry.id.endsWith('.' + name));
      if (!found) throw new Error('测试服务不存在：' + name);
      return (input, signal = context.signal) => found.invoke(input, context, signal);
    },
    operations(next) { operations = next; for (const listener of operationListeners) listener(next); },
    providers(next) {
      snapshot = { providers: next, directories: next.map((entry) => ({ provider: entry, observedAt: 1,
        discoveryJobId: 'fake-discovery-' + entry.id, devices: [{ reference: { providerId: entry.id,
          generation: entry.generation, localId: 'same-local-id' }, state: 'online', model: null,
          capabilities: [{ id: 'echo', version: 1, available: true, reason: null }] }] })), selection: null, selected: null };
      for (const listener of deviceListeners) listener(snapshot);
    },
    listeners: () => ({ operations: operationListeners.size, devices: deviceListeners.size, registrations: registrations.size }),
    async dispose() { lifetime.abort(); for (const release of owned.splice(0).reverse()) await release(); },
  };
}
