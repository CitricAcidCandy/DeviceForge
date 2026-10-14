import { useEffect, useState } from 'react';
import { ProfileFlamegraphView } from '../../../features/android-profile/flamegraph-view.tsx';
import { closedFlameInterval } from '../../../features/android-profile/flamegraph-interval.ts';
import { Button } from '../../../shared/ui/components/button.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../shared/ui/components/table.tsx';
import type { OpenedProfileArchive, ProfileFrameAssociation, ProfileSample } from '../../../features/android-profile/index.ts';
import type { PerformanceReading } from '../../../features/performance/index.ts';
import { EmptyState, JsonResult } from '../common.tsx';

export function metricText(value: number | null | undefined, unit = ''): string {
  return value == null ? '—' : `${Number.isInteger(value) ? value : value.toFixed(2)}${unit ? ` ${unit}` : ''}`;
}

function Metric({ value, unit, reason }: { value: number | null | undefined; unit: string; reason?: string | null | undefined }) {
  const explanation = reason === 'permission_denied' ? '来源权限不足（permission_denied）' : reason === 'unsupported' ? '来源不支持（unsupported）' : reason;
  return <><span>{metricText(value, unit)}</span>{value == null && <small className="muted" style={{ display: 'block' }}>{explanation || '本采样点没有有效观测'}</small>}</>;
}

