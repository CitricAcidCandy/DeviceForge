import { useEffect, useRef, useState } from 'react';
import { chartValue, fpsDomain, fpsValue, metricDomain } from './chart-domain.ts';
import { FrameStrip } from './FrameStrip.tsx';
import { MetricPanel } from './MetricPanel.tsx';
import { StackSection } from './StackSection.tsx';
import { selectedTimelineScrollLeft, TIMELINE_LAYOUT, timelineRatio } from './timeline.ts';
import type { SampleBoardProps } from './types.ts';

const CPU_COLOR = '#2F7FE0';
const FPS_COLOR = '#6C4CF5';
const MEMORY_COLOR = '#168577';
const RSS_COLOR = '#8C7BF7';
const gib = (value: number | null) => value === null ? null : value / 1024 / 1024;

export function SampleBoard(props: SampleBoardProps) {
  const { samples, span, selected, onSelect, stackNote } = props;
  const canvas = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(TIMELINE_LAYOUT.minWidth);
  const [viewportWidth, setViewportWidth] = useState(0);
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0) setWidth(node.clientWidth);
      setViewportWidth(viewport.current?.clientWidth ?? 0);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [samples.length > 0]);
  const currentTime = samples[selected]?.t;
  useEffect(() => {
    const node = viewport.current;
    if (!node || currentTime === undefined) return;
    const plotWidth = Math.max(1, width - TIMELINE_LAYOUT.left - TIMELINE_LAYOUT.right);
    const pointX = TIMELINE_LAYOUT.left + timelineRatio(currentTime, span) * plotWidth;
    const next = selectedTimelineScrollLeft(pointX, viewportWidth, node.scrollLeft, width);
    if (node.scrollLeft !== next) node.scrollLeft = next;
  }, [selected, currentTime, span, width, viewportWidth]);
  if (samples.length === 0) return (
    <div aria-label="等待采样数据" className="flex min-h-[120px] flex-1 items-center justify-center rounded-[10px] border border-hairline bg-card">
      <p role="status" className="text-[14px] text-muted-foreground">尚无采样数据</p>
    </div>
  );
  const current = samples[selected];
  const fps = fpsValue(current?.fps ?? null);
  const cpu = chartValue(current?.cpu ?? null);
  const pss = gib(chartValue(current?.pssKib ?? null));
  const rss = gib(chartValue(current?.rssKib ?? null));
  const fpsValues = samples.flatMap((sample) => { const value = fpsValue(sample.fps); return value === null ? [] : [value]; });
  const average = fpsValues.length ? fpsValues.reduce((total, value) => total + value, 0) / fpsValues.length : null;
  const low = fpsValues.reduce<number | null>((minimum, value) => Math.min(minimum ?? value, value), null);
  const cpus = samples.map((sample) => chartValue(sample.cpu));
  const cpuPeak = cpus.reduce<number | null>((peak, value) => value === null ? peak : Math.max(peak ?? value, value), null);
  const pssPoints = samples.map((sample) => ({ x: sample.t, y: chartValue(sample.pssKib) }));
  const rssPoints = samples.map((sample) => ({ x: sample.t, y: chartValue(sample.rssKib) }));
  return (
    <div ref={viewport} aria-label="采样数据面板" className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain" data-performance-board>
      {/* 所有章节只共享透明滚动区；整幅横向画布移动，画面与指标不能分别横向滚动。 */}
      <div ref={canvas} className="flex min-w-[1132px] flex-col gap-4 pb-1" data-shared-time-canvas>
        <FrameStrip {...props} plotWidth={Math.max(1, width - TIMELINE_LAYOUT.left - TIMELINE_LAYOUT.right)} />
        <MetricPanel label="帧率" chartLabel="帧率曲线" value={fps === null ? '—' : fps.toFixed(1)} unit="fps"
          detail={average === null || low === null ? '帧率未采集' : `平均 ${average.toFixed(1)} · 最低 ${low.toFixed(1)}`}
          color={FPS_COLOR} domain={fpsDomain(samples.map((sample) => sample.fps))}
          series={[{ id: 'fps', points: samples.map((sample) => ({ x: sample.t, y: fpsValue(sample.fps) })), color: FPS_COLOR, width: 1.8, warnBelow: 50 }]}
          samples={samples} span={span} selected={selected} onSelect={onSelect} empty="无帧率" />
        <MetricPanel label="CPU" chartLabel="CPU 占用曲线" value={cpu === null ? '—' : cpu.toFixed(0)} unit="%"
          detail={cpuPeak === null ? '应用 CPU 未采集' : `应用 CPU · 峰值 ${cpuPeak.toFixed(0)}%`}
          color={CPU_COLOR} domain={metricDomain(cpus)}
          series={[{ id: 'CPU', points: samples.map((sample) => ({ x: sample.t, y: chartValue(sample.cpu) })), color: CPU_COLOR, width: 1.8 }]}
          samples={samples} span={span} selected={selected} onSelect={onSelect} empty="无 CPU 观测" />
        <MetricPanel label="内存" chartLabel="内存曲线" value={pss === null ? '—' : pss.toFixed(2)} unit="GB"
          detail={<><span>PSS · </span><span aria-label="RSS当前读数">{rss === null ? 'RSS 未采集' : `RSS ${rss.toFixed(2)} GB`}</span></>}
          color={MEMORY_COLOR} domain={metricDomain([...pssPoints, ...rssPoints].map((point) => point.y))}
          formatAxis={(value) => (value / 1024 / 1024).toFixed(2)}
          series={[{ id: 'PSS', points: pssPoints, color: MEMORY_COLOR, width: 1.8 }, { id: 'RSS', points: rssPoints, color: RSS_COLOR, width: 1.2, dashed: true, opacity: 0.9 }]}
          samples={samples} span={span} selected={selected} onSelect={onSelect} empty="无内存观测" />
        <StackSection sample={current} selected={selected} note={stackNote} />
        {current?.frameNote && <p className="px-1 text-[11px] leading-5 text-muted-foreground">画面关联：{current.frameNote}</p>}
      </div>
    </div>
  );
}
