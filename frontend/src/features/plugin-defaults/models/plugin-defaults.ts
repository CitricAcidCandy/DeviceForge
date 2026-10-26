import { ApiError } from '../../../services/api/index.ts';
import type { PackageKind } from '../../../services/api/index.ts';
import { ownedInstallationComponents } from '../../plugin-installations/index.ts';
import type {
  PluginDefaultsGateway,
  PluginDefaultsResult,
  PluginDefaultsSnapshot,
} from '../types/index.ts';

// 依赖可能忽略取消；结束本地等待并消费晚到拒绝，不宣称服务器副作用回滚。
function awaitActive<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ApiError('cancelled', 'cancelled', '默认启用等待已取消'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (!signal.aborted) resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
const logId = (error: unknown) =>
  error !== null && typeof error === 'object' && 'logId' in error && typeof error.logId === 'string'
    ? error.logId
    : null;

export function createPluginDefaults(gateway: PluginDefaultsGateway) {
  const lifetime = new AbortController();
  const listeners = new Set<(value: PluginDefaultsSnapshot) => void>();
  let state: PluginDefaultsSnapshot = Object.freeze({
    round: 0,
    phase: 'idle',
    results: Object.freeze([]),
  });
  let active: Promise<PluginDefaultsSnapshot> | null = null;
  let started = false;
  let closed = false;
  let epoch = 0;
  function publish(next: PluginDefaultsSnapshot, current: number) {
    if (closed || epoch !== current) return;
    state = Object.freeze({
      ...next,
      results: Object.freeze(next.results.map((item) => Object.freeze(item))),
    });
    const snapshot = state;
    for (const listener of [...listeners]) {
      if (closed || epoch !== current || state !== snapshot) break;
      try {
        listener(snapshot);
      } catch {
        /* 订阅失败不阻断其他包。 */
      }
    }
  }
  function launch(
    mode: 'start' | 'retry' | 'restart',
    caller: AbortSignal,
  ): Promise<PluginDefaultsSnapshot> {
    if (closed)
      return Promise.reject(new ApiError('cancelled', 'defaults_closed', '默认启用已关闭'));
    if (active) return active;
    if (mode === 'start' && started) return Promise.resolve(state);
    const failures = state.results.filter((item) => item.status === 'failed');
    const successful = state.results.filter((item) => item.status !== 'failed');
    if (mode === 'retry' && failures.length === 0) return Promise.resolve(state);
    const signal = AbortSignal.any([
      caller,
      lifetime.signal,
      ...(gateway.signal ? [gateway.signal] : []),
    ]);
    if (signal.aborted)
      return Promise.reject(new ApiError('cancelled', 'cancelled', '默认启用等待已取消'));
    started = true;
    const current = ++epoch;
    const check = () => {
      if (closed || current !== epoch || signal.aborted)
        throw new ApiError('cancelled', 'cancelled', '默认启用等待已撤销');
    };
    const accept = (result: PluginDefaultsResult) => {
      check();
      publish(
        {
          ...state,
          results: [
            ...state.results.filter((item) => item.kind !== result.kind || item.id !== result.id),
            result,
          ],
        },
        current,
      );
    };
    const failed = (kind: PackageKind, id: string | null, error: unknown) =>
      accept({
        kind,
        id,
        status: 'failed',
        message: error instanceof Error ? error.message : '插件启用失败',
        logId: logId(error),
      });
    const perform = async () => {
      publish(
        {
          round: mode === 'retry' ? state.round : state.round + 1,
          phase: 'running',
          results: mode === 'retry' ? state.results.filter((item) => item.status !== 'failed') : [],
        },
        current,
      );
      try {
        if (gateway.installations) {
          try { await awaitActive(gateway.installations.restore(signal), signal); }
          catch (error) {
            check();
            failed('browser', null, error);
            // 目录读取失败时不越过统一安装意图启用底层包。
            if (!gateway.installations.snapshot().result) {
              publish({ ...state, phase: 'completed' }, current);
              return state;
            }
          }
        }
        const owned = ownedInstallationComponents(gateway.installations?.snapshot().result?.data ?? []);
        for (const kind of ['server', 'browser'] as const) {
          check();
          const targets = failures.filter((item) => item.kind === kind);
          if (mode === 'retry' && targets.length === 0) continue;
          if (kind === 'server') {
            try {
              const running = await awaitActive(gateway.serverPlugins.refresh(signal), signal);
              check();
              for (const plugin of running.data) {
                if (owned.has(`server:${plugin.id}`)) continue;
                if (
                  mode === 'retry' &&
                  !targets.some((item) => item.id === null || item.id === plugin.id)
                )
                  continue;
                if (plugin.state === 'draining') {
                  accept({
                    kind,
                    id: plugin.id,
                    status: 'failed',
                    message: '插件正在排空，尚未进入可用状态',
                    logId: running.logId,
                  });
                } else if (plugin.state === 'loaded') {
                  accept({
                    kind,
                    id: plugin.id,
                    status: 'already_enabled',
                    message: plugin.cleanup_failed ? '上次组件操作告警，可重试' : null,
                    logId: running.logId,
                  });
                }
              }
            } catch (error) {
              check();
              failed(kind, null, error);
              continue;
            }
          }
          let directory;
          try {
            directory = await awaitActive(gateway.packages.refresh(kind, signal), signal);
          } catch (error) {
            check();
            failed(kind, null, error);
            continue;
          }
          check();
          const retryAll = targets.some((item) => item.id === null);
          for (const pkg of directory.data) {
            check();
            if (
              pkg.kind !== kind ||
              owned.has(`${kind}:${pkg.id}`) ||
              (mode === 'retry' && !retryAll && !targets.some((item) => item.id === pkg.id))
            )
              continue;
            if (
              mode === 'retry' &&
              successful.some((item) => item.kind === kind && item.id === pkg.id)
            )
              continue;
            try {
              let already = false;
              let currentLog = directory.logId;
              let warning: string | null = null;
              if (kind === 'server') {
                // 每包提交前重新核对当前代，避免重复加载正在运行或排空的插件。
                const running = await awaitActive(gateway.serverPlugins.refresh(signal), signal);
                check();
                currentLog = running.logId;
                const present = running.data.find((item) => item.id === pkg.id);
                warning = present?.cleanup_failed ? '上次组件操作告警，可重试' : null;
                if (present?.state === 'draining')
                  throw new ApiError(
                    'protocol',
                    'plugin_draining',
                    '插件正在排空，尚未进入可用状态',
                    null,
                    currentLog,
                  );
                already = present?.state === 'loaded';
              } else {
                const present = gateway.browserPlugins
                  .snapshot()
                  .find((item) => item.id === pkg.id);
                if (present?.state === 'loading')
                  throw new ApiError(
                    'protocol',
                    'plugin_loading',
                    '浏览器插件正在启用，请稍后重试',
                    null,
                    currentLog,
                  );
                already = present?.state === 'loaded';
              }
              if (already)
                accept({
                  kind,
                  id: pkg.id,
                  status: 'already_enabled',
                  message: warning,
                  logId: currentLog,
                });
              else {
                const result = await awaitActive(
                  gateway.packages.enable(kind, pkg.id, signal),
                  signal,
                );
                check();
                if (result.data.state !== 'loaded')
                  throw new ApiError(
                    'protocol',
                    'plugin_not_loaded',
                    '插件尚未进入已启用状态',
                    null,
                    result.logId,
                  );
                accept({ kind, id: pkg.id, status: 'enabled',
                  message: warning || ('cleanup_failed' in result.data && result.data.cleanup_failed
                    ? '上次组件操作告警，可重试' : null), logId: result.logId });
              }
            } catch (error) {
              check();
              failed(kind, pkg.id, error);
            }
          }
        }
        check();
        publish({ ...state, phase: 'completed' }, current);
        return state;
      } catch (error) {
        if (!closed && current === epoch) publish({ ...state, phase: 'cancelled' }, current);
        throw error;
      }
    };
    const pending = Promise.resolve()
      .then(perform)
      .finally(() => {
        if (active === pending) active = null;
      });
    active = pending;
    return pending;
  }
  return {
    start: (signal: AbortSignal) => launch('start', signal),
    retryFailures: (signal: AbortSignal) => launch('retry', signal),
    restart: (signal: AbortSignal) => launch('restart', signal),
    snapshot: () => state,
    subscribe(listener: (value: PluginDefaultsSnapshot) => void) {
      if (closed) throw new Error('默认启用已关闭');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      ++epoch;
      state = Object.freeze({ ...state, phase: 'closed' });
      listeners.clear();
      lifetime.abort();
    },
  };
}
