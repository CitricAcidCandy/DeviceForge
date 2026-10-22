import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AxisPointerComponent, GridComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, GridComponent, AxisPointerComponent, CanvasRenderer]);

/** 画布解析不了 CSS 变量，这里的取值与 styles.css 的令牌保持一致。 */
const COLOR = {
  primary: '#6c4cf5',
  warning: '#d98a00',
  hairline: '#e6eaf3',
  textFaint: '#a3acbc',
} as const;

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface ChartSeries {
  readonly id: string;
  readonly points: readonly ChartPoint[];
  /** 低于该值的点单独标色，用于掉帧这类异常。 */
  readonly warnBelow?: number;
  readonly opacity?: number;
  readonly width?: number;
}

export interface ChartTrack {
  readonly id: string;
  readonly series: readonly ChartSeries[];
  /** 纵向量程；不给则按数据自适应。 */
  readonly domain?: readonly [number, number];
  /** 占高权重，默认 1。 */
  readonly weight?: number;
  /** 是否画横向网格线，默认不画（外部行分隔线已经表达了区间）。 */
  readonly splitLine?: boolean;
}

export interface MultiTrackChartProps {
  readonly tracks: readonly ChartTrack[];
  readonly xDomain: readonly [number, number];
  /** 左右留白用像素写死，绘图区因此可以和外面的 DOM 行严格对齐。 */
  readonly insets: { readonly left: number; readonly right: number };
  readonly gap?: number;
  readonly cursorX?: number | null;
  readonly onPickX?: (x: number) => void;
  readonly ariaLabel: string;
  /** 是否在最底部网格画时间刻度；外部已有时间轴轨时关掉。 */
  readonly showXAxis?: boolean;
  readonly className?: string;
}

/**
 * 多轨时序图：一个 ECharts 实例里堆叠多个 grid，共用一条 x 轴，
 * 游标通过 axisPointer.link 联动。用于「性能与调用栈」这类仪器面板，
 * 也可以只传一条轨当普通折线图复用。
 */
export function MultiTrackChart({
  tracks,
  xDomain,
  insets,
  gap = 6,
  cursorX,
  onPickX,
  ariaLabel,
  showXAxis = false,
  className,
}: MultiTrackChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setBox({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const option = useMemo(() => {
    const totalWeight = tracks.reduce((sum, track) => sum + (track.weight ?? 1), 0) || 1;
    const gaps = Math.max(0, tracks.length - 1) * gap;
    const usable = Math.max(0, box.height - gaps);
    let offset = 0;
    const grids = tracks.map((track) => {
      const height = (usable * (track.weight ?? 1)) / totalWeight;
      const top = offset;
      offset += height + gap;
      return { left: insets.left, right: insets.right, top, height };
    });
    return {
      animation: false,
      backgroundColor: 'transparent',
      tooltip: { show: false },
      axisPointer: {
        triggerOn: 'mousemove',
        link: [{ xAxisIndex: 'all' }],
        lineStyle: { color: COLOR.primary, width: 1, type: 'dashed' },
        label: { show: false },
      },
      grid: grids,
      xAxis: tracks.map((_, index) => ({
        type: 'value',
        gridIndex: index,
        min: xDomain[0],
        max: xDomain[1],
        boundaryGap: false,
        axisLine: { show: index === tracks.length - 1 && showXAxis, lineStyle: { color: COLOR.hairline } },
        axisTick: { show: false },
        axisLabel: {
          show: index === tracks.length - 1 && showXAxis,
          color: COLOR.textFaint,
          fontFamily: 'JetBrains Mono',
          fontSize: 11,
          formatter: (value: number) => `${Math.round(value)}s`,
        },
        splitLine: { show: false },
        axisPointer: { show: true },
      })),
      yAxis: tracks.map((track, index) => ({
        type: 'value',
        gridIndex: index,
        min: track.domain?.[0],
        max: track.domain?.[1],
        boundaryGap: track.domain ? [0, 0] : [0.15, 0.15],
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: {
          show: track.splitLine ?? false,
          lineStyle: { color: '#f1f4fa', width: 1 },
        },
      })),
      series: tracks.flatMap((track, index) =>
        track.series.map((series, seriesIndex) => ({
          type: 'line' as const,
          id: series.id,
          name: series.id,
          xAxisIndex: index,
          yAxisIndex: index,
          showSymbol: series.points.length <= 120,
          symbol: 'circle',
          symbolSize: track.series.length > 1 ? 4 : 5,
          sampling: 'lttb' as const,
          lineStyle: {
            color: COLOR.primary,
            width: series.width ?? 1.5,
            opacity: series.opacity ?? 1,
          },
          itemStyle: { color: COLOR.primary, opacity: series.opacity ?? 1 },
          emphasis: { disabled: true },
          data: series.points.map((point) =>
            series.warnBelow != null && point.y < series.warnBelow
              ? { value: [point.x, point.y], itemStyle: { color: COLOR.warning } }
              : [point.x, point.y],
          ),
          ...(cursorX != null && seriesIndex === 0
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  animation: false,
                  label: { show: false },
                  lineStyle: { color: COLOR.primary, width: 1, type: 'dashed' as const },
                  data: [{ xAxis: cursorX }],
                },
              }
            : {}),
        })),
      ),
    };
  }, [tracks, xDomain, insets, gap, cursorX, box.height, showXAxis]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const instance = echarts.init(element, undefined, { renderer: 'canvas' });
    chart.current = instance;
    return () => {
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  useEffect(() => {
    if (box.width > 0 && box.height > 0) chart.current?.resize();
  }, [box.width, box.height]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance || !onPickX) return;
    const handler = (event: { offsetX: number; offsetY: number }) => {
      const value = instance.convertFromPixel({ xAxisIndex: 0 }, [event.offsetX, event.offsetY]);
      const x = Array.isArray(value) ? value[0] : value;
      if (typeof x === 'number' && Number.isFinite(x)) onPickX(x);
    };
    const zr = instance.getZr();
    zr.on('click', handler);
    return () => zr.off('click', handler);
  }, [onPickX]);

  return (
    <div
      ref={host}
      className={'h-full w-full ' + (className ?? '')}
      role="group"
      aria-label={ariaLabel}
    />
  );
}
