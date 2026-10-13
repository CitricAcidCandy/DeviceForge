import type { Dispose } from './models.ts';

export type ThemeColorScheme = 'light' | 'dark' | 'normal';
export interface ThemeContribution {
  readonly id: string;
  readonly title: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly css?: string;
  readonly colorScheme?: ThemeColorScheme;
}
export interface ThemeInfo {
  readonly id: string;
  readonly title: string;
  readonly pluginId: string;
  readonly generation: number;
  readonly colorScheme?: ThemeColorScheme;
}
export interface ThemeSnapshot {
  readonly themes: readonly ThemeInfo[];
  readonly selected: ThemeInfo | null;
}
export interface ThemeAccess {
  readonly snapshot: () => ThemeSnapshot;
  readonly select: (id: string | null) => void;
  readonly subscribe: (listener: (snapshot: ThemeSnapshot) => void) => Dispose;
}
