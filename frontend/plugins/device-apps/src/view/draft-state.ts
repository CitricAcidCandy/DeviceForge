import { useCallback, useState } from 'react';
import type { DraftCell } from '../drafts.ts';

/** 更新时先写所属实例，卸载发生于同一轮提交也保留最后一次编辑。 */
export function useDraft<T>(cell: DraftCell<T>): [T, (next: T) => void] {
  const [value, update] = useState<T>(() => cell.value);
  const setValue = useCallback((next: T) => {
    cell.value = next;
    update(() => next);
  }, [cell]);
  return [value, setValue];
}
