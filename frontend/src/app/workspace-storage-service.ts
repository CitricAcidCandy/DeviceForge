import { HostError } from '../plugin-sdk/models.ts';
import type { HostContext, JsonValue } from '../plugin-sdk/index.ts';
import type { ExtensionRegistry } from '../plugins/extensions/registry.ts';
import type { createWorkspaceStorage } from './workspace-storage.ts';

/** 持久化诊断属于平台能力，外壳经公开服务读取，不接触私有存储对象。 */
export function registerWorkspaceStorageService(
  registry: ExtensionRegistry,
  context: HostContext,
  storage: ReturnType<typeof createWorkspaceStorage> | null,
) {
  function status(): JsonValue {
    if (!storage) return {
      enabled: false, state: 'unavailable', source: 'unavailable', pending: false, lastError: null,
    };
    const state = storage.snapshot();
    return {
      enabled: true, state: state.state, source: state.source, pending: state.pending,
      lastError: state.lastError ? { code: state.lastError.code, message: state.lastError.message } : null,
    };
  }
  const release = registry.register({ pluginId: 'host', generation: 0, context }, {
    services: [{
      id: 'host.workspace.storage', version: '1',
      inputSchema: {
        type: 'object', required: ['action'], additionalProperties: false,
        properties: { action: { type: 'string', enum: ['status', 'retryRead', 'saveCurrent'] } },
      },
      invoke: async (input) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some((key) => key !== 'action'))
          throw new HostError('protocol', 'invalid_layout_storage_request', '布局存储请求无效');
        if (input.action !== 'status') {
          if (!storage) throw new HostError('protocol', 'layout_storage_unavailable', '布局持久化未启用');
          if (input.action === 'retryRead') storage.retryRead();
          else if (input.action === 'saveCurrent') storage.saveCurrent();
          else throw new HostError('protocol', 'invalid_layout_storage_request', '布局存储请求动作无效');
        }
        return { data: status(), logId: null };
      },
    }],
  });
  const unsubscribe = storage?.subscribe(() => {
    if (!context.signal.aborted) context.extensions?.emitEvent('host.workspace.storage.changed', status());
  });
  return () => {
    unsubscribe?.();
    return release();
  };
}
