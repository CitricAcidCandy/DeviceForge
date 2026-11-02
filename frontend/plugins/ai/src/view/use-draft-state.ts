import { useCallback, useState } from 'react';
import type { AiDraft } from '../services.ts';

/** 在事件提交时同步草稿，DOM 重挂仍读取同一工作区实例的数据。 */
export function useDraftState<Key extends keyof AiDraft>(
  draft: AiDraft, key: Key,
): [AiDraft[Key], (value: AiDraft[Key]) => void] {
  const [value, update] = useState(() => draft[key]);
  const set = useCallback((next: AiDraft[Key]) => { draft[key] = next; update(next); }, [draft, key]);
  return [value, set];
}