// 每个对象 URL 只属于当前 Blob；更换结果与卸载时释放，不让旧画面混入新样本。
export function useBlobUrl(blob: Blob | null): string | null {
  const [current, setCurrent] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) { setCurrent(null); return; }
    const url = URL.createObjectURL(blob);
    setCurrent({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return current?.blob === blob ? current.url : null;
}

export function BlobDownload({ blob, filename, label }: { blob: Blob; filename: string; label: string }) {
  const url = useBlobUrl(blob);
  return url ? <a className="artifact-download" href={url} download={filename}>{label}</a> : <span className="muted">正在准备下载链接</span>;
}

export function PerformanceReadings({ readings }: { readings: readonly PerformanceReading[] }) {
  if (readings.length === 0) return <EmptyState title="尚未取得样本" description="读取当前会话样本；首个 CPU 差分或无有效观测的指标保留为空。" />;
  return <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>序号 / 时间</TableHead><TableHead>CPU 总占比</TableHead><TableHead>CPU 核心占比</TableHead><TableHead>FPS</TableHead><TableHead>PSS</TableHead><TableHead>RSS</TableHead><TableHead>净电池功率</TableHead></TableRow></TableHeader><TableBody>
    {readings.map(reading => <TableRow key={reading.sequence}>
      <TableCell>{reading.sequence}<small style={{ display: 'block' }}>{new Date(reading.captured_at).toLocaleString()} · PID {reading.pid}</small><JsonResult value={reading} /></TableCell>
      <TableCell><Metric value={reading.cpu_share_percent} unit="%" reason={reading.metric_missing?.cpu?.reason} /></TableCell>
      <TableCell><Metric value={reading.cpu_core_percent} unit="%" reason={reading.metric_missing?.cpu?.reason} /></TableCell>
      <TableCell><Metric value={reading.fps} unit="帧/秒" reason="本点未返回有效 FPS 或展示窗口" />{reading.frame_window && <small style={{ display: 'block' }}>{reading.frame_window.frames} 帧 / {reading.frame_window.duration_ms} ms · {reading.frame_window.source}</small>}</TableCell>
      <TableCell><Metric value={reading.pss_kib} unit="KiB" reason={reading.metric_missing?.memory?.reason} /></TableCell>
      <TableCell><Metric value={reading.rss_kib} unit="KiB" reason={reading.metric_missing?.memory?.reason} /></TableCell>
      <TableCell><Metric value={reading.battery_net_power_mw} unit="mW" reason="缺少合法电流或已知极性" />{reading.device_observation?.battery && <small style={{ display: 'block' }}>{reading.device_observation.battery.source} · {reading.device_observation.battery.supply_state}</small>}</TableCell>
    </TableRow>)}
  </TableBody></Table></div>;
}

function ProfileFrameView({ archive, sample }: { archive: OpenedProfileArchive; sample: ProfileSample }) {
  const reference = sample.frame;
  const frame = reference ? archive.frames.find(item => item.reference.filename === reference.filename) : null;
  const url = useBlobUrl(frame?.content ?? null);
  if (!reference || !frame) return <EmptyState title="本点没有画面" description={archive.timeline.frameReason ?? (archive.timeline.frameStatus === 'disabled' ? '录制时未请求画面' : '没有发布与本点关联的画面')} />;
  return <figure className="profile-frame">
    {url && <img src={url} width={frame.width} height={frame.height} alt={`${archive.index.package} 第 ${sample.index} 个指标点的采样画面`} style={{ maxWidth: '100%', width: 'auto', height: 'auto', maxHeight: '440px', objectFit: 'contain' }} />}
    <figcaption><p>{reference.filename} · {frame.width}×{frame.height} · {archive.index.frame_kind === 'scrcpy_sampled_frame' ? 'scrcpy 采样帧' : '采样截图'}</p><p>画面区间：{reference.begin_ns}–{reference.end_ns} ns（boottime）</p>
      {reference.device_time_ns !== undefined && <p>帧设备时间：{reference.device_time_ns} ns · 选择偏移：{reference.selection_delta_ns ?? '未提供'} ns · 时钟误差：{reference.clock_error_ns ?? '未提供'} ns</p>}
      <p className="muted">这是采样画面，不是全部显示帧；画面区间与指标区间独立关联，不插值成逐帧性能。</p>
    </figcaption>
  </figure>;
}

function StackList({ associations }: { associations: readonly ProfileFrameAssociation[] }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [associations]);
  const offset = page * 25;
  const visible = associations.slice(offset, offset + 25);
  if (associations.length === 0) return <EmptyState title="此区间没有关联栈" description="没有用相邻栈或最近一帧补齐关联；无 Root 时仍可查看已有指标。" />;
  return <div className="profile-stacks">
    <p className="muted">{associations.length} 条实际调用链 · 当前 {offset + 1}–{Math.min(offset + 25, associations.length)}</p>
    {visible.map(({ index, sample }) => <details key={index} className="result-details">
      <summary>栈 {index} · {sample.thread_name ?? '未报告线程名'}（TID {sample.thread_id}）· {sample.time_ns} ns · 深度 {sample.callchain.length}</summary>
      <p>事件：{sample.event_type ?? '未报告'} · 计数 {sample.event_count} · PID {sample.process_id ?? '未报告'}</p>
      {sample.unwinding && <p>展开诊断：{sample.unwinding.error_code ?? '未报告错误码'} · 地址 {sample.unwinding.error_address ?? '未报告'} · 原始码 {sample.unwinding.raw_error_code ?? '未报告'}</p>}
      {sample.callchain.length > 0 ? <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>层级</TableHead><TableHead>符号 / 地址</TableHead><TableHead>模块</TableHead><TableHead>执行类型</TableHead></TableRow></TableHeader><TableBody>
        {sample.callchain.map((frame, depth) => <TableRow key={depth}><TableCell>{depth}</TableCell><TableCell><code>{frame.symbol ?? '未提供符号'}</code><small style={{ display: 'block' }}><code>{frame.address}</code></small></TableCell><TableCell>{frame.file ?? '未提供模块'}</TableCell><TableCell>{frame.execution_type}</TableCell></TableRow>)}
      </TableBody></Table></div> : <p className="muted">此条记录没有非空调用链。</p>}
    </details>)}
    <div className="action-row"><Button variant="outline" disabled={page === 0} onClick={() => setPage(old => old - 1)}>上一页调用链</Button><Button variant="outline" disabled={offset + 25 >= associations.length} onClick={() => setPage(old => old + 1)}>下一页调用链</Button></div>
  </div>;
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
    <StackList associations={associations ?? []} />
    {archive.quality && <details className="result-details"><summary>展开与符号质量 · 实际解析 {archive.quality.counts.parsed_sample_count} 栈 · 最大深度 {archive.quality.counts.max_callchain_depth}</summary><p>{archive.quality.symbolication.reason}</p><p>缺符号帧 {archive.quality.counts.missing_symbol_frame_count} · 展开错误样本 {archive.quality.counts.unwinding_error_sample_count}</p><JsonResult value={archive.quality} /></details>}
    {archive.folded && <BlobDownload blob={archive.folded} filename="flamegraph.folded" label="下载折叠栈（样本数权重）" />}
    {archive.perf && <BlobDownload blob={archive.perf} filename="perf.bin" label="下载归档中的原始 perf.bin" />}
  </section>;
}
