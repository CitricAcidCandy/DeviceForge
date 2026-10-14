import { ApiError } from '../../../shared/api/index.ts';

export function checkArchiveCancellation(signal?: AbortSignal, logId: string | null = null): void {
  if (signal?.aborted) throw new ApiError('cancelled', 'cancelled', '录制归档解析等待已取消', null, logId);
}
