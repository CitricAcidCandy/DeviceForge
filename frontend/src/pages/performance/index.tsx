import { useEffect, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import { Checkbox } from '../../components/Checkbox/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SelectField,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/index.ts';
import {
  downloadAndOpenProfileArchive,
  downloadProfileArchive,
} from '../../features/android-profile/index.ts';
import type {
  AndroidProfile,
  OpenedProfileArchive,
  OpenedProfileFrame,
  ProfileReference,
  ProfileResult,
} from '../../features/android-profile/index.ts';
import {
  appIdentifierInput,
  capabilityGate,
  decodeDeviceBusinessResult,
  deviceAction,
  deviceKey,
  executeDeviceTask,
} from '../../features/device-apps/index.ts';
import type { PerformanceReading, PerformanceSession } from '../../features/performance/index.ts';
import { PerformanceJobFailure, PerformanceWaitFailure } from '../../features/performance/index.ts';
import type { PublishedResult } from '../../shared/jobs/index.ts';
import type { DeviceSnapshot } from '../../plugin-sdk/index.ts';
import { EmptyState, Field, JsonResult } from '../../components/index.ts';
import { OperationNotice, useOperationAvailable } from '../../app/product/capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../../app/product/feedback.tsx';
import { useAction, useSnapshot } from '../../app/product/hooks.ts';
import type { ProductServices } from '../../app/product/services.ts';
import { BlobDownload } from '../../components/BlobDownload/index.tsx';
import { PerformanceReadings, ProfileArchiveView, SampleBoard } from './components/index.ts';
import type { BoardSample } from './components/index.ts';

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

function useFrameUrls(frames: readonly OpenedProfileFrame[]): ReadonlyMap<string, string> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    const created = new Map<string, string>();
    for (const frame of frames) {
      created.set(frame.reference.filename, URL.createObjectURL(frame.content));
    }
    setUrls(created);
    return () => {
      for (const url of created.values()) URL.revokeObjectURL(url);
    };
  }, [frames]);
  return urls;
}

/** 归档里的每个采样点自带画面、指标与栈，直接构成五条轨迹的一列。 */
function archiveSamples(
  archive: OpenedProfileArchive,
  urls: ReadonlyMap<string, string>,
): { samples: readonly BoardSample[]; span: number } {
  const entries = archive.timeline.samples;
  const first = entries[0]?.sample.begin_ns;
  const origin = first ? BigInt(first) : 0n;
  const samples = entries.map((entry) => {
    const begin = BigInt(entry.sample.begin_ns) - origin;
    const filename = entry.sample.frame?.filename ?? null;
    return {
      id: `sample-${entry.sample.index}`,
      t: Number(begin / 1_000_000n) / 1000,
      fps: entry.sample.derived?.fps ?? null,
      cpu: entry.sample.derived?.cpu_share_percent ?? null,
      pssKib: entry.sample.metrics.pss_kib,
      rssKib: entry.sample.metrics.rss_kib ?? null,
      frameUrl: filename ? (urls.get(filename) ?? null) : null,
      stacks: entry.stacks.map((association) => association.sample),
      note: entry.stacks.length > 0 ? null : '无栈样本',
    } satisfies BoardSample;
  });
  const lastEntry = entries.at(-1);
  const span = lastEntry
    ? Number((BigInt(lastEntry.sample.end_ns) - origin) / 1_000_000n) / 1000
    : 0;
  return { samples, span };
}

function readingSamples(readings: readonly PerformanceReading[]): {
  samples: readonly BoardSample[];
  span: number;
} {
  const origin = readings[0]?.captured_at ?? 0;
  const samples = readings.map((reading) => ({
    id: `reading-${reading.sequence}`,
    t: (reading.captured_at - origin) / 1000,
    fps: reading.fps ?? null,
    cpu: reading.cpu_share_percent ?? null,
    pssKib: reading.pss_kib ?? null,
    rssKib: reading.rss_kib ?? null,
    frameUrl: null,
    stacks: [],
    note: null,
  }));
  const last = readings.at(-1);
  return { samples, span: last ? (last.captured_at - origin) / 1000 : 0 };
}

