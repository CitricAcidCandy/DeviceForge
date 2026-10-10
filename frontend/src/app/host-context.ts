import { HostError } from '../plugin-sdk/index.ts';
import type { DeviceAccess, Dispose, HostContext, Operation } from '../plugin-sdk/index.ts';
import type { OperationDto } from '../shared/api/index.ts';
import type { Operations } from '../features/operations/index.ts';
import type { Tasks } from '../features/tasks/index.ts';
import { publicCall, publicJob, publicOperation } from './public-api.ts';
import { createHostDeviceAccess } from './device-host.ts';
import { createArtifactGateway } from './artifact-gateway.ts';
import type { ArtifactTransport } from './artifact-gateway.ts';
import { createTaskHistoryGateway } from './task-history-gateway.ts';
import type { TaskHistoryTransport } from './task-history-gateway.ts';

export function createHostContext(operations: Operations, tasks: Tasks, lifetime: AbortController, devices?: DeviceAccess, artifacts?: ArtifactTransport, taskHistory?: TaskHistoryTransport) {
  const disposers = new Set<Dispose>();
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  function onDispose(dispose: Dispose): Dispose {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      disposers.delete(release);
      try {
        const task = Promise.resolve(dispose()).catch((error: unknown) => { failures.push(error); });
        pending.add(task); void task.then(() => { pending.delete(task); }); return task;
      }
      catch (error) { failures.push(error); }
    };
    if (lifetime.signal.aborted) release(); else disposers.add(release);
    return release;
  }
  const signal = (caller: AbortSignal) => AbortSignal.any([caller, lifetime.signal]);
  const context = Object.freeze<HostContext>({
    apiVersion: 2,
    signal: lifetime.signal,
    listOperations: (caller) => publicCall(operations.list(signal(caller)), (items) => items.map(publicOperation)),
    submit: (id, input, caller) => publicCall(tasks.submit({ operation: id, input }, signal(caller)), publicJob),
    getJob: (id, caller) => publicCall(tasks.get(id, signal(caller)), publicJob),
    cancelJob: (id, caller) => publicCall(tasks.cancel(id, signal(caller)), publicJob),
    subscribeOperations(listener) {
      if (lifetime.signal.aborted) throw new HostError('cancelled', 'host_closed', '宿主已关闭');
      let last: readonly OperationDto[] | null = null;
      return onDispose(operations.subscribe((snapshot) => {
        if (lifetime.signal.aborted || !snapshot.result || snapshot.result.data === last) return;
        last = snapshot.result.data;
        listener(last.map(publicOperation));
      }));
    },
    onDispose,
    ...(devices ? { devices: createHostDeviceAccess(devices, lifetime.signal, onDispose) } : {}),
    ...(artifacts ? { artifacts: createArtifactGateway(artifacts, lifetime.signal) } : {}),
    ...(taskHistory ? { taskHistory: createTaskHistoryGateway(taskHistory, lifetime.signal) } : {}),
  });
  return {
    context,
    async dispose() {
      lifetime.abort();
      for (const release of [...disposers].reverse()) release();
      while (pending.size) await Promise.all([...pending]);
      if (failures.length) throw new AggregateError(failures, '宿主资源释放失败');
    },
  };
}
