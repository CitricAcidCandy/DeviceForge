import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button/index.tsx';
import { Checkbox } from '../../components/Checkbox/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/Tabs/index.tsx';
import {
  downloadAndOpenProfileArchive,
  downloadProfileArchive,
  JobFailure,
  JobWaitFailure,
} from '../../features/android-profile/index.ts';
import type {
  AndroidProfile,
  OpenedProfileArchive,
  ProbeResult,
  ProfileReference,
  ProfileResult,
} from '../../features/android-profile/index.ts';
import type {
  PerformanceCapabilities,
  PerformanceReading,
  PerformanceSession,
} from '../../features/performance/index.ts';
import { PerformanceJobFailure, PerformanceWaitFailure } from '../../features/performance/index.ts';
import type { PublishedResult } from '../../shared/jobs/index.ts';
import type { DeviceSnapshot } from '../../plugin-sdk/index.ts';
import { EmptyState, Field, JsonResult } from '../../components/index.ts';
import { OperationNotice, useOperationAvailable } from '../../app/product/capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { BlobDownload } from '../../components/BlobDownload/index.tsx';
import { ProfileArchiveView, PerformanceReadings } from './components/index.ts';
import './workspace.css';

function capabilityReason(
  devices: DeviceSnapshot,
  capability: string,
  versions: readonly number[],
  operation?: string,
): string | null {
  const selected = devices.selected;
  if (!selected) return '先在顶部选择设备。';
  if (selected.state !== 'online')
    return selected.state === 'unauthorized'
      ? '当前设备尚未授权。'
      : '当前设备不在线，保留历史读取。';
  const provider = devices.providers.find(
    (item) =>
      item.id === selected.reference.providerId &&
      item.generation === selected.reference.generation,
  );
  if (!provider) return '设备提供者已移除或换代，请刷新目录。';
  const declared = provider.definition.capabilities.find(
    (item) =>
      item.id === capability &&
      versions.includes(item.version) &&
      item.scope === 'device' &&
      (operation === undefined || item.operation === operation),
  );
  if (!declared) return `提供者没有声明受支持的 ${capability} 设备能力。`;
  const available = selected.capabilities.find(
    (item) => item.id === declared.id && item.version === declared.version,
  );
  if (!available?.available)
    return available?.reason ?? `当前设备不能使用 ${capability} v${declared.version}。`;
  return null;
}

