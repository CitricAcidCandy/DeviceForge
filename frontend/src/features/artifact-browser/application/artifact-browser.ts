import { ApiError } from '../../../shared/api/index.ts';
import type { ArchiveEntryQuery } from '../../../shared/api/index.ts';
import { abortable } from '../../../shared/api/abort.ts';
import { decodeEntries, decodeMetadata, decodeUpload, normalizeArtifactFilename, normalizeArtifactId, normalizeEntryQuery, requireArtifactBlob } from '../domain/rules.ts';
import { createArtifactBrowserState } from './state.ts';
import type { ArtifactBrowserGateway } from '../domain/types.ts';
export type * from '../domain/types.ts';
function queryError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('network', 'artifact_query_failed', '无法取得产物查询响应');
}
export function createArtifactBrowser(gateway: ArtifactBrowserGateway) {
  const state = createArtifactBrowserState();
  const unavailable = (kind: 'upload' | 'download'): ApiError => new ApiError('protocol', `artifact_${kind}_unavailable`, `当前产物网关未提供${kind === 'upload' ? '上传' : '下载'}能力`);
  return {
    select(id: string, signal: AbortSignal) {
      const artifactId = normalizeArtifactId(id);
      const context = state.beginSelection(artifactId, signal);
      return (async () => {
        try {
          state.assertCurrent(context);
          const result = await abortable(gateway.metadata(artifactId, context.signal), context.signal);
          state.assertCurrent(context, result.logId);
          const data = decodeMetadata(result.data, artifactId, result.logId);
          state.metadataSuccess(context, data, result.logId);
          return { data, logId: result.logId };
        } catch (error) { const failure = queryError(error); state.failure(context, failure); throw failure; }
      })();
    },
    page(query: ArchiveEntryQuery, signal: AbortSignal) {
      const normalized = normalizeEntryQuery(query);
      const context = state.beginPage(signal);
      if (!context.artifactId) throw new ApiError('protocol', 'artifact_not_selected', '请先选择并读取产物元数据');
      const artifactId = context.artifactId;
      return (async () => {
        try {
          state.assertCurrent(context);
          const result = await abortable(gateway.entries(artifactId, normalized, context.signal), context.signal);
          state.assertCurrent(context, result.logId);
          const data = decodeEntries(result.data, normalized, result.logId);
          state.entriesSuccess(context, data, result.logId);
          return { data, logId: result.logId };
        } catch (error) { const failure = queryError(error); state.failure(context, failure); throw failure; }
      })();
    },
    remove(id: string, signal: AbortSignal) {
      const artifactId = normalizeArtifactId(id);
      const context = state.beginRemoval(artifactId, signal);
      return (async () => {
        try {
          state.assertCurrent(context);
          const result = await abortable(gateway.remove(artifactId, context.signal), context.signal);
          state.assertCurrent(context, result.logId);
          const data = decodeMetadata(result.data, artifactId, result.logId);
          state.removeSuccess(context, result.logId);
          return { data, logId: result.logId };
        } catch (error) { const failure = queryError(error); state.failure(context, failure); throw failure; }
      })();
    },
    upload(filename: string, content: Blob, signal: AbortSignal) {
      const normalized = normalizeArtifactFilename(filename);
      if (!(content instanceof Blob)) throw new ApiError('protocol', 'invalid_artifact_content', '上传内容必须是 Blob');
      const upload = gateway.upload;
      if (!upload) throw unavailable('upload');
      const context = state.beginUpload(signal);
      return (async () => {
        try {
          state.assertCurrent(context);
          const result = await abortable(upload(normalized, content, context.signal), context.signal);
          state.assertCurrent(context, result.logId);
          const data = decodeUpload(result.data, normalized, content.size, result.logId);
          state.uploadSuccess(context, result.logId);
          return { data, logId: result.logId };
        } catch (error) { const failure = queryError(error); state.failure(context, failure); throw failure; }
      })();
    },
    download(id: string, signal: AbortSignal) {
      const artifactId = normalizeArtifactId(id);
      const download = gateway.download;
      if (!download) throw unavailable('download');
      const context = state.beginDownload(artifactId, signal);
      return (async () => {
        try {
          state.assertCurrent(context);
          const result = await abortable(download(artifactId, context.signal), context.signal);
          state.assertCurrent(context, result.logId);
          const data = requireArtifactBlob(result.data, result.logId);
          state.downloadSuccess(context, result.logId);
          return { data, logId: result.logId };
        } catch (error) { const failure = queryError(error); state.failure(context, failure); throw failure; }
      })();
    },
    snapshot: state.snapshot,
    subscribe: state.subscribe,
    clear: state.clear,
    dispose: state.dispose,
  };
}
