import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button.tsx';
import { Checkbox } from '../../../components/ui/checkbox.tsx';
import { Label } from '../../../components/ui/label.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table.tsx';
import { downloadAndOpenProfileArchive, downloadProfileArchive, JobFailure, JobWaitFailure } from '../../../features/android-profile/index.ts';
import type { AndroidProfile, OpenedProfileArchive, ProbeResult, ProfileReference, ProfileResult } from '../../../features/android-profile/index.ts';
import type { PerformanceCapabilities, PerformanceSession } from '../../../features/performance/index.ts';
import { PerformanceJobFailure, PerformanceWaitFailure } from '../../../features/performance/index.ts';
import type { PublishedResult } from '../../../shared/jobs/index.ts';
import type { DeviceSnapshot } from '../../../plugin-sdk/index.ts';
import { EmptyState, Field, JsonResult, PageTitle } from '../../../components/common/index.ts';
import { OperationNotice, useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../feedback.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import type { ProductServices } from '../services.ts';
import { BlobDownload, PerformanceReadings, ProfileArchiveView } from './profile-view.tsx';

function capabilityReason(devices: DeviceSnapshot, capability: string, versions: readonly number[], operation?: string): string | null {
  const selected = devices.selected;
  if (!selected) return '先在顶部选择设备。';
  if (selected.state !== 'online') return selected.state === 'unauthorized' ? '当前设备尚未授权。' : '当前设备不在线，保留历史读取。';
  const provider = devices.providers.find(item => item.id === selected.reference.providerId && item.generation === selected.reference.generation);
  if (!provider) return '设备提供者已移除或换代，请刷新目录。';
  const declared = provider.definition.capabilities.find(item => item.id === capability && versions.includes(item.version) && item.scope === 'device' && (operation === undefined || item.operation === operation));
  if (!declared) return `提供者没有声明受支持的 ${capability} 设备能力。`;
  const available = selected.capabilities.find(item => item.id === declared.id && item.version === declared.version);
  if (!available?.available) return available?.reason ?? `当前设备不能使用 ${capability} v${declared.version}。`;
  return null;
}

const stateLabel: Record<PerformanceSession['state'], string> = { running: '运行中', paused: '已暂停', stopped: '已停止', completed: '已完成', failed: '失败', interrupted: '已中断' };

function RootProfilePanel({ services, reference, devices, packageId }: { services: ProductServices; reference: ProfileReference; devices: DeviceSnapshot; packageId: string }) {
  const resources = useRef<{ profile: AndroidProfile; lifetime: AbortController } | null>(null);
  // 在作用域内创建，StrictMode 重放也取得新的可用实例，不复用已释放的 runner。
  useEffect(() => {
    const owned = { profile: services.profile(reference), lifetime: new AbortController() };
    resources.current = owned;
    return () => { owned.lifetime.abort(); owned.profile.dispose(); if (resources.current === owned) resources.current = null; };
  }, [services, reference.providerId, reference.generation, reference.localId]);
  const action = useAction();
  const downloader = useAction();
  const [duration, setDuration] = useState('5');
  const [interval, setInterval] = useState('1000');
  const [captureFrames, setCaptureFrames] = useState(true);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [published, setPublished] = useState<PublishedResult<ProfileResult> | null>(null);
  const [archive, setArchive] = useState<OpenedProfileArchive | null>(null);
  const [zip, setZip] = useState<Blob | null>(null);
  const [jobId, setJobId] = useState('');
  const [restoreId, setRestoreId] = useState('');
  const probeReason = capabilityReason(devices, 'stack.probe', [1], 'plugin.android-device.stack.probe');
  const recordReason = capabilityReason(devices, 'profile.record', [1], 'plugin.android-device.profile.record');
  const currentProbe = probe?.package === packageId ? probe : null;
  const waitJob = action.error instanceof JobWaitFailure || action.error instanceof JobFailure ? action.error.job.id : null;
  const requestContext = (signal: AbortSignal) => {
    const owned = resources.current;
    if (!owned) throw new Error('录制页面作用域尚未就绪');
    return { profile: owned.profile, signal: AbortSignal.any([signal, owned.lifetime.signal]) };
  };

  async function openPublished(result: PublishedResult<ProfileResult>, signal: AbortSignal) {
    const opened = await downloadAndOpenProfileArchive(services.runtime.artifacts, result, signal);
    if (!signal.aborted) setArchive(opened.data);
    return opened;
  }

  return <section aria-label="Root 堆栈录制">
    <h3>Root 资格与限时归档</h3>
    <p className="muted">固定目标 {reference.localId} · 提供者 {reference.providerId} · 代次 {reference.generation}。探测与录制只有点击时才发起。</p>
    <div className="action-row"><Button variant="outline" disabled={!!probeReason || !packageId || action.pending} onClick={() => void action.run(async signal => {
      const { profile, signal: combined } = requestContext(signal);
      const result = await profile.probe(packageId, combined);
      if (!combined.aborted) setProbe(result.data);
      return result;
    })}>探测 Root 与 Simpleperf</Button></div>
    {probeReason && <p className="capability-notice">{probeReason}</p>}
    {currentProbe && <div role="status"><p>Root：{currentProbe.root_access} · Simpleperf：{currentProbe.simpleperf_available ? '可用' : '不可用'} · 深度录制：{currentProbe.supported ? '具备探测资格' : '资格不足'}</p>{currentProbe.reason && <p>{currentProbe.reason}</p>}<p className="muted">探测资格不保证最终非空调用链、匹配符号或逐帧完整采集；无 Root 时按服务器实际结果降级。</p></div>}
    <div className="form-row"><Field label="归档时长（秒）" type="number" min={1} max={15} value={duration} onChange={setDuration} hint="限时 1–15 秒，不替代持续性能会话" /><Field label="归档采样间隔（毫秒）" type="number" min={1000} max={15000} value={interval} onChange={setInterval} hint="至少 1000 毫秒，不超过录制时长" /><div className="form-field"><Label htmlFor="profile-capture-frames">采样画面</Label><Checkbox id="profile-capture-frames" checked={captureFrames} onCheckedChange={value => setCaptureFrames(value === true)} /></div></div>
    {recordReason && <p className="capability-notice">{recordReason}</p>}
    <Button disabled={!!recordReason || !packageId || action.pending || downloader.pending} onClick={() => void action.run(async signal => {
      const { profile, signal: combined } = requestContext(signal);
      setPublished(null); setArchive(null); setZip(null); setJobId('');
      const result = await profile.record({ package: packageId, duration_ms: Number(duration) * 1000, interval_ms: Number(interval), capture_frames: captureFrames }, combined);
      if (combined.aborted) return result;
      setJobId(result.job.id); setPublished(result.data);
      return openPublished(result.data, combined);
    })}>限时录制并打开归档</Button>
    <div className="form-row"><Field label="恢复录制任务 ID" value={restoreId} onChange={setRestoreId} hint="使用相同设备引用和应用包读取已有录制任务" /><Button variant="outline" disabled={!restoreId || !packageId || action.pending || downloader.pending} onClick={() => void action.run(async signal => {
      const { profile, signal: combined } = requestContext(signal);
      const job = await services.runtime.tasks.get(restoreId, combined);
      if (job.data.operation !== 'plugin.android-device.profile.record') throw new Error('所选任务不是 Android 性能归档录制');
      const result = await profile.resumeRecording({ id: job.data.id, operation: job.data.operation, submitLogId: null }, packageId, combined);
      if (combined.aborted) return result;
      setJobId(result.job.id); setPublished(result.data); setArchive(null); setZip(null);
      return openPublished(result.data, combined);
    })}>恢复并读取归档</Button></div>
    {(jobId || waitJob) && <p className="log-id">录制任务 ID：{jobId || waitJob}（用于任务页重新查询和取消服务端任务）</p>}
    <p className="muted">取消等待仅撤销页面请求，不等于停止服务端录制。切页后可在任务页查询实际终态，停止会话与取消任务分别管理。</p>
    <ActionFeedback {...action} />
    {published && <div className="action-row"><Button variant="outline" disabled={downloader.pending || action.pending} onClick={() => void downloader.run(signal => openPublished(published, requestContext(signal).signal))}>重新验证并读取归档</Button><Button variant="outline" disabled={downloader.pending || action.pending} onClick={() => void downloader.run(async signal => {
      const combined = requestContext(signal).signal;
      const result = await downloadProfileArchive(services.runtime.artifacts, published, combined);
      if (!combined.aborted) setZip(result.data);
      return { logId: result.logId };
    })}>准备原始 ZIP 下载</Button>{zip && <BlobDownload blob={zip} filename="profile.zip" label="下载已验证原始 ZIP" />}</div>}
    <ActionFeedback {...downloader} />
    {published && <JsonResult value={published.result} />}
    {archive ? <ProfileArchiveView archive={archive} /> : <EmptyState title="尚未打开归档" description="录制成功后验证原始 ZIP、索引、栈与 PNG，再展示关联；验证失败不交付部分结果。" />}
  </section>;
}

function PerformanceSessionPanel({ services, devices, packageId }: { services: ProductServices; devices: DeviceSnapshot; packageId: string }) {
  const performance = services.runtime.performance;
  const snapshot = useSnapshot(performance);
  const action = useAction();
  const history = useAction();
  const [duration, setDuration] = useState('60');
  const [interval, setInterval] = useState('1000');
  const [restoreId, setRestoreId] = useState('');
  const [sessions, setSessions] = useState<readonly PerformanceSession[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<{ key: string; data: PerformanceCapabilities } | null>(null);
  const sourceKey = devices.selection ? JSON.stringify(devices.selection) : 'none';
  const previousKey = useRef(sourceKey);
  useEffect(() => {
    if (previousKey.current !== sourceKey) { action.cancel(); setCapabilities(null); previousKey.current = sourceKey; }
  }, [sourceKey, action.cancel]);
  const startAvailable = useOperationAvailable(services, 'android.performance.start');
  const inspectAvailable = useOperationAvailable(services, 'android.performance.inspect');
  const samplesAvailable = useOperationAvailable(services, 'android.performance.samples');
  const listAvailable = useOperationAvailable(services, 'android.performance.list');
  const pauseAvailable = useOperationAvailable(services, 'android.performance.pause');
  const resumeAvailable = useOperationAvailable(services, 'android.performance.resume');
  const stopAvailable = useOperationAvailable(services, 'android.performance.stop');
  const capabilitiesAvailable = useOperationAvailable(services, 'android.performance.capabilities');
  const samplingReason = capabilityReason(devices, 'performance.sample', [1, 2]);
  const session = snapshot.session;
  const sourceDevice = session?.source?.device;
  const sameSource = !!sourceDevice && !!devices.selection && sourceDevice.provider_id === devices.selection.providerId && sourceDevice.generation === devices.selection.generation && sourceDevice.local_id === devices.selection.localId;
  const running = session?.state === 'running';
  const paused = session?.state === 'paused';
  const waitJob = action.error instanceof PerformanceWaitFailure || action.error instanceof PerformanceJobFailure ? action.error.job.id : null;

  async function readSession(id: string, signal: AbortSignal) {
    const result = await performance.select(id, signal);
    if (samplesAvailable && !signal.aborted) await performance.samples(id, { after: 0, limit: 100 }, signal);
    return result;
  }

  async function readHistory(next: boolean, signal: AbortSignal) {
    const result = await performance.list({ afterId: next ? historyCursor : null, limit: 25 }, signal);
    if (!signal.aborted) {
      setSessions(old => next ? [...old, ...result.data.sessions.filter(item => !old.some(existing => existing.id === item.id))] : result.data.sessions);
      setHistoryCursor(result.data.next_after_id ?? null);
    }
    return result;
  }

  return <section aria-label="持续性能会话">
    <h3>持续指标会话</h3>
    <OperationNotice services={services} operation="android.performance.start" />
    <div className="form-row"><Field label="会话时长（秒）" type="number" min={1} max={3600} value={duration} onChange={setDuration} hint="1–3600 秒；达到时长由服务器收敛" /><Field label="会话间隔（毫秒）" type="number" min={1000} max={60000} value={interval} onChange={setInterval} hint="1000–60000 毫秒，空值与有效零分别保留" /></div>
    {samplingReason && <p className="capability-notice">{samplingReason}</p>}
    {!snapshot.liveAvailable && <p className="capability-notice">来源观测已撤销。先在设备页刷新提供者与目录；历史查询和停止不受此标记阻断。</p>}
    <div className="action-row"><Button disabled={!startAvailable || !!samplingReason || !snapshot.liveAvailable || !packageId || action.pending} onClick={() => void action.run(async signal => {
      const selected = devices.selected;
      if (!selected) throw new Error('尚未选择设备');
      const result = await performance.start({ target: { device_id: selected.reference.localId, package: packageId }, interval_ms: Number(interval), duration_secs: Number(duration) }, signal);
      if (!signal.aborted) await readSession(result.data.id, signal);
      return result;
    })}>开始性能会话</Button><Button variant="outline" disabled={!capabilitiesAvailable || !!samplingReason || !snapshot.liveAvailable || action.pending} onClick={() => void action.run(async signal => {
      const result = await performance.capabilities(signal);
      if (!signal.aborted) setCapabilities({ key: sourceKey, data: result.data });
      return result;
    })}>查询当前采样能力</Button></div>
    {capabilities?.key === sourceKey && <p className="muted">来源 {capabilities.data.sourceLabel} · 范围主进程 · 指标 {capabilities.data.metrics.join('、')} · 最大 {capabilities.data.maxSamples} 点</p>}
    <p className="muted">此创建契约只发送设备 ID，实际来源以服务器返回的 plugin_id / generation 为准，不保证客户端代次 CAS。未注明来源的旧历史不会从当前设备补齐。</p>
    {session && <div className="performance-session">
      <h4>{session.request.target.package} · {stateLabel[session.state]}</h4>
      <p>设备 {session.request.target.device_id} · 会话 {session.id} · 修订 {session.revision} · {session.samples} 个采样点</p>
      <p className="muted">来源：{session.source ? `${session.source.plugin_id} / ${session.source.generation} / ${session.source.operation}` : '历史未记录来源'}{sourceDevice && ` · 设备 ${sourceDevice.provider_id} / ${sourceDevice.generation} / ${sourceDevice.local_id}`}</p>
      {session.error && <p role="alert" className="capability-notice">{session.error}</p>}
      {snapshot.needsReconcile && <p role="status">上次控制结果未确认。先重查实际状态，再恢复，不自动重放控制。</p>}
      {paused && !sameSource && <p className="muted">当前设备引用与会话来源不一致或来源未记录，不能凭当前目录恢复旧代采集；可重查历史或停止。</p>}
      <div className="action-row"><Button variant="outline" disabled={!inspectAvailable || action.pending} onClick={() => void action.run(signal => performance.refresh(signal))}>重查会话状态</Button><Button variant="outline" disabled={!pauseAvailable || !running || action.pending} onClick={() => void action.run(signal => performance.pause(session.id, signal))}>暂停采集</Button><Button variant="outline" disabled={!resumeAvailable || !paused || !sameSource || !!samplingReason || !snapshot.liveAvailable || snapshot.needsReconcile || action.pending} onClick={() => void action.run(signal => performance.resume(session.id, signal))}>继续采集</Button><Button variant="destructive" disabled={!stopAvailable || !(running || paused) || action.pending} onClick={() => void action.run(signal => performance.stop(session.id, signal))}>停止会话</Button><Button variant="outline" disabled={!samplesAvailable || action.pending} onClick={() => void action.run(signal => performance.samples(session.id, { after: snapshot.nextAfter, limit: 100 }, signal))}>读取后续样本</Button></div>
      <PerformanceReadings readings={snapshot.readings} />
      <p className="muted">主进程指标与设备电气观测分别归属；净电池功率不是游戏独占功耗。历史样本没有逐点画面，画面关联请使用归档模式。</p>
      <JsonResult value={session} />
    </div>}
    <ActionFeedback {...action} />
    {waitJob && <p className="log-id">性能操作任务 ID：{waitJob}。取消等待不是取消该任务，也不停止性能会话；请在任务页查询实际状态。</p>}
    {snapshot.error !== action.error && <ErrorNotice error={snapshot.error} />}
    <h3>历史会话</h3>
    <div className="form-row"><Field label="读取性能会话 ID" value={restoreId} onChange={setRestoreId} hint="历史读取不要求当前设备在线" /><Button variant="outline" disabled={!inspectAvailable || !restoreId || action.pending} onClick={() => void action.run(signal => readSession(restoreId, signal))}>读取会话</Button><Button variant="outline" disabled={!listAvailable || history.pending} onClick={() => void history.run(signal => readHistory(false, signal))}>刷新历史</Button></div>
    {sessions.length > 0 ? <div className="table-scroll"><Table><TableHeader><TableRow><TableHead>会话 / 应用</TableHead><TableHead>设备 / 来源</TableHead><TableHead>状态 / 样本</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{sessions.map(item => <TableRow key={item.id}><TableCell>{item.request.target.package}<small style={{ display: 'block' }}>{item.id}</small></TableCell><TableCell>{item.request.target.device_id}<small style={{ display: 'block' }}>{item.source ? `${item.source.plugin_id} / ${item.source.generation}` : '历史未记录来源'}</small></TableCell><TableCell>{stateLabel[item.state]} · {item.samples} 点</TableCell><TableCell><Button size="sm" variant="ghost" disabled={!inspectAvailable || action.pending} onClick={() => void action.run(signal => readSession(item.id, signal))}>查看样本</Button></TableCell></TableRow>)}</TableBody></Table></div> : <EmptyState title="尚未读取会话历史" description="刷新历史或输入已知会话 ID；当前设备选择不会替换历史对象与来源。" />}
    <Button variant="outline" disabled={!historyCursor || !listAvailable || history.pending} onClick={() => void history.run(signal => readHistory(true, signal))}>下一页历史</Button>
    <ActionFeedback {...history} />
  </section>;
}

export function PerformancePage({ services }: { services: ProductServices }) {
  const devices = useSnapshot(services.runtime.devices);
  const [packageId, setPackageId] = useState('');
  const reference = devices.selected?.reference;
  const rootCompatible = reference?.providerId === 'android-device';
  return <section className="product-page"><PageTitle eyebrow="性能调试" title="性能与堆栈" description="持续指标会话与限时 Root 归档分开管理。所有结果来自公开服务，历史来源、空值和关联资格原样保留。" />
    <Field label="目标应用包名" value={packageId} onChange={setPackageId} placeholder="输入已运行的应用包名" hint={`当前设备：${devices.selected?.model ?? reference?.localId ?? '尚未选择'}。开始或探测只在点击时执行。`} />
    <Tabs defaultValue="session"><TabsList aria-label="性能工作范围"><TabsTrigger value="session">持续性能会话</TabsTrigger><TabsTrigger value="profile">限时画面与调用栈</TabsTrigger></TabsList><TabsContent value="session"><PerformanceSessionPanel services={services} devices={devices} packageId={packageId} /></TabsContent><TabsContent value="profile">{rootCompatible && reference ? <RootProfilePanel key={JSON.stringify(reference)} services={services} reference={reference} devices={devices} packageId={packageId} /> : <EmptyState title="请选择支持归档的设备" description="当前公开 Android 归档工厂要求 android-device 的完整设备引用；每项入口仍核对 stack.probe / profile.record v1 的声明、可用状态和权限。其他平台不猜测 Root 能力。" />}</TabsContent></Tabs>
  </section>;
}
