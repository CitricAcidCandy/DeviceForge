import type { PreparationRequest, PreparationResponse, PreparedUpload, UploadInspection } from './types.ts';
export type { UploadSelection, UploadInspection, PreparedUpload, PreparationRequest } from './types.ts';
export type PreparationExecutor = (request: PreparationRequest, signal: AbortSignal) => Promise<UploadInspection | PreparedUpload>;

export const runUploadPreparation: PreparationExecutor = (request, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const timer = setTimeout(() => {
    finish(); reject(new Error('上传准备超过 120 秒，请减少文件后重试'));
  }, 120_000);
  function finish() { clearTimeout(timer); signal.removeEventListener('abort', cancel); worker.terminate(); }
  function cancel() { finish(); reject(signal.reason ?? new DOMException('已取消打包', 'AbortError')); }
  signal.addEventListener('abort', cancel, { once: true });
  worker.onmessage = (event: MessageEvent<PreparationResponse>) => {
    finish();
    if (signal.aborted) { reject(signal.reason); return; }
    if (event.data.ok) resolve(event.data.result);
    else reject(new Error(event.data.error));
  };
  worker.onerror = () => { finish(); reject(new Error('上传打包线程失败，请检查归档内容')); };
  try { worker.postMessage(request); }
  catch (error) { finish(); reject(error); }
});
