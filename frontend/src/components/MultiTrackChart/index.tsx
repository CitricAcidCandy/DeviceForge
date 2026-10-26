import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import type { LineSeriesOption } from 'echarts/charts';
import {
  AxisPointerComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import type {
  AxisPointerComponentOption,
  GridComponentOption,
  MarkLineComponentOption,
  TooltipComponentOption,
} from 'echarts/components';
import type { XAXisComponentOption, YAXisComponentOption } from 'echarts';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart, GridComponent, AxisPointerComponent, TooltipComponent, MarkLineComponent, CanvasRenderer,
]);

type ChartOption = echarts.ComposeOption<
  LineSeriesOption | GridComponentOption | AxisPointerComponentOption |
  TooltipComponentOption | MarkLineComponentOption
>;

/** 画布解析不了 CSS 变量，这里的取值与 styles.css 的令牌保持一致。 */
const COLOR = {
  primary: '#6c4cf5',
  info: '#2f7fe0',
  violetSoft: '#8c7bf7',
  warning: '#d98a00',
  hairline: '#e6eaf3',
  textFaint: '#a3acbc',
};

export interface ChartPoint {
  readonly x: number;
  /** 缺测点保留横坐标，并用 null 断开曲线。 */
  readonly y: number | null;
}

export interface ChartSeries {
  readonly id: string;
  readonly points: readonly ChartPoint[];
  /** 低于该值的点单独标色，用于掉帧这类异常。 */
  readonly warnBelow?: number;
  readonly opacity?: number;
  readonly width?: number;
  /** 同一轨内多条线需要区分时显式给色，不给则用主色。 */
  readonly color?: string;
  /** 虚线用于辅助线（例如同一轨里的第二条指标）。 */
  readonly dashed?: boolean;
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
    const updateBox = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      setBox((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    const measure = () => updateBox(element.clientWidth, element.clientHeight);
    // 先主动测量，避免首次绘制依赖异步观察回调；隐藏后恢复仍由观察器重新测量。
    measure();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      updateBox(width, height);
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', measure);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', measure);
    };
  }, []);

  const option = useMemo<ChartOption>(() => {
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
      xAxis: tracks.map((_, index): XAXisComponentOption => ({
        type: 'value',
        gridIndex: index,
        min: xDomain[0],
        max: xDomain[1],
        boundaryGap: [0, 0],
        axisLine: { show: index === tracks.length - 1 && showXAxis, lineStyle: { color: COLOR.hairline } },
        axisTick: { show: false },
        axisLabel: {
          show: index === tracks.length - 1 && showXAxis,
          color: COLOR.textFaint,
          fontFamily: 'JetBrains Mono',
          fontSize: 12,
          formatter: (value: number) => `${Math.round(value)}s`,
        },
        splitLine: { show: false },
        axisPointer: { show: true },
      })),
      yAxis: tracks.map((track, index): YAXisComponentOption => ({
        type: 'value',
        gridIndex: index,
        ...(track.domain ? { min: track.domain[0], max: track.domain[1] } : {}),
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
        track.series.map((series, seriesIndex): LineSeriesOption => ({
          type: 'line',
          id: series.id,
          name: series.id,
          xAxisIndex: index,
          yAxisIndex: index,
          showSymbol: series.points.length <= 120,
          symbol: 'circle',
          symbolSize: track.series.length > 1 ? 4 : 5,
          connectNulls: false,
          lineStyle: {
            color: series.color ?? COLOR.primary,
            width: series.width ?? 1.5,
            opacity: series.opacity ?? 1,
            type: series.dashed ? 'dashed' : 'solid',
          },
          itemStyle: { color: series.color ?? COLOR.primary, opacity: series.opacity ?? 1 },
          emphasis: { disabled: true },
          data: series.points.map((point) =>
            point.y !== null && Number.isFinite(point.y) &&
            series.warnBelow != null && point.y < series.warnBelow
              ? { value: [point.x, point.y], itemStyle: { color: COLOR.warning } }
              : [point.x, point.y !== null && Number.isFinite(point.y) ? point.y : null],
          ),
          ...(cursorX != null && seriesIndex === 0
            ? {
                markLine: {
                  silent: true,
                  symbol: 'none',
                  animation: false,
                  label: { show: false },
                  lineStyle: { color: COLOR.primary, width: 1, type: 'dashed' },
                  data: [{ xAxis: cursorX }],
                },
              }
            : {}),
        })),
      ),
    };
  }, [tracks, xDomain, insets, gap, cursorX, box.height, showXAxis]);

  useEffect(() => {
    return () => {
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element || box.width <= 0 || box.height <= 0) return;
    // 正尺寸才初始化，并按「尺寸 -> 数据 -> 同步绘制」提交，避免零尺寸和延迟更新互相覆盖。
    const instance = chart.current ?? echarts.init(element, undefined, {
      renderer: 'canvas', width: box.width, height: box.height,
    });
    chart.current = instance;
    if (instance.getWidth() !== box.width || instance.getHeight() !== box.height) {
      instance.resize({ width: box.width, height: box.height });
    }
    instance.setOption(option, { notMerge: true, lazyUpdate: false });
    if (!onPickX) return;
    const handler = (event: { offsetX: number; offsetY: number }) => {
      const inside = tracks.some((_, index) =>
        instance.containPixel({ gridIndex: index }, [event.offsetX, event.offsetY]),
      );
      if (!inside) return;
      const value = instance.convertFromPixel({ xAxisIndex: 0 }, event.offsetX);
      const x = Array.isArray(value) ? value[0] : value;
      if (typeof x === 'number' && Number.isFinite(x)) onPickX(x);
    };
    const zr = instance.getZr();
    zr.on('click', handler);
    return () => zr.off('click', handler);
  }, [option, box.width, box.height, onPickX, tracks]);

  return (
    <div
      ref={host}
      className={'h-full min-h-0 w-full min-w-0 ' + (className ?? '')}
      role="group"
      aria-label={ariaLabel}
    />
  );
}