function useSelectedSample(count: number): [number, (index: number) => void] {
  const [selected, setSelected] = useState(0);
  const previous = useRef(count);
  useEffect(() => {
    if (previous.current !== count) {
      previous.current = count;
      setSelected(count > 0 ? count - 1 : 0);
    }
  }, [count]);
  return [Math.min(selected, Math.max(count - 1, 0)), setSelected];
}

function deviceOptions(devices: DeviceSnapshot) {
  return devices.directories.flatMap((directory) =>
    directory.devices
      .filter((device) => device.state === 'online')
      .map((device) => ({
        value: deviceKey({
          providerId: directory.provider.id,
          generation: directory.provider.generation,
          localId: device.reference.localId,
        }),
        label: `${device.model ?? device.reference.localId} · ${device.reference.localId}`,
      })),
  );
}

function SessionDrawer({
  sessions,
  current,
  readings,
  latest,
  session,
  services,
  loadId,
  onLoadIdChange,
  onLoad,
  onSelect,
  onRefresh,
  onNextPage,
  hasNext,
  pending,
}: {
  sessions: readonly PerformanceSession[];
  current: PerformanceSession | null;
  readings: readonly PerformanceReading[];
  latest: PerformanceReading | undefined;
  session: PerformanceSession | null;
  services: ProductServices;
  loadId: string;
  onLoadIdChange: (value: string) => void;
  onLoad: () => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onNextPage: () => void;
  hasNext: boolean;
  pending: boolean;
}) {
  const observation = latest?.device_observation ?? null;
  const frames = latest?.frame_window ?? null;
  return (
    <div className="flex flex-col gap-5 p-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-medium text-[color:var(--text-muted)]">会话历史</h3>
        <div className="flex items-end gap-2">
          <Field label="会话 ID" value={loadId} onChange={onLoadIdChange} placeholder="已知会话 ID" />
          <Button size="sm" variant="outline" disabled={!loadId || pending} onClick={onLoad}>
            读取
          </Button>
        </div>
        {sessions.length === 0 ? (
          <p className="text-[12px] text-[color:var(--text-faint)]">没有历史会话</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  data-current={item.id === current?.id}
                  disabled={pending}
                  onClick={() => onSelect(item.id)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1 text-left text-[13px] hover:bg-[color:var(--surface-hover)] data-[current=true]:bg-[color:var(--accent)]"
                >
                  <span className="truncate">{item.request.target.package}</span>
                  <span className="shrink-0 font-mono text-[12px] text-[color:var(--text-faint)]">
                    {stateLabel[item.state]} · {item.samples} 点
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={onRefresh}>
            刷新
          </Button>
          <Button size="sm" variant="ghost" disabled={!hasNext || pending} onClick={onNextPage}>
            下一页
          </Button>
        </div>
      </section>
      {readings.length > 0 && (
        <details>
          <summary className="text-[12px] font-medium text-[color:var(--text-muted)]">
            采样点明细 · {readings.length}
          </summary>
          <div className="pt-2">
            <PerformanceReadings readings={readings} />
          </div>
        </details>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-medium text-[color:var(--text-muted)]">设备观测</h3>
        {observation ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
            {(observation.temperatures ?? []).slice(0, 4).map((sensor) => (
              <div key={`${sensor.sensor_kind}-${sensor.sensor_name}-${sensor.observed_at}`}>
                <dt className="text-[12px] text-[color:var(--text-faint)]">{sensor.sensor_name}</dt>
                <dd className="font-mono">{sensor.temperature_celsius.toFixed(1)} °C</dd>
              </div>
            ))}
            {frames && (
              <div>
                <dt className="text-[12px] text-[color:var(--text-faint)]">帧窗口</dt>
                <dd className="font-mono">
                  {frames.frames} / {frames.duration_ms} ms
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-[12px] text-[color:var(--text-faint)]">本点无设备观测</p>
        )}
        <p className="font-mono text-[12px] text-[color:var(--text-ghost)]">
          {session?.source
            ? `${session.source.plugin_id} / ${session.source.generation}`
            : '来源未记录'}
        </p>
        <OperationNotice services={services} operation="android.performance.start" />
      </section>
      {session && (
        <details>
          <summary className="text-[12px] text-[color:var(--text-muted)]">原始会话</summary>
          <div className="pt-2">
            <JsonResult value={session} />
          </div>
        </details>
      )}
    </div>
  );
}

function CollectDialog({
  devices,
  services,
  packageId,
  onPackage,
  open,
  onOpenChange,
  onStarted,
}: {
  devices: DeviceSnapshot;
  services: ProductServices;
  packageId: string;
  onPackage: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: () => void;
}) {
  const operations = useSnapshot(services.runtime.operations);
  const action = useAction();
  const launcher = useAction();
  const [duration, setDuration] = useState('60');
  const [interval, setInterval] = useState('1000');
  const [launchApp, setLaunchApp] = useState(true);
  const reference = devices.selection;
  const ready = !!reference && packageId.trim().length > 0;
  const launchGate =
    reference === null
      ? null
      : capabilityGate(devices, operations.result?.data ?? [], 'app.start', null, reference);
  const busy = action.pending || launcher.pending;
  const submit = () =>
    void action.run(async (signal) => {
      const selectedDevice = devices.selected;
      if (!selectedDevice || !reference) throw new Error('尚未选择设备');
      if (launchApp) {
        if (!launchGate) throw new Error('当前设备不支持启动应用');
        await executeDeviceTask(
          services,
          'app.start',
          deviceAction(reference, launchGate, appIdentifierInput(launchGate, packageId)),
          signal,
          decodeDeviceBusinessResult,
        );
        if (signal.aborted) return null;
      }
      const result = await services.runtime.performance.start(
        {
          target: { device_id: reference.localId, package: packageId },
          interval_ms: Number(interval),
          duration_secs: Number(duration),
        },
        signal,
      );
      if (!signal.aborted) {
        onOpenChange(false);
        onStarted();
      }
      return result;
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>开始采集</DialogTitle>
          <DialogDescription>选择设备与应用，采集期间可随时暂停或终止。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <SelectField
            label="设备"
            value={reference ? deviceKey(reference) : undefined}
            placeholder="选择在线设备"
            options={deviceOptions(devices)}
            onValueChange={(value) => {
              const [providerId, generation, localId] = JSON.parse(value) as string[];
              if (providerId && generation && localId)
                void services.runtime.devices.select({ providerId, generation, localId });
            }}
          />
          <div className="form-grid">
            <Field
              label="应用包名"
              value={packageId}
              onChange={onPackage}
              placeholder="com.forge.arena"
            />
            <Field label="时长（秒）" type="number" min={1} max={3600} value={duration} onChange={setDuration} />
            <Field label="间隔（毫秒）" type="number" min={1000} max={60000} value={interval} onChange={setInterval} />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="collect-launch"
              checked={launchApp}
              onCheckedChange={(value) => setLaunchApp(value === true)}
            />
            <Label htmlFor="collect-launch">先启动应用</Label>
            {launchApp && !launchGate?.capability && (
              <span className="text-[12px] text-[color:var(--warning)]">
                {launchGate?.reason ?? '当前设备不支持启动应用'}
              </span>
            )}
          </div>
          <ActionFeedback {...launcher} />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={busy}>
              取消
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!ready || busy} onClick={submit}>
            开始采集
          </Button>
        </DialogFooter>
        <ActionFeedback {...action} />
      </DialogContent>
    </Dialog>
  );
}

function PerformanceSessionPanel({
  services,
  devices,
  packageId,
  onPackage,
}: {
  services: ProductServices;
  devices: DeviceSnapshot;
  packageId: string;
  onPackage: (value: string) => void;
}) {
  const performance = services.runtime.performance;
  const snapshot = useSnapshot(performance);
  const action = useAction();
  const history = useAction();
  const [open, setOpen] = useState(false);
  const [loadId, setLoadId] = useState('');
  const [sessions, setSessions] = useState<readonly PerformanceSession[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const startAvailable = useOperationAvailable(services, 'android.performance.start');
  const inspectAvailable = useOperationAvailable(services, 'android.performance.inspect');
  const samplesAvailable = useOperationAvailable(services, 'android.performance.samples');
  const pauseAvailable = useOperationAvailable(services, 'android.performance.pause');
  const resumeAvailable = useOperationAvailable(services, 'android.performance.resume');
  const stopAvailable = useOperationAvailable(services, 'android.performance.stop');
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
  // 状态色只给状态本身，包名、进度、点数据保持中性灰。
  const stateTone = running
    ? 'text-[color:var(--success)]'
    : paused
      ? 'text-[color:var(--warning)]'
      : 'text-[color:var(--text-faint)]';
  const waitJob =
    action.error instanceof PerformanceWaitFailure || action.error instanceof PerformanceJobFailure
      ? action.error.job.id
      : null;
  const readings = snapshot.readings;
  const tracks = readingSamples(readings);
  const [selected, onSelect] = useSelectedSample(tracks.samples.length);
  const latest = readings.at(-1);
  const fpsPoints = readings.flatMap((reading) => (reading.fps == null ? [] : [reading.fps]));
  const fpsPeak = peak(fpsPoints);
  const fpsAverage = fpsPoints.length
    ? fpsPoints.reduce((left, right) => left + right, 0) / fpsPoints.length
    : null;
  const fpsLow = fpsPoints.length
    ? fpsPoints.reduce((left, right) => (right < left ? right : left), fpsPoints[0] ?? 0)
    : null;
  const elapsed = tracks.span;
  const targetDuration = session
    ? session.request.duration_secs
    : readings.length > 0
      ? elapsed
      : 0;
  const progress = targetDuration > 0 ? Math.min(100, (elapsed / targetDuration) * 100) : 0;

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
          ? [...old, ...result.data.sessions.filter((item) => !old.some((e) => e.id === item.id))]
          : result.data.sessions,
      );
      setHistoryCursor(result.data.next_after_id ?? null);
    }
    return result;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 一行工具条：左边只读状态，右边动作按主次收成一组，换行也不会散开。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
          {session ? (
            <>
              <span className="flex min-w-0 items-center gap-x-2.5 font-mono text-[12px]">
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className={stateTone} aria-hidden>
                    ●
                  </span>
                  <span className={stateTone}>{stateLabel[session.state]}</span>
                </span>
                <span className="truncate text-[color:var(--text-muted)]">
                  {session.request.target.package}
                </span>
                <span className="shrink-0 tabular-nums text-[color:var(--text-muted)]">
                  {elapsed.toFixed(0)}s / {targetDuration}s
                </span>
                <span className="shrink-0 tabular-nums text-[color:var(--text-faint)]">
                  {readings.length} 点
                </span>
              </span>
              <div
                className="h-[3px] w-28 overflow-hidden rounded-full bg-[color:var(--surface-sunken)]"
                role="progressbar"
                aria-label="采集进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <div
                  className="h-full rounded-full bg-[color:var(--primary)]"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </>
          ) : (
            <span className="flex items-center gap-2 text-[13px] text-[color:var(--text-faint)]">
              <span
                className="size-1.5 rounded-full bg-[color:var(--hairline-strong)]"
                aria-hidden
              />
              尚未开始采集
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 rounded-[4px] bg-[color:var(--card)]"
              >
                <ListTree className="size-3.5" aria-hidden />
                会话与明细
              </Button>
            </SheetTrigger>
            <SheetContent className="w-full sm:max-w-[420px]">
              <SheetHeader>
                <SheetTitle>会话与明细</SheetTitle>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-auto">
                <SessionDrawer
                  sessions={sessions}
                  current={session}
                  readings={readings}
                  latest={latest}
                  session={session}
                  services={services}
                  loadId={loadId}
                  onLoadIdChange={setLoadId}
                  onLoad={() => {
                    if (loadId) void action.run((signal) => readSession(loadId, signal));
                  }}
                  onSelect={(id) => void action.run((signal) => readSession(id, signal))}
                  onRefresh={() => void history.run((signal) => readHistory(false, signal))}
                  onNextPage={() => void history.run((signal) => readHistory(true, signal))}
                  hasNext={!!historyCursor}
                  pending={action.pending}
                />
              </div>
            </SheetContent>
          </Sheet>
          {session && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={!pauseAvailable || !running || action.pending}
                onClick={() => void action.run((signal) => performance.pause(session.id, signal))}
              >
                暂停
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  !resumeAvailable ||
                  !paused ||
                  !sameSource ||
                  !snapshot.liveAvailable ||
                  snapshot.needsReconcile ||
                  action.pending
                }
                onClick={() => void action.run((signal) => performance.resume(session.id, signal))}
              >
                继续
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-[color:var(--destructive)] hover:bg-[color:var(--destructive)]/10 hover:text-[color:var(--destructive)]"
                disabled={!stopAvailable || !(running || paused) || action.pending}
                onClick={() => void action.run((signal) => performance.stop(session.id, signal))}
              >
                终止
              </Button>
            </>
          )}
          <span className="mx-1 h-5 w-px shrink-0 bg-[color:var(--hairline-strong)]" aria-hidden />
          <Button
            size="sm"
            variant={session ? 'outline' : 'default'}
            disabled={!startAvailable || action.pending}
            onClick={() => setOpen(true)}
          >
            {session ? '重新采集' : '开始采集'}
          </Button>
        </div>
      </div>
      <CollectDialog
        devices={devices}
        services={services}
        packageId={packageId}
        onPackage={onPackage}
        open={open}
        onOpenChange={setOpen}
        onStarted={() => {
          const id = services.runtime.performance.snapshot().session?.id;
          if (id) void action.run((signal) => readSession(id, signal));
        }}
      />
      <SampleBoard
        samples={tracks.samples}
        span={tracks.span}
        selected={selected}
        onSelect={onSelect}
        frameNote="无画面"
        stackNote="无栈样本"
      />
      {readings.length > 0 && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[13px] text-[color:var(--text-muted)]">
            <span>
              帧率 峰 {fpsPeak == null ? '—' : Math.round(fpsPeak)} · 均{' '}
              {fpsAverage == null ? '—' : Math.round(fpsAverage)} · 低{' '}
              {fpsLow == null ? '—' : Math.round(fpsLow)}
            </span>
            <span>
              CPU {readout(latest?.cpu_share_percent, '%')} · PSS {kibToGb(latest?.pss_kib)} · RSS{' '}
              {kibToGb(latest?.rss_kib)}
            </span>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              disabled={!inspectAvailable || action.pending}
              onClick={() => void action.run((signal) => performance.refresh(signal))}
            >
              重查状态
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!samplesAvailable || action.pending}
              onClick={() =>
                void action.run((signal) =>
                  performance.samples(
                    session?.id ?? '',
                    { after: snapshot.nextAfter, limit: 100 },
                    signal,
                  ),
                )
              }
            >
              追加样本
            </Button>
          </div>
        </>
      )}
      {!snapshot.liveAvailable && (
        <p className="px-1 text-[12px] text-[color:var(--warning)]">
          来源观测已撤销，请先在设备页刷新目录。
        </p>
      )}
      {session?.error && <p className="px-1 text-[12px] text-[color:var(--warning)]">{session.error}</p>}
      {snapshot.needsReconcile && (
        <p className="px-1 text-[12px] text-[color:var(--warning)]">上次控制未确认，先重查状态。</p>
      )}
      <ActionFeedback {...action} />
      {waitJob && (
        <p className="px-1 font-mono text-[12px] text-[color:var(--text-ghost)]">任务 {waitJob}</p>
      )}
      {snapshot.error !== action.error && <ErrorNotice error={snapshot.error} />}
    </div>
  );
}

function RootProfilePanel({
  services,
  reference,
  packageId,
}: {
  services: ProductServices;
  reference: ProfileReference;
  packageId: string;
}) {
  const resources = useRef<{ profile: AndroidProfile; lifetime: AbortController } | null>(null);
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
  const [published, setPublished] = useState<PublishedResult<ProfileResult> | null>(null);
  const [archive, setArchive] = useState<OpenedProfileArchive | null>(null);
  const [zip, setZip] = useState<Blob | null>(null);
  const [jobId, setJobId] = useState('');
  const [restoreId, setRestoreId] = useState('');
  const urls = useFrameUrls(archive?.frames ?? []);
  const tracks = archive ? archiveSamples(archive, urls) : { samples: [], span: 0 };
  const [selected, onSelect] = useSelectedSample(tracks.samples.length);
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-wrap items-end gap-2 rounded-[12px] border border-[color:var(--hairline)] bg-[color:var(--card)] p-3">
        <Field label="时长（秒）" type="number" min={1} max={15} value={duration} onChange={setDuration} />
        <Field label="间隔（毫秒）" type="number" min={1000} max={15000} value={interval} onChange={setInterval} />
        <div className="flex h-9 items-center gap-2">
          <Checkbox
            id="profile-capture-frames"
            checked={captureFrames}
            onCheckedChange={(value) => setCaptureFrames(value === true)}
          />
          <Label htmlFor="profile-capture-frames">采样画面</Label>
        </div>
        <div className="flex-1" />
        <Sheet>
          <SheetTrigger asChild>
            <Button size="sm" variant="ghost">
              归档与导出
            </Button>
          </SheetTrigger>
          <SheetContent className="w-full sm:max-w-[460px]">
            <SheetHeader>
              <SheetTitle>归档与导出</SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
              <div className="flex items-end gap-2">
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
                  恢复
                </Button>
              </div>
              {published && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={downloader.pending || action.pending}
                    onClick={() =>
                      void downloader.run((signal) =>
                        openPublished(published, requestContext(signal).signal),
                      )
                    }
                  >
                    重新验证并读取
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
                  {zip && <BlobDownload blob={zip} filename="profile.zip" label="下载 ZIP" />}
                </div>
              )}
              {jobId && (
                <p className="font-mono text-[12px] text-[color:var(--text-ghost)]">任务 {jobId}</p>
              )}
              {archive && <ProfileArchiveView archive={archive} />}
              {published && <JsonResult value={published.result} />}
              <ActionFeedback {...downloader} />
            </div>
          </SheetContent>
        </Sheet>
        <Button
          size="sm"
          disabled={!packageId || action.pending || downloader.pending}
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
          录制归档
        </Button>
      </div>
      {archive ? (
        <SampleBoard
          samples={tracks.samples}
          span={tracks.span}
          selected={selected}
          onSelect={onSelect}
          frameNote="无画面"
          stackNote="无栈样本"
        />
      ) : (
        <p className="px-1 text-[13px] text-[color:var(--text-faint)]">
          {packageId ? '录制完成后在这里按采样点回看画面、指标与栈。' : '先填写目标应用包名。'}
        </p>
      )}
      <ActionFeedback {...action} />
    </div>
  );
}

