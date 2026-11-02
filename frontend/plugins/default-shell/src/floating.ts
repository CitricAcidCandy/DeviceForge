import type { WorkspaceFloatingView } from '@deviceforge/plugin-sdk';

export interface FloatingArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** 坐标始终相对画布或公开视图锚点；缩窗只调整显示，不擅自改写持久布局。 */
export function floatingPosition(view: WorkspaceFloatingView, area: FloatingArea) {
  const width = Math.min(view.width, Math.max(1, area.width));
  const height = Math.min(view.height, Math.max(1, area.height));
  const x = Math.min(Math.max(0, area.width - Math.min(120, width)), Math.max(0, view.x));
  const y = Math.min(Math.max(0, area.height - Math.min(80, height)), Math.max(0, view.y));
  return { x, y, width, height, left: area.x + x, top: area.y + y };
}
