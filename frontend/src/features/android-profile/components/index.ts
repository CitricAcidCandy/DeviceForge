// Android录制的专用界面公开入口；纯数据门面不加载TSX。
export { ProfileFlamegraphView } from './ProfileFlamegraph/index.tsx';
export type { ProfileFlamegraphViewProps } from './ProfileFlamegraph/index.tsx';
export { closedFlameInterval } from './ProfileFlamegraph/interval.ts';
export type { FlameInterval } from './ProfileFlamegraph/interval.ts';
export { flameColor, flamePercent, layoutFlamegraph } from './ProfileFlamegraph/layout.ts';
export type { FlameBar, FlameLayout } from './ProfileFlamegraph/layout.ts';
export { ProfileArchiveView } from './ProfileArchiveView/index.tsx';
export { ProfileFrameView } from './ProfileFrameView/index.tsx';
export { ProfileStackList } from './ProfileStackList/index.tsx';
