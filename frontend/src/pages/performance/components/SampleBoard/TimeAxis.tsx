import { nearestSampleIndex, timelineRatio, timelineTicks } from './timeline.ts';
import type { BoardSample } from './types.ts';

export function TimeAxis({ samples, span, selected, onSelect, label }: {
  samples: readonly BoardSample[];
  span: number;
  selected: number;
  onSelect(index: number): void;
  label: string;
}) {
  const current = samples[selected];
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`${label}采样选择`}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, samples.length - 1)}
      aria-valuenow={Math.max(0, Math.min(samples.length - 1, selected))}
      aria-valuetext={current ? `采样点 ${selected + 1}，${current.t.toFixed(2)} 秒` : '尚无采样点'}
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      className="relative h-[18px] w-full rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      onKeyDown={(event) => {
        const next = event.key === 'ArrowLeft' ? Math.max(0, selected - 1)
          : event.key === 'ArrowRight' ? Math.min(samples.length - 1, selected + 1)
            : event.key === 'Home' ? 0
              : event.key === 'End' ? samples.length - 1 : null;
        if (next === null || samples.length === 0) return;
        event.preventDefault();
        onSelect(next);
      }}
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        if (box.width <= 0 || samples.length === 0) return;
        const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
        onSelect(nearestSampleIndex(samples, ratio * span));
      }}
    >
      {timelineTicks(span).map((time) => (
        <span key={time} className="absolute top-0 -translate-x-1/2 font-mono text-[10px] leading-[18px] text-muted-foreground" style={{ left: `${timelineRatio(time, span) * 100}%` }}>
          {Number.isInteger(time) ? time : time.toFixed(1)}s
        </span>
      ))}
    </div>
  );
}
