import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../../components/Table/index.tsx';
import { EmptyState } from '../../../../components/EmptyState/index.tsx';
import { JsonResult } from '../../../../components/JsonResult/index.tsx';
import type { PerformanceReading } from '../../../../features/performance/index.ts';

function metricText(value: number | null | undefined, unit = ''): string {
  return value == null
    ? '—'
    : `${Number.isInteger(value) ? value : value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}

function Metric({
  value,
  unit,
  reason,
}: {
  value: number | null | undefined;
  unit: string;
  reason?: string | null | undefined;
}) {
  const explanation =
    reason === 'permission_denied'
      ? '来源权限不足（permission_denied）'
      : reason === 'unsupported'
        ? '来源不支持（unsupported）'
        : reason;
  return (
    <>
      <span>{metricText(value, unit)}</span>
      {value == null && (
        <small className="muted" style={{ display: 'block' }}>
          {explanation || '本采样点没有有效观测'}
        </small>
      )}
    </>
  );
}

export function PerformanceReadings({ readings }: { readings: readonly PerformanceReading[] }) {
  if (readings.length === 0)
    return (
      <EmptyState
        title="尚未取得样本"
        description="读取当前会话样本；首个 CPU 差分或无有效观测的指标保留为空。"
      />
    );
  return (
    <div className="table-scroll">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>序号 / 时间</TableHead>
            <TableHead>CPU 总占比</TableHead>
            <TableHead>CPU 核心占比</TableHead>
            <TableHead>FPS</TableHead>
            <TableHead>PSS</TableHead>
            <TableHead>RSS</TableHead>
            <TableHead>净电池功率</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {readings.map((reading) => (
            <TableRow key={reading.sequence}>
              <TableCell>
                {reading.sequence}
                <small style={{ display: 'block' }}>
                  {new Date(reading.captured_at).toLocaleString()} · PID {reading.pid}
                </small>
                <JsonResult value={reading} />
              </TableCell>
              <TableCell>
                <Metric
                  value={reading.cpu_share_percent}
                  unit="%"
                  reason={reading.metric_missing?.cpu?.reason}
                />
              </TableCell>
              <TableCell>
                <Metric
                  value={reading.cpu_core_percent}
                  unit="%"
                  reason={reading.metric_missing?.cpu?.reason}
                />
              </TableCell>
              <TableCell>
                <Metric value={reading.fps} unit="帧/秒" reason="本点未返回有效 FPS 或展示窗口" />
                {reading.frame_window && (
                  <small style={{ display: 'block' }}>
                    {reading.frame_window.frames} 帧 / {reading.frame_window.duration_ms} ms ·{' '}
                    {reading.frame_window.source}
                  </small>
                )}
              </TableCell>
              <TableCell>
                <Metric
                  value={reading.pss_kib}
                  unit="KiB"
                  reason={reading.metric_missing?.memory?.reason}
                />
              </TableCell>
              <TableCell>
                <Metric
                  value={reading.rss_kib}
                  unit="KiB"
                  reason={reading.metric_missing?.memory?.reason}
                />
              </TableCell>
              <TableCell>
                <Metric
                  value={reading.battery_net_power_mw}
                  unit="mW"
                  reason="缺少合法电流或已知极性"
                />
                {reading.device_observation?.battery && (
                  <small style={{ display: 'block' }}>
                    {reading.device_observation.battery.source} ·{' '}
                    {reading.device_observation.battery.supply_state}
                  </small>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
