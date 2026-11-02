import type {
  ArtifactAccess, DeviceAccess, DeviceRef, DeviceSnapshot, HostContext,
} from '@deviceforge/plugin-sdk';
import { abortable, apiError, ApiError } from '@deviceforge/business-kit/api';
import { sameDevice } from '@deviceforge/business-kit/device';
import { createOperationSource, createPublicGateway } from '@deviceforge/business-kit/platform';
import { createPackageAnalysis } from './model/package-analysis/index.ts';
import { createDeviceAppsDrafts } from './drafts.ts';

/** 完整引用固定于实例；全局选择变化只撤销旧等待，不替实例选择另一设备。 */
export function createDeviceAppsServices(context: HostContext, target: DeviceRef | null) {
  context.signal.throwIfAborted();
  const deviceCapability = context.devices, artifactCapability = context.artifacts;
  if (!deviceCapability || !artifactCapability)
    throw new Error('设备应用需要公开设备和产物能力，请升级宿主');
  const source = deviceCapability, artifactSource = artifactCapability;
  const reference = target ? Object.freeze({ ...target }) : null;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([context.signal, lifetime.signal]);
  let observation = new AbortController(), disposed = false;
  const listeners = new Set<(snapshot: DeviceSnapshot) => void>();
  function matchesTarget(): boolean {
    const state = source.snapshot();
    return !disposed && reference !== null &&
      sameDevice(state.selection, reference) && sameDevice(state.selected?.reference ?? null, reference) &&
      state.providers.some((provider) => provider.id === reference.providerId &&
        provider.generation === reference.generation);
  }
  function snapshot(): DeviceSnapshot {
    const state = source.snapshot();
    return matchesTarget() ? state : { ...state, selection: null, selected: null };
  }
  async function admitted<T>(input: AbortSignal, run: (current: AbortSignal) => Promise<T>): Promise<T> {
    const current = AbortSignal.any([input, signal, observation.signal]);
    if (!matchesTarget())
      throw new ApiError('cancelled', 'device_apps_target_changed',
        '工作区目标与当前设备引用不一致，请重新核对目标');
    current.throwIfAborted();
    try {
      const result = await abortable(run(current), current);
      current.throwIfAborted();
      if (!matchesTarget())
        throw new ApiError('cancelled', 'device_apps_target_changed', '旧设备结果已撤销');
      return result;
    } catch (error) { throw apiError(error); }
  }
  const unwatch = source.subscribe(() => {
    if (!matchesTarget()) {
      observation.abort();
      observation = new AbortController();
    }
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  });
  const devices: DeviceAccess = {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    select() { throw new ApiError('protocol', 'device_apps_selection_owned',
      '设备应用实例只消费工作区目标，请在设备目录选择设备'); },
    refreshProviders: (current) => admitted(current, (next) => source.refreshProviders(next)),
    refreshDirectories: (current) => admitted(current, (next) => source.refreshDirectories(next)),
    refreshProvider: (id, generation, current) => admitted(current, (next) =>
      source.refreshProvider(id, generation, next)),
    invoke(action, current) {
      if (!reference || action.providerId !== reference.providerId ||
          action.generation !== reference.generation || action.deviceId !== reference.localId)
        return Promise.reject(new ApiError('protocol', 'device_apps_action_target',
          '设备动作的完整引用不属于此工作区实例'));
      return admitted(current, (next) => source.invoke(action, next));
    },
  };
  const artifacts: ArtifactAccess = {
    upload: (filename, content, current) => admitted(current, (next) =>
      artifactSource.upload(filename, content, next)),
    download: (id, current) => admitted(current, (next) => artifactSource.download(id, next)),
  };
  const publicContext: HostContext = {
    ...context, signal, devices, artifacts,
    submit: (operation, input, current) => admitted(current, (next) => context.submit(operation, input, next)),
    getJob: (id, current) => admitted(current, (next) => context.getJob(id, next)),
    cancelJob: (id, current) => admitted(current, (next) => context.cancelJob(id, next)),
  };
  const operations = createOperationSource(publicContext);
  const packageAnalysis = createPackageAnalysis(createPublicGateway(publicContext), {}, artifacts);
  function dispose() {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', dispose);
    lifetime.abort(); observation.abort();
    void unwatch();
    operations.dispose(); packageAnalysis.dispose(); listeners.clear();
  }
  context.signal.addEventListener('abort', dispose, { once: true });
  const drafts = createDeviceAppsDrafts();
  return {
    context: publicContext, devices, artifacts, operations, packageAnalysis, reference,
    async ensureOperations(current: AbortSignal) {
      const existing = operations.snapshot().result;
      if (existing) return existing;
      return operations.list(AbortSignal.any([current, signal]));
    },
    drafts, matchesTarget, dispose,
  };
}
export type DeviceAppsServices = ReturnType<typeof createDeviceAppsServices>;
