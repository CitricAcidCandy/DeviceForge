import { HostError } from '../../plugin-sdk/index.ts';
import { ApiError } from '../../shared/api/index.ts';
import { abortable } from '../../shared/api/abort.ts';
import { androidInputAction, normalizeAndroidInput } from './rules.ts';
import { decodeAndroidInputResult } from './results.ts';
import type { AndroidInputDevices, AndroidInputResult, AndroidUnicodeInput } from './types.ts';

export type * from './types.ts';

export function createAndroidUnicodeInput(devices: AndroidInputDevices) {
  const lifetime = new AbortController();
  const current = (signal: AbortSignal) => AbortSignal.any([signal, lifetime.signal]);
  return {
    async send(input: AndroidUnicodeInput, signal: AbortSignal): Promise<{ readonly data: AndroidInputResult; readonly logId: string | null }> {
      const normalized = normalizeAndroidInput(input);
      const action = androidInputAction(devices.snapshot(), normalized);
      const request = devices.invoke(action, current(signal));
      return abortable(request, current(signal)).then((response) => ({
        data: decodeAndroidInputResult(response.data, normalized, normalized.bytes, action.deviceId ?? '', response.logId), logId: response.logId,
      })).catch((error: unknown) => {
        if (error instanceof HostError) throw error;
        if (error instanceof ApiError) throw new HostError(error.kind, error.code, error.message, error.logId, error.status, error.retryAfter);
        throw new HostError('network', 'android_input_request_failed', 'Android 输入请求未完成');
      });
    },
    dispose() { lifetime.abort(); },
  };
}
