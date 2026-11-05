import type { HostContext } from '@deviceforge/plugin-sdk';

const key = 'deviceforge_devices.directory-observation';
export type DirectoryReadStatus = 'pending' | 'confirmed' | 'failed' | 'unconfirmed' | 'unavailable';
export interface DirectoryObservation {
  readonly requestId: string;
  readonly status: DirectoryReadStatus;
  readonly message: string | null;
  readonly logId: string | null;
}
const unconfirmed: DirectoryObservation = Object.freeze({
  requestId: '', status: 'unconfirmed', message: null, logId: null,
});

/** 只保存本插件的读取事实，不把空数组解释成成功的空目录。 */
export function readDirectoryObservation(context: HostContext): DirectoryObservation {
  const value = context.extensions?.getState(key);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.requestId !== 'string' ||
      value.status !== 'pending' && value.status !== 'confirmed' && value.status !== 'failed' &&
      value.status !== 'unconfirmed' && value.status !== 'unavailable' ||
      value.message !== null && typeof value.message !== 'string' ||
      value.logId !== null && typeof value.logId !== 'string') return unconfirmed;
  return { requestId: value.requestId, status: value.status, message: value.message, logId: value.logId };
}

export function subscribeDirectoryObservation(context: HostContext, notify: () => void) {
  return context.extensions?.subscribeState(key, notify) ?? (() => {});
}

/** 后发读取取得提示归属；旧取消、超时与晚到结果都不能覆盖它。 */
export function beginDirectoryObservation(context: HostContext, status: DirectoryReadStatus = 'pending') {
  const requestId = crypto.randomUUID();
  if (!context.signal.aborted)
    context.extensions?.setState(key, { requestId, status, message: null, logId: null });
  return {
    finish(next: Exclude<DirectoryReadStatus, 'pending'>, message: string | null = null, logId: string | null = null) {
      if (context.signal.aborted || readDirectoryObservation(context).requestId !== requestId) return;
      context.extensions?.setState(key, { requestId, status: next, message, logId });
    },
  };
}
