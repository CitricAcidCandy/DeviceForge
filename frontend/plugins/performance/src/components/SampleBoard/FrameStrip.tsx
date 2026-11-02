import { timelineRatio, visibleFrameIndices } from './timeline.ts';
import type { SampleBoardProps } from './types.ts';

export function FrameStrip({ samples, span, selected, onSelect, frameNote, plotWidth }: SampleBoardProps & { plotWidth: number }) {
  const current = samples[selected];
  const visible = visibleFrameIndices(samples, span, plotWidth, selected);
  const frameCount = samples.filter((sample) => sample.frameUrl !== null).length;
  const association = current?.frameNote ?? frameNote;
  return (
    <section aria-label="采样画面面板" className="relative h-[168px] shrink-0 rounded-[10px] border border-hairline bg-card">
      <h3 className="absolute top-3 left-5 text-[14px]! leading-6! font-medium! text-ink">采样画面</h3>
      <p className="absolute top-[13px] right-8 text-[12px] leading-[22px] text-muted-foreground" title={association}>
        {association.includes('近邻') || association.includes('按时间') ? '按时间关联 · ' : ''}{frameCount}/{samples.length} 点有画面
      </p>
      <div className="absolute top-12 left-5 w-[184px]">
        <p className="text-[12px] leading-[22px] text-muted-foreground">当前采样点</p>
        <p className="mt-0.5! font-mono text-[25px] leading-[30px] font-medium text-ink">#{selected + 1}</p>
        <p className="mt-1.5! font-mono text-[13px] leading-6 text-primary">{current?.t.toFixed(2) ?? '—'} s</p>
        <p className="mt-1! truncate text-[11px] leading-[18px] text-muted-foreground" title={current?.frameUrl ? association : '当前采样点无画面'}>
          {current?.frameUrl ? '点击画面定位指标' : '当前采样点无画面'}
        </p>
      </div>
      <div className="absolute top-[55px] right-[60px] left-[224px] h-[101px]" role="group" aria-label="采样画面">
        {current && <span aria-hidden="true" className="pointer-events-none absolute -top-2 h-[112px] w-[102px] -translate-x-1/2 rounded-[7px] bg-primary/5" style={{ left: `${timelineRatio(current.t, span) * 100}%` }} />}
        {visible.length === 0 ? (
          <p className="pt-5 text-[13px] leading-6 text-muted-foreground">{frameNote}</p>
        ) : visible.map((index) => {
          const sample = samples[index];
          if (!sample?.frameUrl) return null;
          return (
            <button
              key={sample.id}
              type="button"
              onClick={() => onSelect(index)}
              aria-label={`采样画面 ${index + 1}，${sample.t.toFixed(2)} 秒`}
              aria-pressed={index === selected}
              data-sample-index={index}
              data-current={index === selected}
              title={`#${index + 1} · ${sample.t.toFixed(2)} s${sample.frameNote ? ` · ${sample.frameNote}` : ''}`}
              className="absolute top-0 w-[90px] -translate-x-1/2 rounded-[4px] text-[11px]! outline-none data-[current=true]:text-primary focus-visible:ring-2 focus-visible:ring-primary"
              style={{ left: `${timelineRatio(sample.t, span) * 100}%` }}
            >
              <img src={sample.frameUrl} alt="" loading="lazy" className="h-[51px] w-[90px] rounded-[4px] border border-hairline-strong object-contain data-[current=true]:border-primary" data-current={index === selected} />
              <span className="mt-1 block font-mono leading-5">#{index + 1}</span>
              <span className="mx-auto my-0.5 block size-1 rounded-full bg-current" aria-hidden="true" />
              <span className="block font-mono leading-[19px]">{Number.isInteger(sample.t) ? sample.t : sample.t.toFixed(1)} s</span>
            </button>
          );
        })}
      </div>
      {current?.frameNote && (
        <span className="sr-only" role="status">当前画面关联说明：{current.frameNote}</span>
      )}
    </section>
  );
}
