import type { StackSample } from '../../../../features/android-profile/index.ts';

/** 一个原始采样点的显示值；实时画面映射保留来源说明，组件不自行借用或复制邻帧。 */
export interface BoardSample {
  readonly id: string;
  readonly t: number;
  readonly fps: number | null;
  readonly cpu: number | null;
  readonly pssKib: number | null;
  readonly rssKib: number | null;
  readonly frameUrl: string | null;
  readonly frameNote?: string;
  readonly stacks: readonly StackSample[];
  readonly note: string | null;
}

export interface SampleBoardProps {
  readonly samples: readonly BoardSample[];
  readonly span: number;
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  readonly frameNote: string;
  readonly stackNote: string;
}
