import { ApiError } from '../../../services/api/index.ts';
import type {
  ArtifactBrowserSnapshot,
  ArtifactEntriesView,
  ArtifactMetadataView,
} from '../types/index.ts';

export interface ArtifactBrowserRequest {
  readonly revision: number;
  readonly artifactId: string | null;
  readonly kind: 'metadata' | 'entries' | 'remove' | 'upload' | 'download';
  readonly signal: AbortSignal;
}
const empty = (): ArtifactBrowserSnapshot =>
  Object.freeze({
    selection: null,
    metadata: null,
    page: null,
    loading: null,
    error: null,
    metadataLogId: null,
    entriesLogId: null,
    removeLogId: null,
    uploadLogId: null,
    downloadLogId: null,
  });
export function createArtifactBrowserState() {
  let state = empty();
  let revision = 0;
  let closed = false;
  let request = new AbortController();
  const lifetime = new AbortController();
  const listeners = new Set<(snapshot: ArtifactBrowserSnapshot) => void>();
  const assertOpen = () => {
    if (closed) throw new ApiError('cancelled', 'artifact_browser_closed', '产物浏览已关闭');
  };
  const latest = (context: ArtifactBrowserRequest) =>
    !closed &&
    context.revision === revision &&
    (context.kind === 'remove' ||
      context.kind === 'upload' ||
      context.kind === 'download' ||
      context.artifactId === state.selection);
  function assertCurrent(context: ArtifactBrowserRequest, logId: string | null = null): void {
    if (!latest(context) || context.signal.aborted)
      throw new ApiError('cancelled', 'stale_result', '产物浏览请求已取消或撤销', null, logId);
  }
  function publish(next: ArtifactBrowserSnapshot): void {
    state = Object.freeze(next);
    const admitted = revision;
    for (const listener of [...listeners]) {
      if (admitted !== revision || closed) break;
      if (!listeners.has(listener)) continue;
      try {
        listener(state);
      } catch {}
    }
  }
  function begin(
    artifactId: string,
    kind: ArtifactBrowserRequest['kind'],
    signal: AbortSignal,
  ): ArtifactBrowserRequest {
    assertOpen();
    if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物浏览请求等待已取消');
    request.abort();
    request = new AbortController();
    const context = Object.freeze({
      revision: ++revision,
      artifactId,
      kind,
      signal: AbortSignal.any([signal, request.signal, lifetime.signal]),
    });
    const previous = kind === 'metadata' ? empty() : state;
    publish({
      ...previous,
      selection: artifactId,
      page: null,
      loading: kind,
      error: null,
      entriesLogId: null,
      ...(kind === 'metadata' ? { metadataLogId: null } : {}),
      ...(kind === 'entries' ? { entriesLogId: null } : {}),
      ...(kind === 'remove' ? { removeLogId: null } : {}),
      ...(kind === 'upload' ? { uploadLogId: null } : {}),
      ...(kind === 'download' ? { downloadLogId: null } : {}),
    });
    assertCurrent(context);
    return context;
  }
  return {
    snapshot: () => state,
    assertCurrent,
    beginSelection: (id: string, signal: AbortSignal) => begin(id, 'metadata', signal),
    beginPage(signal: AbortSignal) {
      assertOpen();
      if (!state.selection || !state.metadata)
        throw new ApiError('protocol', 'artifact_not_selected', '请先选择并读取产物元数据');
      if (state.metadata.media_type !== 'application/zip')
        throw new ApiError('protocol', 'artifact_not_archive', '当前产物不是 ZIP 容器');
      return begin(state.selection, 'entries', signal);
    },
    beginRemoval(id: string, signal: AbortSignal) {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物删除请求等待已取消');
      request.abort();
      request = new AbortController();
      const context = Object.freeze({
        revision: ++revision,
        artifactId: id,
        kind: 'remove' as const,
        signal: AbortSignal.any([signal, request.signal, lifetime.signal]),
      });
      publish({ ...state, loading: 'remove', error: null, removeLogId: null });
      assertCurrent(context);
      return context;
    },
    beginUpload(signal: AbortSignal) {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物上传请求等待已取消');
      request.abort();
      request = new AbortController();
      const context = Object.freeze({
        revision: ++revision,
        artifactId: null,
        kind: 'upload' as const,
        signal: AbortSignal.any([signal, request.signal, lifetime.signal]),
      });
      publish({ ...state, loading: 'upload', error: null, uploadLogId: null });
      assertCurrent(context);
      return context;
    },
    beginDownload(id: string, signal: AbortSignal) {
      assertOpen();
      if (signal.aborted) throw new ApiError('cancelled', 'cancelled', '产物下载请求等待已取消');
      request.abort();
      request = new AbortController();
      const context = Object.freeze({
        revision: ++revision,
        artifactId: id,
        kind: 'download' as const,
        signal: AbortSignal.any([signal, request.signal, lifetime.signal]),
      });
      publish({ ...state, loading: 'download', error: null, downloadLogId: null });
      assertCurrent(context);
      return context;
    },
    metadataSuccess(
      context: ArtifactBrowserRequest,
      metadata: ArtifactMetadataView,
      logId: string | null,
    ) {
      assertCurrent(context, logId);
      publish({ ...state, metadata, loading: null, error: null, metadataLogId: logId });
      assertCurrent(context, logId);
    },
    entriesSuccess(
      context: ArtifactBrowserRequest,
      page: ArtifactEntriesView,
      logId: string | null,
    ) {
      assertCurrent(context, logId);
      publish({ ...state, page, loading: null, error: null, entriesLogId: logId });
      assertCurrent(context, logId);
    },
    removeSuccess(context: ArtifactBrowserRequest, logId: string | null) {
      assertCurrent(context, logId);
      publish(
        context.artifactId === state.selection
          ? { ...empty(), removeLogId: logId }
          : { ...state, loading: null, error: null, removeLogId: logId },
      );
      assertCurrent(context, logId);
    },
    uploadSuccess(context: ArtifactBrowserRequest, logId: string | null) {
      assertCurrent(context, logId);
      publish({ ...state, loading: null, error: null, uploadLogId: logId });
      assertCurrent(context, logId);
    },
    downloadSuccess(context: ArtifactBrowserRequest, logId: string | null) {
      assertCurrent(context, logId);
      publish({ ...state, loading: null, error: null, downloadLogId: logId });
      assertCurrent(context, logId);
    },
    failure(context: ArtifactBrowserRequest, error: ApiError) {
      if (!latest(context)) return;
      publish({
        ...state,
        loading: null,
        error,
        ...(context.kind === 'metadata'
          ? { metadataLogId: error.logId }
          : context.kind === 'entries'
            ? { entriesLogId: error.logId }
            : context.kind === 'remove'
              ? { removeLogId: error.logId }
              : context.kind === 'upload'
                ? { uploadLogId: error.logId }
                : { downloadLogId: error.logId }),
      });
    },
    clear() {
      assertOpen();
      ++revision;
      request.abort();
      publish(empty());
    },
    subscribe(listener: (snapshot: ArtifactBrowserSnapshot) => void) {
      assertOpen();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (closed) return;
      closed = true;
      ++revision;
      request.abort();
      lifetime.abort();
      state = empty();
      listeners.clear();
    },
  };
}
