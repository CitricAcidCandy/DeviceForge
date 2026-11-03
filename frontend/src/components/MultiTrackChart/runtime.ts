import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AxisPointerComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([LineChart, GridComponent, AxisPointerComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

/** 仅由有实际尺寸的图表按需载入，不加入工作台公共UI的静态依赖。 */
export function createChart(element: HTMLElement, width: number, height: number): echarts.ECharts {
  return echarts.init(element, undefined, { renderer: 'canvas', width, height });
}