const stateLabel: Record<PerformanceSession['state'], string> = {
  running: '运行中',
  paused: '已暂停',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

// 读数一律按"有值就报、没值就留空"，不用 0 或占位数字冒充观测。
function readout(value: number | null | undefined, unit: string, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${digits > 0 ? value.toFixed(digits) : Math.round(value)} ${unit}`;
}

function kibToGb(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${(value / 1024 / 1024).toFixed(2)} GB`;
}

function peak(points: readonly number[]): number | null {
  if (!points.length) return null;
  return points.reduce((left, right) => (right > left ? right : left), points[0] ?? 0);
}

function RootProfilePanel({
  services,
  reference,
  devices,
  packageId,
}: {
  services: ProductServices;
  reference: ProfileReference;
  devices: DeviceSnapshot;
  packageId: string;
}) {
  const resources = useRef<{ profile: AndroidProfile; lifetime: AbortController } | null>(null);
  // 在作用域内创建，StrictMode 重放也取得新的可用实例，不复用已释放的 runner。
  useEffect(() => {
    const owned = { profile: services.profile(reference), lifetime: new AbortController() };
    resources.current = owned;
    return () => {
      owned.lifetime.abort();
      owned.profile.dispose();
      if (resources.current === owned) resources.current = null;
    };
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
  const recordReason = capabilityReason(
    devices,
    'profile.record',
    [1],
    'plugin.android-device.profile.record',
  );
  const currentProbe = probe?.package === packageId ? probe : null;
  const waitJob =
    action.error instanceof JobWaitFailure || action.error instanceof JobFailure
      ? action.error.job.id
      : null;
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

  return (
    <section className="profile-workspace" aria-label="Root 堆栈录制">
      <aside className="profile-rail" aria-label="归档配置">
        <h3>归档配置</h3>
        <p className="rail-note">
          固定目标 <span className="mono">{reference.localId}</span> · 提供者{' '}
          <span className="mono">{reference.providerId}</span> · 代次{' '}
          <span className="mono">{reference.generation}</span>
        </p>
        <div className="perf-rail-row">
          <Field label="时长（秒）" type="number" min={1} max={15} value={duration} onChange={setDuration} hint="1–15 秒" />
          <Field label="间隔（毫秒）" type="number" min={1000} max={15000} value={interval} onChange={setInterval} hint="≥1000" />
        </div>
        <div className="perf-check">
          <Checkbox
            id="profile-capture-frames"
            checked={captureFrames}
            onCheckedChange={(value) => setCaptureFrames(value === true)}
          />
          <Label htmlFor="profile-capture-frames">采样画面</Label>
        </div>
        <div className="perf-rail-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={!!probeReason || !packageId || action.pending}
            onClick={() =>
              void action.run(async (signal) => {
                const { profile, signal: combined } = requestContext(signal);
                const result = await profile.probe(packageId, combined);
                if (!combined.aborted) setProbe(result.data);
                return result;
              })
            }
          >
            检查录制资格
          </Button>
          <Button
            size="sm"
            disabled={!!recordReason || !packageId || action.pending || downloader.pending}
            onClick={() =>
              void action.run(async (signal) => {
                const { profile, signal: combined } = requestContext(signal);
                setPublished(null);
                setArchive(null);
                setZip(null);
                setJobId('');
                const result = await profile.record(
                  {
                    package: packageId,
                    duration_ms: Number(duration) * 1000,
                    interval_ms: Number(interval),
                    capture_frames: captureFrames,
                  },
                  combined,
                );
                if (combined.aborted) return result;
                setJobId(result.job.id);
                setPublished(result.data);
                return openPublished(result.data, combined);
              })
            }
          >
            开始录制
          </Button>
        </div>
        {probeReason && <p className="capability-notice">{probeReason}</p>}
        {recordReason && <p className="capability-notice">{recordReason}</p>}
        {currentProbe && (
          <p className="rail-note" role="status">
            Root {currentProbe.root_access} · Simpleperf {currentProbe.simpleperf_available ? '可用' : '不可用'} ·{' '}
            {currentProbe.supported ? '具备探测资格' : '资格不足'}
          </p>
        )}
        <details className="perf-notes">
          <summary>恢复已有录制</summary>
          <Field label="录制任务 ID" value={restoreId} onChange={setRestoreId} />
          <Button
            variant="outline"
            size="sm"
            disabled={!restoreId || !packageId || action.pending || downloader.pending}
            onClick={() =>
              void action.run(async (signal) => {
                const { profile, signal: combined } = requestContext(signal);
                const job = await services.runtime.tasks.get(restoreId, combined);
                if (job.data.operation !== 'plugin.android-device.profile.record')
                  throw new Error('所选任务不是 Android 性能归档录制');
                const result = await profile.resumeRecording(
                  { id: job.data.id, operation: job.data.operation, submitLogId: null },
                  packageId,
                  combined,
                );
                if (combined.aborted) return result;
                setJobId(result.job.id);
                setPublished(result.data);
                setArchive(null);
                setZip(null);
                return openPublished(result.data, combined);
              })
            }
          >
            恢复并读取归档
          </Button>
        </details>
        {(jobId || waitJob) && <p className="log-id">录制任务 ID：{jobId || waitJob}</p>}
        <ActionFeedback {...action} />
      </aside>
      <div className="profile-stage">
        {published && (
          <div className="perf-rail-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={downloader.pending || action.pending}
              onClick={() =>
                void downloader.run((signal) => openPublished(published, requestContext(signal).signal))
              }
            >
              重新验证并读取归档
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={downloader.pending || action.pending}
              onClick={() =>
                void downloader.run(async (signal) => {
                  const combined = requestContext(signal).signal;
                  const result = await downloadProfileArchive(
                    services.runtime.artifacts,
                    published,
                    combined,
                  );
                  if (!combined.aborted) setZip(result.data);
                  return { logId: result.logId };
                })
              }
            >
              准备原始 ZIP
            </Button>
            {zip && <BlobDownload blob={zip} filename="profile.zip" label="下载已验证原始 ZIP" />}
          </div>
        )}
        <ActionFeedback {...downloader} />
        {archive ? (
          <ProfileArchiveView archive={archive} />
        ) : (
          <EmptyState
            title="等待录制结果"
            description="完成录制或恢复任务后，在这里查看画面与调用栈。"
          />
        )}
        {published && (
          <details className="perf-notes">
            <summary>原始结果</summary>
            <JsonResult value={published.result} />
          </details>
        )}
      </div>
    </section>
  );
}

function SessionRail({
  sessions, current, onSelect, onLoadId, loadId, onLoadIdChange, canInspect, pending,
  onRefreshHistory, onNextPage, hasNext,
}: {
  sessions: readonly PerformanceSession[];
  current: PerformanceSession | null;
  onSelect(id: string): void;
  onLoadId(): void;
  loadId: string;
  onLoadIdChange(value: string): void;
  canInspect: boolean;
  pending: boolean;
  onRefreshHistory(): void;
  onNextPage(): void;
  hasNext: boolean;
}) {
  const entries = current && !sessions.some((item) => item.id === current.id)
    ? [current, ...sessions]
    : sessions;
  return (
    <aside className="perf-rail" aria-label="性能会话">
      <span className="perf-rail-label">会话</span>
      {entries.length === 0 ? (
        <p className="rail-note">还没有读入会话。开始采集或刷新历史。</p>
      ) : (
        <ul className="perf-session-list">
          {entries.map((item) => {
            const live = item.id === current?.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="perf-session-entry"
                  data-current={live}
                  disabled={pending}
                  onClick={() => onSelect(item.id)}
                  title={item.id}
                >
                  <span className="perf-session-name">{item.request.target.package}</span>
                  <span className="perf-session-meta">
                    {stateLabel[item.state]} · {item.samples} 点 ·{' '}
                    {new Date(item.started_at).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                    })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="perf-rail-foot">
        <Button size="sm" variant="ghost" disabled={pending} onClick={onRefreshHistory}>
          刷新历史
        </Button>
        <Button size="sm" variant="ghost" disabled={!hasNext || pending} onClick={onNextPage}>
          下一页
        </Button>
      </div>
      <details className="perf-notes">
        <summary>按会话 ID 读取</summary>
        <Field label="会话 ID" value={loadId} onChange={onLoadIdChange} placeholder="已知会话 ID" />
        <Button size="sm" variant="outline" disabled={!canInspect || !loadId || pending} onClick={onLoadId}>
          读取会话
        </Button>
      </details>
    </aside>
  );
}

function FpsChart({ readings }: { readings: readonly PerformanceReading[] }) {
  const series = readings.filter((reading) => reading.fps != null);
  const top = peak(series.map((reading) => reading.fps ?? 0)) ?? 0;
  const ceiling = Math.max(top, 1);
  return (
    <div className="fps-chart" role="img" aria-label={`帧率采样 ${series.length} 点，峰值 ${Math.round(top)}`}>
      {series.length === 0 ? (
        <span className="fps-chart-empty">本次会话没有取得帧率观测</span>
      ) : (
        series.map((reading) => {
          const value = reading.fps ?? 0;
          return (
            <span
              key={reading.sequence}
              className="fps-bar"
              style={{ height: `${Math.max(6, (value / ceiling) * 100)}%` }}
              title={`#${reading.sequence} · ${value.toFixed(1)} FPS · ${new Date(reading.captured_at).toLocaleTimeString('zh-CN')}`}
            />
          );
        })
      )}
    </div>
  );
}

function ObservationColumn({ reading, session }: {
  reading: PerformanceReading | undefined;
  session: PerformanceSession | null;
}) {
  const observation = reading?.device_observation ?? null;
  const temperatures = observation?.temperatures ?? [];
  const battery = observation?.battery ?? null;
  const frames = reading?.frame_window ?? null;
  const latestIndex = reading ? `#${reading.sequence}` : '—';
  return (
    <aside className="perf-observe" aria-label="设备观测">
      <span className="perf-rail-label">设备观测 · {latestIndex}</span>
      {!observation ? (
        <p className="rail-note">
          最新采样点没有设备级观测。温度、电池与帧窗口只在来源支持时出现，不用估算补齐。
        </p>
      ) : (
        <>
          <dl className="observe-grid">
            {temperatures.slice(0, 4).map((sensor) => (
              <div key={`${sensor.sensor_kind}-${sensor.sensor_name}-${sensor.observed_at}`}>
                <dt>
                  {sensor.sensor_kind} · {sensor.sensor_name}
                </dt>
                <dd className="mono">{sensor.temperature_celsius.toFixed(1)} °C</dd>
              </div>
            ))}
            {battery && (
              <div>
                <dt>电池 · {battery.status ?? battery.supply_state}</dt>
                <dd className="mono">
                  {readout(battery.voltage_uv == null ? null : battery.voltage_uv / 1_000_000, 'V', 2)}
                </dd>
              </div>
            )}
            {frames && (
              <div>
                <dt>帧窗口 · {frames.source}</dt>
                <dd className="mono">
                  {frames.frames} / {frames.duration_ms} ms
                </dd>
              </div>
            )}
          </dl>
          <p className="rail-note">观测来自 {observation.device_id}，与主进程指标分开采集。</p>
        </>
      )}
      <div className="perf-observe-sep" />
      <span className="perf-rail-label">来源</span>
      <p className="rail-note mono">
        {session?.source
          ? `${session.source.plugin_id} / ${session.source.generation}`
          : '历史未记录来源'}
      </p>
      <p className="rail-note">
        连续会话不保存逐点画面；需要画面与调用栈关联时，用「画面与调用栈」归档录制。
      </p>
    </aside>
  );
}

function PerformanceSessionPanel({
  services,
  devices,
  packageId,
}: {
  services: ProductServices;
  devices: DeviceSnapshot;
  packageId: string;
}) {
  const performance = services.runtime.performance;
  const snapshot = useSnapshot(performance);
  const action = useAction();
  const history = useAction();
  const [duration, setDuration] = useState('60');
  const [interval, setInterval] = useState('1000');
  const [restoreId, setRestoreId] = useState('');
  const [sessions, setSessions] = useState<readonly PerformanceSession[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<{
    key: string;
    data: PerformanceCapabilities;
  } | null>(null);
  const sourceKey = devices.selection ? JSON.stringify(devices.selection) : 'none';
  const previousKey = useRef(sourceKey);
  useEffect(() => {
    if (previousKey.current !== sourceKey) {
      action.cancel();
      setCapabilities(null);
      previousKey.current = sourceKey;
    }
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
  const sameSource =
    !!sourceDevice &&
    !!devices.selection &&
    sourceDevice.provider_id === devices.selection.providerId &&
    sourceDevice.generation === devices.selection.generation &&
    sourceDevice.local_id === devices.selection.localId;
  const running = session?.state === 'running';
  const paused = session?.state === 'paused';
  const waitJob =
    action.error instanceof PerformanceWaitFailure || action.error instanceof PerformanceJobFailure
      ? action.error.job.id
      : null;
  const readings = snapshot.readings;
  const latest = readings.at(-1);
  const fpsPoints = readings.flatMap((reading) => (reading.fps == null ? [] : [reading.fps]));
  const fpsPeak = peak(fpsPoints);
  const fpsAverage = fpsPoints.length
    ? fpsPoints.reduce((left, right) => left + right, 0) / fpsPoints.length
    : null;
  const fpsLow = fpsPoints.length
    ? fpsPoints.reduce((left, right) => (right < left ? right : left), fpsPoints[0] ?? 0)
    : null;

  async function readSession(id: string, signal: AbortSignal) {
    const result = await performance.select(id, signal);
    if (samplesAvailable && !signal.aborted)
      await performance.samples(id, { after: 0, limit: 100 }, signal);
    return result;
  }

  async function readHistory(next: boolean, signal: AbortSignal) {
    const result = await performance.list({ afterId: next ? historyCursor : null, limit: 25 }, signal);
    if (!signal.aborted) {
      setSessions((old) =>
        next
          ? [
              ...old,
              ...result.data.sessions.filter((item) => !old.some((existing) => existing.id === item.id)),
            ]
          : result.data.sessions,
      );
      setHistoryCursor(result.data.next_after_id ?? null);
    }
    return result;
  }

  return (
    <div className="perf-grid">
      <SessionRail
        sessions={sessions}
        current={session}
        onSelect={(id) => void action.run((signal) => readSession(id, signal))}
        loadId={restoreId}
        onLoadIdChange={setRestoreId}
        onLoadId={() => {
          if (restoreId) void action.run((signal) => readSession(restoreId, signal));
        }}
        canInspect={inspectAvailable}
        pending={action.pending}
        onRefreshHistory={() => void history.run((signal) => readHistory(false, signal))}
        onNextPage={() => void history.run((signal) => readHistory(true, signal))}
        hasNext={!!historyCursor}
      />
      <div className="perf-metrics">
        <OperationNotice services={services} operation="android.performance.start" />
        {!snapshot.liveAvailable && (
          <p className="capability-notice">
            来源观测已撤销。先在设备页刷新提供者与目录；历史查询和停止不受此标记阻断。
          </p>
        )}
        {!session ? (
          <EmptyState
            title="等待采样"
            description="在右侧配置采集参数后开始，或从左侧读入历史会话。"
          />
        ) : (
          <>
            <div className="perf-metric-head">
              <span className="perf-metric-title">
                帧率 FPS
                <small>
                  峰值 {fpsPeak == null ? '—' : Math.round(fpsPeak)} · 平均{' '}
                  {fpsAverage == null ? '—' : Math.round(fpsAverage)} · 最低{' '}
                  {fpsLow == null ? '—' : Math.round(fpsLow)} · {readings.length} 点
                </small>
              </span>
            </div>
            <FpsChart readings={readings} />
            <dl className="perf-readouts">
              <div>
                <dt>CPU 占用</dt>
                <dd className="mono">{readout(latest?.cpu_share_percent, '%')}</dd>
              </div>
              <div>
                <dt>CPU 核心</dt>
                <dd className="mono">{readout(latest?.cpu_core_percent, '%')}</dd>
              </div>
              <div>
                <dt>内存 PSS</dt>
                <dd className="mono">{kibToGb(latest?.pss_kib)}</dd>
              </div>
              <div>
                <dt>内存 RSS</dt>
                <dd className="mono">{kibToGb(latest?.rss_kib)}</dd>
              </div>
              <div>
                <dt>净电池功率</dt>
                <dd className="mono">{readout(latest?.battery_net_power_mw, 'mW')}</dd>
              </div>
              <div>
                <dt>会话</dt>
                <dd className="mono">
                  {stateLabel[session.state]} · rev {session.revision}
                </dd>
              </div>
            </dl>
            <div className="perf-metric-foot">
              <span className="mono">{session.id}</span>
              <span>
                {session.request.target.package} · {session.request.target.device_id} ·{' '}
                {session.request.duration_secs}s / {session.request.interval_ms}ms
              </span>
            </div>
            {session.error && (
              <p className="capability-notice" role="alert">
                {session.error}
              </p>
            )}
            {snapshot.needsReconcile && (
              <p className="rail-note" role="status">
                上次控制结果未确认。先重查实际状态，再恢复，不自动重放控制。
              </p>
            )}
            {paused && !sameSource && (
              <p className="rail-note">
                当前设备引用与会话来源不一致或来源未记录，不能凭当前目录恢复旧代采集；可重查历史或停止。
              </p>
            )}
            <div className="perf-metric-actions">
              <Button size="sm" variant="ghost" disabled={!inspectAvailable || action.pending}
                onClick={() => void action.run((signal) => performance.refresh(signal))}>
                重查状态
              </Button>
              <Button size="sm" variant="ghost" disabled={!samplesAvailable || action.pending}
                onClick={() => void action.run((signal) =>
                  performance.samples(session.id, { after: snapshot.nextAfter, limit: 100 }, signal))}>
                读取后续样本
              </Button>
            </div>
            <details className="perf-notes">
              <summary>全部采样点 · {readings.length}</summary>
              <PerformanceReadings readings={readings} />
            </details>
            <details className="perf-notes">
              <summary>指标说明与原始会话</summary>
              <p className="rail-note">
                主进程指标与设备电气观测分别归属；净电池功率不是游戏独占功耗。历史样本没有逐点画面。
              </p>
              <JsonResult value={session} />
            </details>
          </>
        )}
        <ActionFeedback {...action} />
        {waitJob && (
          <p className="log-id">
            性能操作任务 ID：{waitJob}。取消等待不是取消该任务，也不停止性能会话。
          </p>
        )}
        {snapshot.error !== action.error && <ErrorNotice error={snapshot.error} />}
      </div>
      <div className="perf-side">
        <div className="perf-controls">
          <div className="perf-control-row">
            <Field label="时长（秒）" type="number" min={1} max={3600} value={duration} onChange={setDuration} />
            <Field label="间隔（毫秒）" type="number" min={1000} max={60000} value={interval} onChange={setInterval} />
          </div>
          {samplingReason && <p className="capability-notice">{samplingReason}</p>}
          <div className="perf-control-actions">
            <Button
              size="sm"
              disabled={
                !startAvailable || !!samplingReason || !snapshot.liveAvailable || !packageId || action.pending
              }
              onClick={() =>
                void action.run(async (signal) => {
                  const selected = devices.selected;
                  if (!selected) throw new Error('尚未选择设备');
                  const result = await performance.start(
                    {
                      target: { device_id: selected.reference.localId, package: packageId },
                      interval_ms: Number(interval),
                      duration_secs: Number(duration),
                    },
                    signal,
                  );
                  if (!signal.aborted) await readSession(result.data.id, signal);
                  return result;
                })
              }
            >
              开始采集
            </Button>
            <Button size="sm" variant="ghost" disabled={!pauseAvailable || !running || action.pending}
              onClick={() => void action.run((signal) => performance.pause(session?.id ?? '', signal))}>
              暂停
            </Button>
            <Button size="sm" variant="ghost"
              disabled={
                !resumeAvailable || !paused || !sameSource || !!samplingReason ||
                !snapshot.liveAvailable || snapshot.needsReconcile || action.pending
              }
              onClick={() => void action.run((signal) => performance.resume(session?.id ?? '', signal))}>
              继续
            </Button>
            <Button size="sm" variant="destructive" disabled={!stopAvailable || !(running || paused) || action.pending}
              onClick={() => void action.run((signal) => performance.stop(session?.id ?? '', signal))}>
              停止
            </Button>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={!capabilitiesAvailable || !!samplingReason || !snapshot.liveAvailable || action.pending}
            onClick={() =>
              void action.run(async (signal) => {
                const result = await performance.capabilities(signal);
                if (!signal.aborted) setCapabilities({ key: sourceKey, data: result.data });
                return result;
              })
            }
          >
            查询采样能力
          </Button>
          {capabilities?.key === sourceKey && (
            <p className="rail-note">
              来源 {capabilities.data.sourceLabel} · 主进程 · {capabilities.data.metrics.join('、')} · 上限{' '}
              {capabilities.data.maxSamples} 点
            </p>
          )}
        </div>
        <ObservationColumn reading={latest} session={session} />
      </div>
    </div>
  );
}

export function PerformancePage({ services }: { services: ProductServices }) {
  const devices = useSnapshot(services.runtime.devices);
  const [packageId, setPackageId] = useState('');
  const reference = devices.selected?.reference;
  const rootCompatible = reference?.providerId === 'android-device';
  const target = devices.selected;
  return (
    <section className="product-page performance-page" data-product-page="performance" aria-label="性能与调用栈">
      <header className="perf-topline">
        <div className="perf-topline-main">
          <h1>性能会话</h1>
          <span className="perf-topline-meta mono">
            {target ? target.reference.localId : '未选择设备'}
            {target?.model ? ` · ${target.model}` : ''}
          </span>
        </div>
        <div className="perf-topline-target">
          <Field
            label="目标应用包名"
            value={packageId}
            onChange={setPackageId}
            placeholder="已运行的应用包名"
          />
        </div>
      </header>
      <Tabs defaultValue="session">
        <TabsList aria-label="性能工作范围" className="perf-tabs">
          <TabsTrigger value="session">持续采样</TabsTrigger>
          <TabsTrigger value="profile">画面与调用栈</TabsTrigger>
        </TabsList>
        <TabsContent value="session">
          <PerformanceSessionPanel services={services} devices={devices} packageId={packageId} />
        </TabsContent>
        <TabsContent value="profile">
          {rootCompatible && reference ? (
            <RootProfilePanel
              key={JSON.stringify(reference)}
              services={services}
              reference={reference}
              devices={devices}
              packageId={packageId}
            />
          ) : (
            <EmptyState
              title="请选择支持归档的设备"
              description="选择支持画面与调用栈录制的 Android 设备。"
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
