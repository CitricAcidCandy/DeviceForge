import { useEffect, useState } from 'react';
import { Button } from '../../../../components/Button/index.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../../components/Table/index.tsx';
import { JsonResult } from '../../../../components/JsonResult/index.tsx';
import { ProfileFlamegraphView } from '../ProfileFlamegraph/index.tsx';
import { closedFlameInterval } from '../ProfileFlamegraph/interval.ts';
import { ProfileFrameView } from '../ProfileFrameView/index.tsx';
import { ProfileStackList } from '../ProfileStackList/index.tsx';
import type { OpenedProfileArchive } from '../../models/archive.ts';

function metricText(value: number | null | undefined, unit = ''): string {
  return value == null ? '—' : `${Number.isInteger(value) ? value : value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}

function Metric({ value, unit, reason }: { value: number | null | undefined; unit: string; reason?: string | null | undefined }) {
  const explanation = reason === 'permission_denied' ? '来源权限不足（permission_denied）' : reason === 'unsupported' ? '来源不支持（unsupported）' : reason;
  return <><span>{metricText(value, unit)}</span>{value == null && <small className="muted" style={{ display: 'block' }}>{explanation || '本采样点没有有效观测'}</small>}</>;
}

// 对象 URL 只属于当前 Blob；更换结果和卸载时释放。
function useBlobUrl(blob: Blob | null): string | null {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) { setCurrent(null); return; }
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current?.blob === blob ? current.url : null;
}

function BlobDownload({ blob, filename, label }: { blob: Blob; filename: string; label: string }) {
  const url = useBlobUrl(blob);
  return url ? <a className="artifact-download" href={url} download={filename}>{label}</a> : <span className="muted">正在准备下载链接</span>;
}

export function ProfileArchiveView({ archive }: { archive: OpenedProfileArchive }) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [association, setAssociation] = useState<'metric' | 'frame' | 'unassociated' | 'without-frame'>('metric');
  const selected = archive.timeline.samples.find(item => item.sample.index === selectedIndex) ?? archive.timeline.samples[0];
  useEffect(() => { setSelectedIndex(null); setAssociation('metric'); }, [archive]);
  const associations = association === 'unassociated' ? archive.timeline.unassociated : association === 'without-frame' ? archive.timeline.withoutFrame : association === 'frame' ? selected?.frameStacks : selected?.stacks;
  return <section className="profile-archive" aria-label="已验证性能归档">
    <h3>采样报告 · {archive.index.package}</h3>
    <p className="muted">设备 {archive.index.device_id} · PID {archive.index.pid} · 进程开始标识 {archive.index.process_start_ticks} · Root {archive.timeline.rootAccess} · 丢失计数 {archive.index.lost_count}</p>
    <p>调用栈：{archive.timeline.stackStatus === 'captured' ? '已取得录制结果' : '不可用'}{archive.timeline.stackReason && ` · ${archive.timeline.stackReason}`} · 画面：{archive.timeline.frameStatus === 'captured' ? '已取得采样画面' : archive.timeline.frameStatus === 'disabled' ? '未请求' : '不可用'}{archive.timeline.frameReason && ` · ${archive.timeline.frameReason}`}</p>
    <p className="capability-notice">符号资格：reported_symbols_only，只展示工具报告的符号；没有匹配构建身份或完整符号化保证。全部关联使用同次录制 boottime 纳秒区间，display_frame_complete=false，不表示每个显示帧或精确逐帧指标。</p>
    <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>选点 / 区间 ns</TableHead><TableHead>CPU 总占比</TableHead><TableHead>CPU 核心占比</TableHead><TableHead>FPS</TableHead><TableHead>PSS / RSS</TableHead><TableHead>净电池功率</TableHead><TableHead>画面 / 栈</TableHead></TableRow></TableHeader><TableBody>
      {archive.timeline.samples.map(item => <TableRow key={item.sample.index} data-state={selected === item ? 'selected' : undefined}>
        <TableCell><Button size="sm" variant={selected === item ? 'default' : 'ghost'} aria-pressed={selected === item} onClick={() => setSelectedIndex(item.sample.index)}>采样点 {item.sample.index}</Button><small style={{ display: 'block' }}>{item.sample.begin_ns}–{item.sample.end_ns}</small></TableCell>
        <TableCell><Metric value={item.sample.derived?.cpu_share_percent} unit="%" reason={item.sample.derived?.cpu_reason ?? item.sample.metrics.metric_missing?.cpu?.reason} /></TableCell>
        <TableCell><Metric value={item.sample.derived?.cpu_core_percent} unit="%" reason={item.sample.derived?.cpu_reason ?? item.sample.metrics.metric_missing?.cpu?.reason} /></TableCell>
        <TableCell><Metric value={item.sample.derived?.fps} unit="帧/秒" reason={item.sample.derived?.fps_reason} /></TableCell>
        <TableCell><Metric value={item.sample.metrics.pss_kib} unit="KiB" reason={item.sample.metrics.metric_missing?.memory?.reason} /><small style={{ display: 'block' }}>RSS {metricText(item.sample.metrics.rss_kib, 'KiB')}</small></TableCell>
        <TableCell><Metric value={item.sample.derived?.battery_net_power_mw} unit="mW" reason={item.sample.derived?.battery_reason} /></TableCell>
        <TableCell>{item.sample.frame ? item.sample.frame.filename : '没有画面'}<small style={{ display: 'block' }}>指标区间 {item.stacks.length} 栈 · 画面区间 {item.frameStacks.length} 栈</small></TableCell>
      </TableRow>)}
    </TableBody></Table></div>
    <p className="muted">CPU/PSS/RSS 属于目标主进程；FPS 保留实际展示窗口来源。净电池功率属于整台设备电池侧，正值充电、负值放电，不是游戏独占功耗。空值保留原因，不填零。</p>
    {selected && <><h4>采样点 {selected.sample.index} 的画面与来源</h4><ProfileFrameView archive={archive} sample={selected.sample} /><JsonResult value={selected.sample} /></>}
    <div className="action-row" aria-label="调用栈关联范围">
      <Button variant="outline" aria-pressed={association === 'metric'} onClick={() => setAssociation('metric')}>当前指标区间</Button>
      <Button variant="outline" aria-pressed={association === 'frame'} onClick={() => setAssociation('frame')}>当前画面区间</Button>
      <Button variant="outline" aria-pressed={association === 'unassociated'} onClick={() => setAssociation('unassociated')}>未关联指标（{archive.timeline.unassociated.length}）</Button>
      <Button variant="outline" aria-pressed={association === 'without-frame'} onClick={() => setAssociation('without-frame')}>没有关联画面（{archive.timeline.withoutFrame.length}）</Button>
    </div>
    <ProfileFlamegraphView stacks={archive.stacks} intervals={archive.timeline.samples.map(item => closedFlameInterval('指标点 ' + item.sample.index, item.sample.begin_ns, item.sample.end_ns))} />
    <ProfileStackList associations={associations ?? []} />
    {archive.quality && <details className="result-details"><summary>展开与符号质量 · 实际解析 {archive.quality.counts.parsed_sample_count} 栈 · 最大深度 {archive.quality.counts.max_callchain_depth}</summary><p>{archive.quality.symbolication.reason}</p><p>缺符号帧 {archive.quality.counts.missing_symbol_frame_count} · 展开错误样本 {archive.quality.counts.unwinding_error_sample_count}</p><JsonResult value={archive.quality} /></details>}
    {archive.folded && <BlobDownload blob={archive.folded} filename="flamegraph.folded" label="下载折叠栈（样本数权重）" />}
    {archive.perf && <BlobDownload blob={archive.perf} filename="perf.bin" label="下载归档中的原始 perf.bin" />}
  </section>;
}
