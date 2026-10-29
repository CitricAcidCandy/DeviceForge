import type { Dispose } from '../plugin-sdk/models.ts';
import type { WorkspaceSavedState } from '../plugin-sdk/workspace.ts';

export interface WorkspaceStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface WorkspaceStorageRegistry {
  save(): WorkspaceSavedState;
  restore(value: unknown): void;
  hostAccess(): { subscribe(listener: () => void): Dispose };
}
export interface WorkspaceStorageDiagnostic {
  readonly code: 'read_failed' | 'invalid_source' | 'source_too_large' | 'write_failed' | 'snapshot_too_large' | 'snapshot_failed';
  readonly message: string;
}
export interface WorkspaceStorageSnapshot {
  /** blocked 只约束持久写入，工作区模型与插件操作保持可用。 */
  readonly state: 'ready' | 'blocked' | 'save_failed' | 'disposed';
  readonly source: 'empty' | 'restored' | 'invalid' | 'unavailable';
  readonly pending: boolean;
  readonly lastError: WorkspaceStorageDiagnostic | null;
}
export interface WorkspaceStorageOptions {
  readonly registry: WorkspaceStorageRegistry;
  readonly storage: WorkspaceStorageLike;
  readonly key: string;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

/** 存储边界只处理纯 JSON，既不打开视图，也不重放业务或自动删除旧草稿。 */
export function createWorkspaceStorage(options: WorkspaceStorageOptions) {
  if (!options.key.trim() || options.key.length > 512) throw new Error('工作区存储键不能为空或超过长度限制');
  const maxBytes = options.maxBytes ?? 1048576;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || maxBytes > 16777216)
    throw new Error('工作区存储上限必须为 128 字节至 16 MiB 的安全整数');
  const listeners = new Set<() => void>();
  const encoder = new TextEncoder();
  let state: WorkspaceStorageSnapshot = Object.freeze({ state: 'ready', source: 'empty', pending: false, lastError: null });
  let baseline: string | null = null;
  let writeBlocked = false;
  let disposed = false;
  let busy = false;
  let writing = false;
  let release: Dispose = () => {};
  function publish(next: WorkspaceStorageSnapshot) {
    if (state.state === next.state && state.source === next.source && state.pending === next.pending &&
        state.lastError?.code === next.lastError?.code) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个诊断消费方不影响工作区持久化。 */ }
    }
  }
  function failure(
    code: WorkspaceStorageDiagnostic['code'],
    message: string,
    source: WorkspaceStorageSnapshot['source'],
    block: boolean,
  ) {
    if (block) writeBlocked = true;
    publish({
      state: block ? 'blocked' : 'save_failed', source, pending: true,
      lastError: Object.freeze({ code, message }),
    });
  }
  function serialize(): string | null {
    try {
      const value = JSON.stringify(options.registry.save());
      if (value.length > maxBytes || encoder.encode(value).byteLength > maxBytes) {
        failure('snapshot_too_large', '当前布局超过存储大小限制，旧草稿已保留。', state.source, false);
        return null;
      }
      return value;
    } catch {
      failure('snapshot_failed', '无法读取当前布局快照，旧草稿已保留。', state.source, false);
      return null;
    }
  }
  function load(): boolean {
    if (disposed) return false;
    busy = true;
    try {
      let raw: string | null;
      try { raw = options.storage.getItem(options.key); }
      catch {
        failure('read_failed', '浏览器拒绝读取布局存储，当前工作区仍可使用。', 'unavailable', true);
        return false;
      }
      if (raw !== null && (raw.length > maxBytes || encoder.encode(raw).byteLength > maxBytes)) {
        failure('source_too_large', '保存的布局超过大小限制，原始草稿已保留。', 'invalid', true);
        return false;
      }
      if (raw !== null) {
        try {
          const value: unknown = JSON.parse(raw);
          options.registry.restore(value);
        } catch {
          failure('invalid_source', '保存的布局内容无效，原始草稿已保留，请重读或显式保存当前布局。', 'invalid', true);
          return false;
        }
      }
      const normalized = serialize();
      if (normalized === null) { writeBlocked = true; return false; }
      baseline = normalized;
      writeBlocked = false;
      publish({ state: 'ready', source: raw === null ? 'empty' : 'restored', pending: false, lastError: null });
      return true;
    } finally { busy = false; }
  }
  function save(force: boolean): boolean {
    if (disposed || busy || writing) return false;
    const serialized = serialize();
    if (serialized === null) return false;
    if (writeBlocked && !force) return false;
    if (state.state === 'save_failed' && !force) return false;
    if (!force && serialized === baseline) return true;
    writing = true;
    try {
      options.storage.setItem(options.key, serialized);
      baseline = serialized;
      writeBlocked = false;
      publish({ state: 'ready', source: state.source, pending: false, lastError: null });
      return true;
    } catch {
      failure('write_failed', '浏览器拒绝保存布局，编辑仍保留在当前工作区，可显式重试保存。', state.source, false);
      return false;
    } finally { writing = false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    options.signal?.removeEventListener('abort', dispose);
    release();
    publish({ ...state, state: 'disposed' });
    listeners.clear();
  }
  if (options.signal?.aborted) dispose();
  else {
    load();
    release = options.registry.hostAccess().subscribe(() => {
      if (busy || disposed) return;
      if (writeBlocked || state.state === 'save_failed') {
        publish({ ...state, pending: true });
        return;
      }
      save(false);
    });
    options.signal?.addEventListener('abort', dispose, { once: true });
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void): Dispose {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** 用户明确选择重新读取；成功时以持久草稿替换当前布局，但不重放动作。 */
    retryRead: load,
    /** 用户明确选择保存当前布局，可覆盖损坏源或重试失败写入。 */
    saveCurrent: () => save(true),
    dispose,
  };
}
