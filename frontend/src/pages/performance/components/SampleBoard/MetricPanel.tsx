import type { ReactNode } from 'react';
import { MultiTrackChart } from '../../../../components/MultiTrackChart/index.tsx';
import type { ChartSeries } from '../../../../components/MultiTrackChart/index.tsx';
import { areaSegments, nearestSampleIndex, timelineRatio } from './timeline.ts';
import { TimeAxis } from './TimeAxis.tsx';
import type { BoardSample } from './types.ts';

export function MetricPanel({ label, chartLabel, value, unit, detail, color, domain, series, samples, span, selected, onSelect, empty, formatAxis }: {
  label: string;
  chartLabel: string;
  value: string;
  unit: string;
  detail: ReactNode;
  color: string;
  domain: readonly [number, number];
  series: readonly ChartSeries[];
  samples: readonly BoardSample[];
  span: number;
  selected: number;
  onSelect(index: number): void;
  empty: string;
  formatAxis?(value: number): string;
}) {
  const hasData = series.some((line) => line.points.some((point) => point.y !== null));
  const axis = formatAxis ?? ((number: number) => Number.isInteger(number) ? String(number) : number.toFixed(1));
  const primaryPoints = series[0]?.points ?? [];
  const current = primaryPoints[selected];
  const currentY = current?.y;
  const currentRatio = currentY === null || currentY === undefined || domain[1] <= domain[0]
    ? null : Math.max(0, Math.min(1, (currentY - domain[0]) / (domain[1] - domain[0])));
  return (
    <section aria-label={`${label}指标`} className="relative h-[108px] shrink-0 rounded-[10px] border border-hairline bg-card">
      <div className="absolute top-3 left-5 flex items-center gap-2">
        <span className={`size-1.5 rounded-full ${label === '帧率' ? 'bg-primary' : label === 'CPU' ? 'bg-info' : 'bg-success'}`} aria-hidden="true" />
        <h3 className="text-[14px]! leading-6! font-medium! text-ink">{label}</h3>
      </div>
      <div className="absolute top-[37px] left-5 flex items-baseline gap-2" aria-label={label === '内存' ? 'PSS当前读数' : `${label}当前读数`}>
        <span className="font-mono text-[26px] leading-8 font-medium text-ink">{value}</span>
        <span className="text-[12px] text-muted-foreground">{unit}</span>
      </div>
      <div className="absolute top-[79px] left-5 max-w-[182px] truncate text-[11px] leading-[19px] text-muted-foreground">{detail}</div>
      <div className="absolute top-[19px] right-[60px] left-[224px] h-[58px]" data-time-domain={`0:${Math.max(span, 0.001)}`}>
        {[1, 0.5, 0].map((fraction) => (
          <span key={fraction} className="pointer-events-none absolute -left-[42px] w-[31px] -translate-y-1/2 text-right font-mono text-[10px] leading-5 text-muted-foreground" style={{ top: `${(1 - fraction) * 100}%` }}>
            {axis(domain[0] + (domain[1] - domain[0]) * fraction)}
          </span>
        ))}
        {hasData && <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full! w-full! overflow-visible" viewBox="0 0 1000 100" preserveAspectRatio="none">
          {areaSegments(primaryPoints, span, domain).map((path, index) => <path key={index} d={path} fill={color} opacity={0.045} />)}
        </svg>}
        {hasData ? (
          <MultiTrackChart
            ariaLabel={chartLabel}
            xDomain={[0, Math.max(span, 0.001)]}
            insets={{ left: 0, right: 0 }}
            cursorX={samples[selected]?.t ?? null}
            onPickX={(time) => onSelect(nearestSampleIndex(samples, time))}
            tracks={[{ id: label === '帧率' ? 'fps' : label === 'CPU' ? 'cpu' : 'memory', domain, splitLine: true, series }]}
          />
        ) : <p className="pt-4 text-[13px] leading-6 text-muted-foreground">{empty}</p>}
        {current && currentRatio !== null && <span aria-hidden="true" className="pointer-events-none absolute size-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-card" style={{ left: `${timelineRatio(current.x, span) * 100}%`, top: `${(1 - currentRatio) * 100}%`, backgroundColor: color }} />}
      </div>
      <div className="absolute top-[83px] right-[60px] left-[224px]">
        <TimeAxis samples={samples} span={span} selected={selected} onSelect={onSelect} label={label} />
      </div>
    </section>
  );
}
