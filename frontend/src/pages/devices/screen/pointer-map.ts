/*
 * 点击落到设备坐标：画面在容器里是「等比铺满 + 居中」的（<video> 走 object-fit: contain，
 * <canvas> 走 max-width/height 保持比例），所以元素矩形不等于画面矩形。
 * 直接拿元素宽度换算，点偏在留白带里就会被算到设备边缘；放大缩小后更明显——必须换算到真正被画面占满的那块。
 */
export type FrameSize = { readonly width: number; readonly height: number };

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

export function devicePoint(
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  size: FrameSize,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const scale = Math.min(rect.width / size.width, rect.height / size.height) || 1;
  const drawnWidth = size.width * scale;
  const drawnHeight = size.height * scale;
  const left = rect.left + (rect.width - drawnWidth) / 2;
  const top = rect.top + (rect.height - drawnHeight) / 2;
  const x = Math.round(((clientX - left) / drawnWidth) * size.width);
  const y = Math.round(((clientY - top) / drawnHeight) * size.height);
  return { x: clamp(x, 0, size.width - 1), y: clamp(y, 0, size.height - 1) };
}
