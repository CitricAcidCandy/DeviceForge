import { prepareUpload } from './prepare.ts';
import type { PreparationRequest, PreparationResponse } from './types.ts';
import { isRecord } from '@deviceforge/business-kit/api';
import { isPublishEntry } from '../metadata-value.ts';

function request(value: unknown): value is PreparationRequest {
  return isRecord(value) && ['plugin', 'tool', 'config', 'distribution', 'resource'].includes(String(value.kind)) &&
    (value.metadata === undefined || isPublishEntry(value.metadata)) &&
    (value.localImport === undefined || typeof value.localImport === 'boolean') &&
    isRecord(value.selection) && ['file', 'directory', 'archive'].includes(String(value.selection.mode)) &&
    typeof value.selection.name === 'string' && Array.isArray(value.selection.files) &&
    value.selection.files.every((entry: unknown) => isRecord(entry) && typeof entry.path === 'string' && entry.file instanceof File);
}
function reply(value: PreparationResponse) { globalThis.postMessage(value); }
globalThis.onmessage = (event) => {
  const value: unknown = event.data;
  if (!request(value)) { reply({ ok: false, error: '上传准备请求格式不兼容' }); return; }
  void prepareUpload(value).then(
    result => reply({ ok: true, result }),
    reason => reply({ ok: false, error: reason instanceof Error ? reason.message : '上传内容准备失败' }),
  );
};
