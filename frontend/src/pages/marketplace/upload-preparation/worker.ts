import { prepareUpload } from './prepare.ts';
import type { PreparationRequest, PreparationResponse } from './types.ts';

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<PreparationRequest>) => void) | null;
  postMessage: (message: PreparationResponse) => void;
};
workerScope.onmessage = event => {
  void prepareUpload(event.data).then(
    result => workerScope.postMessage({ ok: true, result }),
    reason => workerScope.postMessage({ ok: false, error: reason instanceof Error ? reason.message : '上传内容准备失败' }),
  );
};