type Source = 'session' | 'archive';

// 模式切换按页头下划线 tab 处理：标题和切换共用一条发丝线，指示条压在线上的那 2px。
const modeTabClass = [
  'relative flex h-8 items-end px-0.5 pb-2.5 text-[13px] leading-none',
  'text-[color:var(--text-muted)] transition-colors',
  'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-[color:var(--primary)]',
  'after:opacity-0 after:transition-opacity',
  'hover:text-[color:var(--text-strong)]',
  'aria-pressed:text-[color:var(--text-strong)] aria-pressed:after:opacity-100',
].join(' ');

export function PerformancePage({ services }: { services: ProductServices }) {
  const devices = useSnapshot(services.runtime.devices);
  const [packageId, setPackageId] = useState('');
  const [source, setSource] = useState<Source>('session');
  const reference = devices.selected?.reference;
  const rootCompatible = reference?.providerId === 'android-device';
  return (
    <section
      className="product-page performance-page flex min-h-[560px] flex-1 flex-col gap-3"
      data-product-page="performance"
      aria-label="性能与调用栈"
    >
      {/* 页头用一条发丝线收口：标题停在线上，模式切换压在这条线上，不再是一块浮在角落的胶囊。 */}
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-[color:var(--hairline)]">
        <h1 className="pb-2 text-[24px] font-semibold leading-tight text-[color:var(--text-strong)]">
          性能与调用栈
        </h1>
        <div role="group" aria-label="采集方式" className="flex items-center gap-5">
          {(
            [
              ['session', '持续采样'],
              ['archive', '归档录制'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={source === value}
              onClick={() => setSource(value)}
              className={modeTabClass}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {source === 'session' ? (
          <PerformanceSessionPanel
            services={services}
            devices={devices}
            packageId={packageId}
            onPackage={setPackageId}
          />
        ) : rootCompatible && reference ? (
          <RootProfilePanel
            key={JSON.stringify(reference)}
            services={services}
            reference={reference}
            packageId={packageId}
          />
        ) : (
          <EmptyState title="需要 Android 设备" description="归档录制只支持 Android 设备。" />
        )}
      </div>
    </section>
  );
}
