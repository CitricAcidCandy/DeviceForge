import type { ThemeContribution } from '../../plugin-sdk/index.ts';

export interface ThemeAdapter {
  readonly apply: (theme: ThemeContribution | null) => void;
}
