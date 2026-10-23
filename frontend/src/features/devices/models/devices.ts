import { HostError } from '../../../plugin-sdk/index.ts';
import type {
  DeviceAccess,
  DeviceAction,
  DeviceDirectory,
  HostResult,
  Job,
} from '../../../plugin-sdk/index.ts';
import { awaitDeviceRequest } from './requests.ts';
import { actionTargets, createDeviceState } from './state.ts';
import { requireProvider, sameReference, validateAction } from '../utils/rules.ts';

export type DeviceGateway = Pick<
  DeviceAccess,
  'refreshProviders' | 'refreshDirectories' | 'refreshProvider' | 'invoke'
>;

export function createDevices(gateway: DeviceGateway) {
  const lifetime = new AbortController();
  let providersRequest: AbortController | null = null;
  let directoriesRequest: AbortController | null = null;
  let discoveryRevision = 0;
  const refreshes = new Map<string, { generation: string; controller: AbortController }>();
  const actions = new Set<{
    action: DeviceAction;
    controller: AbortController;
    selected: boolean;
  }>();
  const state = createDeviceState((next, previous) => {
    for (const [id, entry] of refreshes) {
      if (
        !next.providers.some(
          (provider) => provider.id === id && provider.generation === entry.generation,
        )
      )
        entry.controller.abort();
    }
    for (const entry of actions) {
      if (
        !next.providers.some(
          (provider) =>
            provider.id === entry.action.providerId &&
            provider.generation === entry.action.generation,
        ) ||
        (entry.selected && !sameReference(next.selection, previous.selection))
      )
        entry.controller.abort();
      try {
        validateAction(next, entry.action);
      } catch {
        entry.controller.abort();
      }
    }
  });
  const combined = (caller: AbortSignal, request: AbortController) =>
    AbortSignal.any([caller, request.signal, lifetime.signal]);
  function check(signal: AbortSignal) {
    if (lifetime.signal.aborted || signal.aborted)
      throw new HostError('cancelled', 'cancelled', '设备请求或目录已撤销');
  }
  function stale(message: string, logId: string | null): never {
    throw new HostError('cancelled', 'stale_device_result', message, logId);
  }
  async function refreshProviders(signal: AbortSignal, requestGateway: DeviceGateway = gateway) {
    check(signal);
    providersRequest?.abort();
    const request = new AbortController();
    providersRequest = request;
    const current = combined(signal, request);
    try {
      const result = await awaitDeviceRequest(requestGateway.refreshProviders(current), current);
      check(current);
      if (providersRequest !== request) stale('旧提供者列表已撤销', result.logId);
      state.updateProviders(result.data);
      return result;
    } finally {
      if (providersRequest === request) providersRequest = null;
    }
  }
  async function refreshDirectories(signal: AbortSignal, requestGateway: DeviceGateway = gateway) {
    return loadDirectories(signal, requestGateway, () => true);
  }
  async function loadDirectories(
    signal: AbortSignal,
    requestGateway: DeviceGateway,
    canPublish: () => boolean,
  ) {
    check(signal);
    directoriesRequest?.abort();
    const request = new AbortController();
    directoriesRequest = request;
    const current = combined(signal, request);
    try {
      const listed = await refreshProviders(current, requestGateway);
      if (!canPublish()) stale('目录重查已被更新的显式请求替代', listed.logId);
      const providerRevision = state.providerRevision();
      const observationRevision = state.observationRevision();
      const result = await awaitDeviceRequest(requestGateway.refreshDirectories(current), current);
      check(current);
      if (
        directoriesRequest !== request ||
        !canPublish() ||
        providerRevision !== state.providerRevision() ||
        observationRevision !== state.observationRevision()
      )
        stale('旧聚合设备目录已撤销', result.logId);
      const providers = state.snapshot().providers;
      const data = result.data.filter((item) =>
        providers.some(
          (provider) =>
            provider.id === item.provider.id && provider.generation === item.provider.generation,
        ),
      );
      state.updateDirectories(data);
      return { data, logId: result.logId };
    } finally {
      if (directoriesRequest === request) directoriesRequest = null;
    }
  }
  async function refreshProvider(
    id: string,
    generation: string,
    signal: AbortSignal,
    requestGateway: DeviceGateway = gateway,
  ): Promise<HostResult<DeviceDirectory>> {
    check(signal);
    if (!state.known()) await refreshProviders(signal, requestGateway);
    requireProvider(state.snapshot().providers, id, generation);
    refreshes.get(id)?.controller.abort();
    const request = { generation, controller: new AbortController() };
    refreshes.set(id, request);
    ++discoveryRevision;
    // 本地先撤销旧观测以防误用；服务端排队不清目录，真正执行前才清空本代观测。
    state.clearDirectory(id, generation);
    const current = combined(signal, request.controller);
    const revision = state.directoryRevision(id);
    try {
      const result = await awaitDeviceRequest(
        requestGateway.refreshProvider(id, generation, current),
        current,
      );
      check(current);
      if (refreshes.get(id) !== request || revision !== state.directoryRevision(id))
        stale('旧提供者发现结果已撤销', result.logId);
      requireProvider(state.snapshot().providers, id, generation);
      if (result.data.provider.id !== id || result.data.provider.generation !== generation)
        throw new HostError(
          'protocol',
          'invalid_device_directory',
          '发现响应与请求提供者代次不一致',
          result.logId,
        );
      state.updateDirectory(result.data);
      return result;
    } catch (error) {
      // 失败刷新清除本代观测；旧/替代请求不能清除后来成功的新目录。
      if (
        !lifetime.signal.aborted &&
        refreshes.get(id) === request &&
        revision === state.directoryRevision(id)
      )
        state.clearDirectory(id, generation);
      throw error;
    } finally {
      if (refreshes.get(id) === request) refreshes.delete(id);
    }
  }
  async function invoke(
    action: DeviceAction,
    signal: AbortSignal,
    requestGateway: DeviceGateway = gateway,
  ): Promise<HostResult<Job>> {
    check(signal);
    validateAction(state.snapshot(), action);
    const revision = state.directoryRevision(action.providerId);
    const request = {
      action: Object.freeze({ ...action }),
      controller: new AbortController(),
      selected: actionTargets(action, state.snapshot().selection),
    };
    actions.add(request);
    const current = combined(signal, request.controller);
    try {
      const result = await awaitDeviceRequest(requestGateway.invoke(request.action, current), current);
      check(current);
      validateAction(state.snapshot(), request.action);
      return result;
    } catch (error) {
      actions.delete(request);
      if (
        !current.aborted &&
        error instanceof HostError &&
        error.kind === 'protocol' &&
        error.code === 'conflict' &&
        error.status === 409 &&
        revision === state.directoryRevision(action.providerId)
      ) {
        if (
          providersRequest !== null ||
          directoriesRequest !== null ||
          refreshes.size > 0
        ) {
          state.clearDirectory(action.providerId, action.generation);
        } else {
          // 冲突后仅重查公开目录，不重放动作；后启动的显式发现始终优先。
          const discoveries = discoveryRevision;
          const canPublish = () =>
            discoveries === discoveryRevision &&
            revision === state.directoryRevision(action.providerId) &&
            refreshes.size === 0;
          try {
            await loadDirectories(signal, requestGateway, canPublish);
          } catch {
            if (
              !lifetime.signal.aborted &&
              !signal.aborted &&
              revision === state.directoryRevision(action.providerId) &&
              !refreshes.has(action.providerId)
            )
              state.clearDirectory(action.providerId, action.generation);
          }
        }
      }
      // 目录重查的错误不能覆盖最初的设备错误及其日志编号。
      throw error;
    } finally {
      actions.delete(request);
    }
  }
  return {
    refreshProviders,
    refreshDirectories,
    refreshProvider,
    invoke,
    select: state.select,
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    invalidateProvider: state.invalidateProvider,
    dispose() {
      lifetime.abort();
      providersRequest?.abort();
      directoriesRequest?.abort();
      for (const entry of refreshes.values()) entry.controller.abort();
      for (const entry of actions) entry.controller.abort();
      refreshes.clear();
      actions.clear();
      state.dispose();
    },
  };
}
export type Devices = ReturnType<typeof createDevices>;
