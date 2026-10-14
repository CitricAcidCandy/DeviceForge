import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// 官方组件的样式合并入口，不承担业务规则。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
