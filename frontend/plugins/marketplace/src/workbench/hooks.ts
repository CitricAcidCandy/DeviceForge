export { useAction, useSnapshot, ActionFeedback } from '@deviceforge/business-kit/react';
import { readHostError } from '@deviceforge/plugin-sdk';
export function errorLogId(error: unknown): string | null {
  const host = readHostError(error);
  if (host?.logId) return host.logId;
  if (!error || typeof error !== 'object') return null;
  for (const key of ['lastKnownLogId', 'submitLogId']) {
    try { const value: unknown = Reflect.get(error, key); if (typeof value === 'string') return value; }
    catch { return null; }
  }
  return null;
}
