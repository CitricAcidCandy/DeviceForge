/** 非有限指标保留为缺测，不补零或插值。 */
export function chartValue(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function fpsValue(value: number | null): number | null {
  const finite = chartValue(value);
  return finite !== null && finite >= 0 ? finite : null;
}

/** 从零起画，优先使用常见帧率档位；超出档位仍按实际峰值扩展。 */
export function fpsDomain(values: readonly (number | null)[]): readonly [number, number] {
  const peak = values.reduce<number>((top, value) => Math.max(top, fpsValue(value) ?? 0), 0);
  const ceiling = [30, 60, 90, 120, 144, 165, 180, 240, 360, 480].find((top) => top >= peak);
  if (ceiling !== undefined) return [0, ceiling];
  const step = 10 ** Math.floor(Math.log10(peak)) / 2;
  const rounded = Math.ceil(peak / step) * step;
  return [0, Number.isFinite(rounded) ? Math.max(peak, rounded) : peak];
}

export function metricDomain(values: readonly (number | null)[]): readonly [number, number] {
  let floor = 0;
  let ceiling = 1;
  for (const value of values) {
    const finite = chartValue(value);
    if (finite === null) continue;
    floor = Math.min(floor, finite);
    ceiling = Math.max(ceiling, finite);
  }
  return [floor, ceiling];
}
