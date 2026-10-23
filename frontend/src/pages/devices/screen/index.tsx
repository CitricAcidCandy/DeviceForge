import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { Camera, Download, LayoutGrid, Maximize2, Play, SlidersHorizontal } from 'lucide-react';
import { Button } from '../../../components/Button/index.tsx';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../../components/Dialog/index.tsx';
import { Switch } from '../../../components/Switch/index.tsx';
import { Label } from '../../../components/Label/index.tsx';
import {
  createJobRunner,
  decodeArtifactEnvelope,
  downloadPublishedArtifact,
} from '../../../shared/jobs/index.ts';
import { EmptyState, Field, JsonResult } from '../../../components/index.ts';
import { cn } from '../../../utils/classnames.ts';
import { useOperationAvailable } from '../../../app/product/capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../../../app/product/feedback.tsx';
import { errorLogId, useAction, useSnapshot } from '../../../app/product/hooks.ts';
import { withSelectedDevice } from '../../../app/product/device-target.ts';
import { capabilityGate } from '../../../features/device-apps/index.ts';
import { createMediaControlQueue } from './media-controls.ts';
import { useMediaKeyboard } from './use-media-keyboard.ts';
import { useMediaClipboard } from './use-media-clipboard.ts';
import { MediaOwnershipControls } from './MediaOwnershipControls/index.tsx';
import { createMediaShareUrl, parseMediaShare, resolveMediaShareControl } from './media-share.ts';
import { useBlobUrl } from '../../../components/BlobDownload/index.tsx';
import { DeviceApps } from '../apps/index.tsx';
import type { ProductServices } from '../../../app/product/services.ts';
import type { MirroringControl } from '../../../features/mirroring-streaming/index.ts';
import type { DeviceRef } from '../../../plugin-sdk/index.ts';
import './workspace.css';

/** 右栏两个面：画面参数与应用。舞台常驻，切面不覆盖画面。 */
export type WorkbenchPane = 'params' | 'apps';

/* 画面缩放的取值范围与存档键：拖动画面四角的弧线来改。 */
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.05;
const ZOOM_STORAGE_KEY = 'deviceforge.device-screen.zoom';
/* 四个角各自往外拖才是放大：左下角往左、往下拖就是放大。 */
const CORNERS = {
  nw: [-1, -1],
  ne: [1, -1],
  sw: [-1, 1],
  se: [1, 1],
} as const;
type Corner = keyof typeof CORNERS;
/*
 * 弧线的落位：整块 34×34 的命中区摆到机身外面 18px 处，弧线朝外鼓、两端压在机身边上。
 * 旋转 90° 就把同一条弧线交给下一个角，不用画四份路径。
 */
const CORNER_STYLE: Record<Corner, string> = {
  nw: '-left-[18px] -top-[18px] cursor-nwse-resize',
  ne: '-right-[18px] -top-[18px] rotate-90 cursor-nesw-resize',
  se: '-right-[18px] -bottom-[18px] rotate-180 cursor-nwse-resize',
  sw: '-left-[18px] -bottom-[18px] rotate-[270deg] cursor-nesw-resize',
};
function readStoredZoom(): number {
  if (typeof window === 'undefined') return 1;
  const stored = Number(window.localStorage.getItem(ZOOM_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : 1;
}

export function DeviceScreen({
  services,
  active,
  pane = 'params',
  onPaneChange,
}: {
  services: ProductServices;
  active: boolean;
  /** 右栏当前面；独立挂载（如测试与浏览器夹具）时可以不给，默认停在画面参数。 */
  pane?: WorkbenchPane;
  onPaneChange?(pane: WorkbenchPane): void;
}) {
  const device = useSnapshot(services.runtime.devices);
  const catalog = useSnapshot(services.runtime.operations);
  const live = services.runtime.mirroringStreaming;
  const legacySnapshot = useSnapshot(live);
  const webRtc = services.webRtcMirroring;
  const webSnapshot = useSnapshot(webRtc);
  const action = useAction();
  const reader = useAction();
  const recording = useAction();
  const [transport, setTransport] = useState<'webrtc' | 'legacy'>('webrtc');
  const [openingTransport, setOpeningTransport] = useState<'webrtc' | 'legacy' | null>(null);
  const webAvailable = typeof RTCPeerConnection !== 'undefined' && (webSnapshot.definitions?.sessions.some(
    (item) => item.id === 'plugin.mirroring.open_webrtc',
  ) ?? false);
  const webMode = Boolean(webSnapshot.session) ||
    (!legacySnapshot.session && (reader.pending && openingTransport
      ? openingTransport === 'webrtc'
      : transport === 'webrtc' && webAvailable));
  const currentWebMode = useRef(webMode);
  currentWebMode.current = webMode;
  const [webVideoSize, setWebVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [displayError, setDisplayError] = useState<unknown>(null);
  const snapshot = legacySnapshot;
  const [duration, setDuration] = useState('10000');
  const [size, setSize] = useState('1280');
  const [fps, setFps] = useState('30');
  /*
   * 画面缩放：1 = 自适应（等比铺满舞台可用区域），拖画面四角的弧线可以继续放大，
   * 超出舞台的部分在画面区内部滚动，不会把整页撑开。
   */
  const [zoom, setZoom] = useState(readStoredZoom);
  const [resizing, setResizing] = useState(false);
  const zoomDrag = useRef<{ x: number; y: number; base: number; span: number; corner: Corner } | null>(
    null,
  );
  const zoomTo = (value: number) => {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
    setZoom(next);
    try {
      window.localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
    } catch {
      /* 隐私模式下写不进去，只影响下次进入的默认值 */
    }
  };
  const [control, setControl] = useState(false);
  const [text, setText] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [image, setImage] = useState<Blob | null>(null);
  const [movie, setMovie] = useState<Blob | null>(null);
  const [imageName, setImageName] = useState('screenshot.png');
  const [source, setSource] = useState('');
  const [liveReference, setLiveReference] = useState<DeviceRef | null>(null);
  const [imageSource, setImageSource] = useState('');
  const [movieSource, setMovieSource] = useState('');
  const [controlError, setControlError] = useState<unknown>(null);
  const shareInfo = useMemo(
    () => (typeof window === 'undefined' ? null : parseMediaShare(window.location.hash)),
    [],
  );
  const shareStarted = useRef(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareControl, setShareControl] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [shareMessage, setShareMessage] = useState('');
  const controls = useRef<ReturnType<typeof createMediaControlQueue> | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const releaseSession = () => {
      const selected = currentWebMode.current ? webRtc : live;
      if (!selected.snapshot().session) return;
      void selected.release(new AbortController().signal).catch((error: unknown) => {
        services.messages.warning('投屏会话释放失败', {
          description: error instanceof Error ? error.message : '请重新查询会话状态',
          logId: errorLogId(error),
        });
      });
    };
    const queue = createMediaControlQueue({
      identity: () => {
        const view = currentWebMode.current ? webRtc.snapshot() : live.snapshot();
        const ownership = currentWebMode.current ? webRtc.snapshot().ownership : null;
        return `${view.session?.id ?? ''}:${view.epoch}:${view.inputState}:${ownership?.controlRevision ?? ''}:${ownership?.hasControl ?? ''}`;
      },
      send: (value, signal) => currentWebMode.current
        ? webRtc.sendControl(value, signal)
        : live.sendControl(value, signal),
      failed: (error) => {
        if (currentWebMode.current && webRtc.snapshot().ownership?.hasControl === false) {
          queue.clear();
          return;
        }
        queue.dispose();
        setControlError(error);
        releaseSession();
      },
    });
    controls.current = queue;
    return () => {
      queue.dispose();
      controls.current = null;
      action.cancel();
      reader.cancel();
      services.mediaDisplay.stop();
      releaseSession();
    };
  }, [active, live, webRtc, action.cancel, reader.cancel, services]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  /*
   * 进页面先读一次两条通道的会话目录。
   * 不读的话「开始投屏」永远是灰的，得翻进折叠里的「检查直播能力」才知道能不能投；
   * 传输方式也会误判成兼容模式。目录读失败不影响界面，照旧走折叠里的重试。
   */
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    for (const channel of [live, webRtc]) {
      try {
        void channel.refreshDefinitions?.(controller.signal)?.catch(() => undefined);
      } catch {
        /* 目录只是加分项 */
      }
    }
    return () => controller.abort();
  }, [active, live, webRtc]);
  useEffect(() => {
    if (!active || !webMode) return;
    if (!webSnapshot.stream) {
      setWebVideoSize(null);
      void services.mediaDisplay.playWebRtc(null, false);
      return;
    }
    void services.mediaDisplay.playWebRtc(webSnapshot.stream, false).catch(setDisplayError);
  }, [active, webMode, webSnapshot.stream, services]);
  const imageUrl = useBlobUrl(image);
  const movieUrl = useBlobUrl(movie);
  const provider = device.providers.find(
    (item) =>
      item.id === device.selection?.providerId && item.generation === device.selection.generation,
  );
  const screenshotCapability = provider?.definition.capabilities.find(
    (item) => item.id === 'screenshot' && item.version === 1 && item.scope === 'device',
  );
  const canScreenshot = Boolean(
    device.selected?.state === 'online' &&
      screenshotCapability &&
      device.selected.capabilities.some(
        (item) =>
          item.id === screenshotCapability.id &&
          item.version === screenshotCapability.version &&
          item.available,
      ),
  );
  const androidTarget = Boolean(
    (shareInfo !== null || device.selected?.state === 'online') &&
      provider?.definition.capabilities.some((item) =>
        item.operation.startsWith('plugin.android-device.'),
      ),
  );
  const canRecord = useOperationAvailable(services, 'plugin.mirroring.record');
  const legacyAvailable =
    snapshot.definitions?.sessions.some((item) => item.id === 'plugin.mirroring.open') ?? false;
  const liveAvailable = webMode ? webAvailable : legacyAvailable;
  const selectedSession = webMode ? webSnapshot.session : snapshot.session;
  const activeSession = Boolean(
    (snapshot.session && snapshot.session.status !== 'finished') ||
    (webSnapshot.session && webSnapshot.session.status !== 'finished'),
  );
  const status = webMode ? webSnapshot.status : snapshot.status?.state ?? null;
  const inputState = webMode ? webSnapshot.inputState : snapshot.inputState;
  const videoSize = webMode ? webVideoSize : snapshot.video;
  const controlChannelReady =
    resolveMediaShareControl(control, shareInfo?.control ?? null) &&
    (shareInfo !== null || (liveReference !== null &&
      JSON.stringify(liveReference) === JSON.stringify(device.selection))) &&
    (shareInfo !== null || device.selected?.state === 'online') &&
    status === 'streaming' &&
    (!webMode || webSnapshot.controlReady) &&
    (!webMode || !webSnapshot.opening) &&
    inputState === 'writable' &&
    selectedSession?.status === 'running';
  const ownership = webMode ? webSnapshot.ownership : null;
  const controlReady = Boolean(controlChannelReady && (!webMode ||
    ownership?.hasControl === true && !ownership.transitioning && !ownership.blocked));
  const controlIdentity = `${selectedSession?.id ?? ''}:${webMode ? webSnapshot.epoch : snapshot.epoch}:${ownership?.controlRevision ?? ''}:${ownership?.hasControl ?? ''}`;
  useEffect(() => { controls.current?.clear(); }, [ownership?.controlRevision, ownership?.hasControl]);
  const mediaClipboardShortcut = useRef<((action: 'copy' | 'cut' | 'paste') => boolean) | null>(null);
  const mediaKeyboard = useMediaKeyboard({
    active,
    ready: controlReady,
    identity: controlIdentity,
    enqueue: (values) => controls.current?.enqueue(values),
    clipboardShortcut: (action) => mediaClipboardShortcut.current?.(action) ?? false,
  });
  const mediaClipboard = useMediaClipboard({
    active,
    ready: Boolean(controlReady),
    identity: controlIdentity,
    clipboard: webMode ? webSnapshot.clipboard : snapshot.clipboard,
    ownershipRevision: ownership?.hasControl ? ownership.controlRevision : null,
    focused: () => mediaKeyboard.focused,
    enqueue: (values) => controls.current?.enqueue(values),
  });
  mediaClipboardShortcut.current = mediaClipboard.shortcut;
  const send = (value: MirroringControl) => {
    if (!controlReady) return;
    setControlError(null);
    controls.current?.enqueue([value]);
  };
  useEffect(() => {
    if (!active || !shareInfo || shareStarted.current || webRtc.snapshot().session) return;
    shareStarted.current = true;
    void reader.run(async (signal) => {
      setOpeningTransport('webrtc');
      setWebVideoSize(null);
      setDisplayError(null);
      await webRtc.refreshDefinitions(signal);
      const result = await webRtc.open({
        device_id: shareInfo.deviceId,
        max_size: Number(size),
        max_fps: Number(fps),
        audio: false,
        control: shareInfo.control,
        clipboard_autosync: shareInfo.control,
      }, signal);
      setSource(`分享设备 ${shareInfo.deviceId}`);
      setLiveReference(null);
      setControl(shareInfo.control);
      return result;
    }, { pending: '正在打开分享直播…' });
  }, [active, fps, reader, shareInfo, size, webRtc]);
  // 分享链接自带控制权：直接把控制条亮出来，不依赖打开会话那条副作用是否跑到。
  useEffect(() => {
    if (shareInfo) setControl(shareInfo.control);
  }, [shareInfo]);
  function openShareDialog(): void {
    setShareControl(shareInfo?.control ?? false);
    setShareUrl('');
    setShareMessage('');
    setShareDialogOpen(true);
  }
  function generateShareLink(): void {
    const deviceId = liveReference?.localId ?? shareInfo?.deviceId;
    if (!deviceId) {
      setShareMessage('当前会话没有可分享的设备身份');
      return;
    }
    const canShareControl = shareInfo?.control !== false;
    const allowedControl = resolveMediaShareControl(shareControl, shareInfo?.control ?? null);
    setShareUrl(createMediaShareUrl({ deviceId, control: allowedControl }));
    setShareMessage(allowedControl
      ? '链接持有人可以申请接管设备，由当前控制者同意后操作。'
      : canShareControl
        ? '链接持有人只能观看，不会收到设备剪贴板，也不能发送控制。'
        : '当前链接没有控制权，只能继续分享观看链接。');
  }
  async function copyShareLink(): Promise<void> {
    if (!shareUrl) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(shareUrl);
      else {
        const input = document.createElement('textarea');
        input.value = shareUrl;
        input.style.position = 'fixed';
        input.style.left = '-10000px';
        document.body.append(input);
        input.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
        input.remove();
      }
      setShareMessage('分享链接已复制');
    } catch {
      setShareMessage('浏览器未允许自动复制，请手动复制链接');
    }
  }
  function pointer(event: PointerEvent<HTMLCanvasElement | HTMLVideoElement>, type: 'down' | 'move' | 'up') {
    if (type === 'down' && controlReady) event.currentTarget.focus({ preventScroll: true });
    if (!controlReady || !videoSize || (type === 'move' && !event.buttons)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (type === 'down') event.currentTarget.setPointerCapture(event.pointerId);
    const width = videoSize.width;
    const height = videoSize.height;
    void send({
      type: 'touch',
      action: type,
      pointer_id: event.pointerId,
      width,
      height,
      x: Math.min(
        width - 1,
        Math.max(0, Math.floor(((event.clientX - rect.left) * width) / rect.width)),
      ),
      y: Math.min(
        height - 1,
        Math.max(0, Math.floor(((event.clientY - rect.top) * height) / rect.height)),
      ),
      pressure: type === 'up' ? 0 : 1,
    });
  }
  /**
   * 四角弧线：每个角只认自己那一侧的位移——左下角往左、往下拖是放大，其余同理。
   * 位移投影到该角的外向对角线上，再按当前画面高度折算成倍数，大画面也不会一拖就失控。
   * 双击回到 100%，方向键微调。
   */
  function zoomPointer(
    event: PointerEvent<HTMLSpanElement>,
    type: 'down' | 'move' | 'up',
    corner: Corner,
  ) {
    if (type === 'down') {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const frame = event.currentTarget.closest('.media-frame');
      zoomDrag.current = {
        x: event.clientX,
        y: event.clientY,
        base: zoom,
        span: frame instanceof HTMLElement ? frame.getBoundingClientRect().height : 0,
        corner,
      };
      setResizing(true);
      return;
    }
    const drag = zoomDrag.current;
    if (!drag) return;
    if (type === 'up') {
      zoomDrag.current = null;
      setResizing(false);
      return;
    }
    const [signX, signY] = CORNERS[drag.corner];
    const outward = signX * (event.clientX - drag.x) + signY * (event.clientY - drag.y);
    const gain = Math.min(560, Math.max(240, drag.span * 0.62));
    zoomTo(drag.base + outward / gain);
  }
  const key = (keycode: number) => {
    if (!controlReady) return;
    setControlError(null);
    controls.current?.enqueue([
      { type: 'key', action: 'down', keycode },
      { type: 'key', action: 'up', keycode },
    ]);
  };
  function shoot(): void {
    void action.run((signal) =>
      withSelectedDevice(services, signal, async (reference, active) => {
        if (!screenshotCapability) throw new Error('当前设备不支持截图');
        const runner = createJobRunner({
          submit: (_, __, requestSignal) =>
            services.runtime.devices.invoke(
              {
                providerId: reference.providerId,
                generation: reference.generation,
                deviceId: reference.localId,
                capability: screenshotCapability.id,
                version: screenshotCapability.version,
                input: {},
              },
              requestSignal,
            ),
          getJob: services.runtime.tasks.get,
          cancelJob: services.runtime.tasks.cancel,
        });
        try {
          const result = await runner.execute(
            screenshotCapability.operation,
            {},
            active,
            (value, logId) => decodeArtifactEnvelope(value, '设备截图', logId),
          );
          const artifact = result.data.artifacts.find(
            (item) => item.media_type === 'image/png' || item.media_type === 'image/jpeg',
          );
          if (!artifact) throw new Error('截图任务没有发布 PNG 或 JPEG 画面');
          const downloaded = await downloadPublishedArtifact(
            services.runtime.artifacts,
            result.data,
            artifact.filename,
            active,
          );
          if (!active.aborted) {
            setImage(downloaded.data);
            setImageName(artifact.filename);
            setImageSource(reference.localId);
          }
          return result;
        } finally {
          runner.dispose();
        }
      }),
    );
  }
  /** 舞台底部的「录制」与右栏的时长共用一条路径，避免两处各写一遍。 */
  function record(): void {
    void recording.run((signal) =>
      withSelectedDevice(services, signal, async (reference, active) => {
        await services.mirroring.refreshOperations(active);
        const result = await services.mirroring.record(
          {
            device_id: reference.localId,
            duration_ms: Number(duration),
            max_size: Number(size),
            max_fps: Number(fps),
          },
          active,
        );
        const downloaded = await services.mirroring.downloadRecording(result.data, active);
        if (!active.aborted) {
          setMovie(downloaded.data);
          setMovieSource(reference.localId);
        }
        return result;
      }),
    );
  }
  function toggleFullscreen(): void {
    const target = stage.current;
    if (!target) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void target.requestFullscreen?.().catch(() => undefined);
  }
  function startLive(): void {
    setOpeningTransport(webMode ? 'webrtc' : 'legacy');
    void reader.run((signal) =>
      withSelectedDevice(services, signal, async (reference, active) => {
        const input = {
          device_id: reference.localId,
          max_size: Number(size),
          max_fps: Number(fps),
          audio: false,
          control: resolveMediaShareControl(control, shareInfo?.control ?? null),
          clipboard_autosync: webMode && resolveMediaShareControl(control, shareInfo?.control ?? null),
        };
        if (webMode) {
          setWebVideoSize(null);
          setDisplayError(null);
          await webRtc.open(input, active);
        } else {
          await services.mediaDisplay.prepare(false);
          services.mediaDisplay.bind(canvas.current);
          await live.open(input, active);
        }
        setSource(reference.localId);
        setLiveReference(reference);
        return webMode ? webRtc.snapshot() : live.pollOutput({ limit: 100 }, active);
      }),
    );
  }
  function checkLive(): void {
    void action.run(async (signal) => {
      const results = await Promise.allSettled([
        webRtc.refreshDefinitions(signal),
        live.refreshDefinitions(signal),
      ]);
      const available = results.find((result) => result.status === 'fulfilled');
      if (available?.status === 'fulfilled') return available.value;
      const failed = results[0];
      if (failed?.status === 'rejected') throw failed.reason;
      throw new Error('投屏会话目录未返回');
    });
  }
  function releaseLive(): void {
    reader.cancel();
    services.mediaDisplay.stop();
    void action.run((signal) => (webMode ? webRtc.release(signal) : live.release(signal)), {
      pending: '正在释放投屏会话…',
    });
  }
  const transportLabel = webMode ? 'WebRTC 直连' : '兼容模式';
  // 横竖屏由真实画面比例决定：框、刘海、手势条都跟着走，不写死手机方向。
  const orientation = videoSize && videoSize.width > videoSize.height ? 'landscape' : 'portrait';
  const packages = capabilityGate(
    device,
    catalog.pending ? [] : (catalog.result?.data ?? []),
    'packages',
  );
  const stageReadout = [
    videoSize ? `${videoSize.width} × ${videoSize.height}` : '尺寸待返回',
    `${fps} fps`,
    zoom === 1 ? null : `缩放 ${Math.round(zoom * 100)}%`,
    transportLabel,
    source || '尚未取到画面',
  ]
    .filter(Boolean)
    .join(' · ');
  /* 画面框的等比尺寸交给 CSS 算：比例与它的倒数从真实画面尺寸来，缩放倍数来自手柄。 */
  const frameStyle = {
    '--frame-zoom': String(zoom),
    ...(videoSize
      ? {
          '--frame-ratio': String(videoSize.width / videoSize.height),
          '--frame-fit-inv': String(videoSize.height / videoSize.width),
        }
      : {}),
  } as CSSProperties;
  const liveLine = activeSession
    ? `会话 ${selectedSession?.status ?? '已建立'}`
    : '未开始 · 先建立会话';
  const recordLine = recording.pending ? '录制中' : movie ? '已就绪' : '未开始';
  return (
    <section className="device-workbench" data-pane={pane} data-orientation={orientation}>
      {/* ── 右栏：画面参数 / 应用 ───────────────────────── */}
      <aside className="workbench-rail" aria-label="画面参数与应用">
        <div className="rail-tabs" role="tablist" aria-label="右栏内容">
          <button
            type="button"
            role="tab"
            className="rail-tab"
            aria-selected={pane === 'params'}
            aria-controls="workbench-pane"
            onClick={() => onPaneChange?.('params')}
          >
            <SlidersHorizontal aria-hidden="true" />
            <span>画面参数</span>
          </button>
          <button
            type="button"
            role="tab"
            className="rail-tab"
            aria-selected={pane === 'apps'}
            aria-controls="workbench-pane"
            disabled={!packages.capability}
            title={packages.reason ?? undefined}
            onClick={() => onPaneChange?.('apps')}
          >
            <LayoutGrid aria-hidden="true" />
            <span>应用</span>
          </button>
        </div>
        <div className="rail-pane" id="workbench-pane" role="tabpanel"
          aria-label={pane === 'apps' ? '应用' : '画面参数'}>
          {pane === 'apps' ? (
            <DeviceApps services={services} embedded compact />
          ) : (
            <>
              {/* ── 画面：先给四条事实，参数折起来 ── */}
              <section className="rail-group">
                <dl className="rail-metrics">
                  <div>
                    <dt>分辨率</dt>
                    <dd className="mono">
                      {videoSize ? `${videoSize.width} × ${videoSize.height}` : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>帧率上限</dt>
                    <dd className="mono">{fps} fps</dd>
                  </div>
                  <div>
                    <dt>传输</dt>
                    <dd>{transportLabel}</dd>
                  </div>
                  <div>
                    <dt>控制</dt>
                    <dd data-tone={controlReady ? 'on' : control ? 'wait' : undefined}>
                      {controlReady ? '可操作' : control ? '等待就绪' : '只读'}
                    </dd>
                  </div>
                </dl>
                <details className="rail-fold">
                  <summary>投屏参数</summary>
                  <div className="media-segment" role="group" aria-label="投屏传输方式">
                    <Button
                      size="xs"
                      variant={webMode ? 'default' : 'ghost'}
                      disabled={!webAvailable || activeSession || reader.pending}
                      onClick={() => setTransport('webrtc')}
                    >
                      WebRTC
                    </Button>
                    <Button
                      size="xs"
                      variant={!webMode ? 'default' : 'ghost'}
                      disabled={!legacyAvailable || activeSession || reader.pending}
                      onClick={() => setTransport('legacy')}
                    >
                      兼容
                    </Button>
                  </div>
                  {!webAvailable && (
                    <p className="rail-hint">未提供 WebRTC 会话。</p>
                  )}
                  <div className="media-fields">
                    <Field
                      label="最大尺寸"
                      value={size}
                      onChange={setSize}
                      type="number"
                      min={256}
                      max={8192}
                    />
                    <Field
                      label="帧率上限"
                      value={fps}
                      onChange={setFps}
                      type="number"
                      min={1}
                      max={240}
                    />
                  </div>
                  <div className="media-actions">
                    <Button variant="outline" size="sm" disabled={action.pending} onClick={checkLive}>
                      检查直播能力
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={webMode || !activeSession || reader.pending}
                      onClick={() => void reader.run((signal) => live.pollOutput({ limit: 100 }, signal))}
                    >
                      继续读取
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!reader.pending} onClick={reader.cancel}>
                      暂停读取
                    </Button>
                  </div>
                </details>
              </section>
              {webMode && selectedSession && (
                <MediaOwnershipControls
                  state={ownership}
                  ready={Boolean(active && controlChannelReady)}
                  actions={webRtc}
                />
              )}
              {/* ── 控制：开关常驻，剪贴板只在开启后出现 ── */}
              <section className="rail-group">
                <h2>设备控制</h2>
                <div className="media-switch">
                  <Switch
                    id="media-control"
                    checked={control}
                    onCheckedChange={setControl}
                    disabled={Boolean(activeSession) || shareInfo?.control === false}
                  />
                  <Label htmlFor="media-control">开启设备控制</Label>
                </div>
                {control && (
                  <div className="rail-clipboard-block" aria-live="polite">
                    <textarea
                      readOnly
                      value={mediaClipboard.text ?? ''}
                      placeholder="在设备内复制文本后，会出现在这里"
                      aria-label="设备剪贴板文本"
                      rows={2}
                      className="rail-clipboard"
                    />
                    <div className="media-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!controlReady || !webMode}
                        onClick={mediaClipboard.copySelection}
                      >
                        复制设备选中文本
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!mediaClipboard.text || !controlReady}
                        onClick={mediaClipboard.copyToComputer}
                      >
                        复制到电脑
                      </Button>
                    </div>
                    <p className="rail-hint">
                      {mediaClipboard.message || '设备内复制的内容只同步给当前控制者。'}
                    </p>
                  </div>
                )}
              </section>
              <section className="rail-group">
                <h2>录制</h2>
                <p className="rail-line">
                  <span
                    className={`rail-dot${recording.pending ? ' is-busy' : movie ? ' is-ready' : ''}`}
                    aria-hidden="true"
                  />
                  {recordLine}
                  {movie && <span className="rail-line-note mono">{movieSource}</span>}
                </p>
                <details className="rail-fold">
                  <summary>录制参数</summary>
                  <Field
                    label="录制时长（毫秒）"
                    value={duration}
                    onChange={setDuration}
                    type="number"
                    min={1000}
                    max={120000}
                  />
                  <div className="media-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={recording.pending}
                      onClick={() =>
                        void recording.run(async (signal) => {
                          await services.mirroring.refreshOperations(signal);
                          return services.mirroring.runtimeStatus(signal);
                        })
                      }
                    >
                      检查录像工具
                    </Button>
                  </div>
                  <p className="rail-hint">
                    录像不含音频；取消等待请到任务页处理。
                  </p>
                </details>
                {movieUrl && (
                  <>
                    <video
                      src={movieUrl}
                      controls
                      preload="metadata"
                      aria-label="设备录像预览"
                      className="recording-preview"
                    />
                    <Button variant="outline" size="sm" asChild>
                      <a href={movieUrl} download="screen.mp4">
                        <Download aria-hidden="true" />
                        下载录像
                      </a>
                    </Button>
                  </>
                )}
                <JsonResult value={recording.result} />
              </section>
              <section className="rail-group">
                <h2>会话</h2>
                <p className="rail-line">
                  <span
                    className={`rail-dot${activeSession ? ' is-live' : ''}`}
                    aria-hidden="true"
                  />
                  {liveLine}
                </p>
                <div className="media-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedSession || !webMode || action.pending}
                    onClick={openShareDialog}
                  >
                    分享直播
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!selectedSession || action.pending}
                    onClick={releaseLive}
                  >
                    释放直播
                  </Button>
                </div>
                <details className="rail-fold">
                  <summary>恢复已知会话</summary>
                  <Field label="直播会话 ID" value={sessionId} onChange={setSessionId} />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={webMode || !sessionId || action.pending}
                    onClick={() =>
                      void action.run(async (signal) => {
                        await services.mediaDisplay.prepare(false);
                        const sameSession = live.snapshot().session?.id === sessionId;
                        const result = await live.resume(sessionId, signal);
                        if (!signal.aborted && !sameSession) {
                          setLiveReference(null);
                          setSource(`恢复会话 ${sessionId}`);
                        }
                        return result;
                      })
                    }
                  >
                    恢复画面读取位置
                  </Button>
                  <p className="rail-hint">恢复其它会话会关闭控制。</p>
                </details>
              </section>
              {imageUrl && (
                <section className="rail-group">
                  <h2>最近截取</h2>
                  <a className="rail-item" href={imageUrl} download={imageName}>
                    <span className="mono">{imageName}</span>
                    <Download aria-hidden="true" />
                  </a>
                  <p className="rail-hint">来源：{imageSource}</p>
                  <img src={imageUrl} alt="设备截图预览" className="screenshot-preview" />
                </section>
              )}
              <div className="rail-slot" aria-label="插件插槽：由插件在此渲染工具">
                <span className="rail-slot-name mono">workshop.extensions</span>
                <span className="rail-slot-note">插件可在此处渲染工具</span>
              </div>
              <JsonResult value={action.result} />
            </>
          )}
        </div>
        {pane === 'params' && (
          <div className="rail-foot">
            <Button
              disabled={!androidTarget || !liveAvailable || Boolean(activeSession) || reader.pending}
              onClick={startLive}
            >
              <Play aria-hidden="true" />
              {activeSession ? '投屏进行中' : '开始投屏'}
            </Button>
          </div>
        )}
      </aside>
      {/* ── 舞台：设备画面常驻 ────────────────────────────── */}
      <div className="workbench-stage" ref={stage}>
        {/* 只让画面层滚动：四角弧线长在画面外面，放大后要跟着画面走。留 20px 内边距给弧线站脚。 */}
        <div className="media-canvas-area p-5">
          <div
            className="media-frame group/frame"
            data-orientation={orientation}
            data-live={videoSize ? 'true' : 'false'}
            style={frameStyle}
          >
            <div className="media-frame-screen">
              <canvas
                ref={(target) => {
                  canvas.current = target;
                  services.mediaDisplay.bind(target);
                }}
                aria-label="设备实时投屏画面"
                role="img"
                className={`media-canvas${controlReady ? ' is-interactive' : ''}${mediaKeyboard.focused ? ' is-keyboard-focused' : ''}`}
                tabIndex={mediaKeyboard.tabIndex}
                hidden={webMode}
                onFocus={mediaKeyboard.onFocus}
                onBlur={mediaKeyboard.onBlur}
                onKeyDown={mediaKeyboard.onKeyDown}
                onKeyUp={mediaKeyboard.onKeyUp}
                onPaste={mediaClipboard.onPaste}
                onPointerDown={(event) => pointer(event, 'down')}
                onPointerMove={(event) => pointer(event, 'move')}
                onPointerUp={(event) => pointer(event, 'up')}
                onPointerCancel={(event) => pointer(event, 'up')}
              />
              <video
                ref={services.mediaDisplay.bindVideo}
                autoPlay
                playsInline
                muted
                aria-label="设备 WebRTC 实时投屏画面"
                className={`media-canvas${controlReady ? ' is-interactive' : ''}${mediaKeyboard.focused ? ' is-keyboard-focused' : ''}`}
                tabIndex={mediaKeyboard.tabIndex}
                hidden={!webMode}
                onFocus={mediaKeyboard.onFocus}
                onBlur={mediaKeyboard.onBlur}
                onKeyDown={mediaKeyboard.onKeyDown}
                onKeyUp={mediaKeyboard.onKeyUp}
                onPaste={mediaClipboard.onPaste}
                onResize={() => setWebVideoSize(services.mediaDisplay.videoSize())}
                onLoadedMetadata={() => setWebVideoSize(services.mediaDisplay.videoSize())}
                onPointerDown={(event) => pointer(event, 'down')}
                onPointerMove={(event) => pointer(event, 'move')}
                onPointerUp={(event) => pointer(event, 'up')}
                onPointerCancel={(event) => pointer(event, 'up')}
              />
              {!device.selection && (
                <EmptyState title="选择一台设备开始" description="在顶栏设备身份里选择工作设备。" />
              )}
              {device.selection && !videoSize && (
                <EmptyState title="等待设备画面" description="点右栏底部的开始投屏拉取画面。" />
              )}
            </div>
            <span className="media-frame-gesture" aria-hidden="true" />
            {/*
              四角弧线：画在机身外侧的留白里，四段四分之一圆各自朝外，跟机身弧度同向。
              拖动改大小，双击回到自适应；键盘焦点落在这一组上，方向键微调。
            */}
            <div
              className="group/corners pointer-events-none absolute inset-0 z-[5] touch-none outline-none focus-visible:outline-2 focus-visible:outline-offset-6 focus-visible:outline-ring"
              role="slider"
              tabIndex={0}
              aria-label="画面缩放"
              aria-valuemin={Math.round(ZOOM_MIN * 100)}
              aria-valuemax={Math.round(ZOOM_MAX * 100)}
              aria-valuenow={Math.round(zoom * 100)}
              aria-valuetext={`${Math.round(zoom * 100)}%`}
              title={`拖动四角弧线调整画面大小 · 双击复位（当前 ${Math.round(zoom * 100)}%）`}
              data-dragging={resizing ? 'true' : undefined}
              onDoubleClick={() => zoomTo(1)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  zoomTo(zoom + ZOOM_STEP);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  zoomTo(zoom - ZOOM_STEP);
                } else if (event.key === '0' || event.key === 'Home') {
                  event.preventDefault();
                  zoomTo(1);
                }
              }}
            >
              {(Object.keys(CORNERS) as Corner[]).map((corner) => (
                <span
                  key={corner}
                  data-corner={corner}
                  aria-hidden="true"
                  className={cn(
                    'pointer-events-auto absolute size-9 touch-none text-muted-foreground transition-colors duration-150',
                    'hover:text-primary group-focus-visible/corners:text-primary group-data-[dragging=true]/corners:text-primary group-hover/frame:text-body',
                    CORNER_STYLE[corner],
                  )}
                  onPointerDown={(event) => zoomPointer(event, 'down', corner)}
                  onPointerMove={(event) => zoomPointer(event, 'move', corner)}
                  onPointerUp={(event) => zoomPointer(event, 'up', corner)}
                  onPointerCancel={(event) => zoomPointer(event, 'up', corner)}
                >
                  <svg
                    viewBox="0 0 36 36"
                    fill="none"
                    aria-hidden="true"
                    className="size-9 overflow-visible"
                  >
                    <path
                      d="M0 36A36 36 0 0 1 36 0"
                      stroke="currentColor"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              ))}
            </div>
          </div>
        </div>
        {control && (
          <p className="media-keyboard-hint" aria-live="polite">
            {mediaKeyboard.focused
              ? '画面已聚焦，可用键盘操作'
              : controlReady
                ? '点击画面后使用键盘'
                : '控制就绪后可点击画面使用键盘'}
          </p>
        )}
        <p className="media-stage-readout mono">{stageReadout}</p>
        <div className="media-stage-dock">
          <Button size="sm" variant="ghost" disabled={!canScreenshot || action.pending} onClick={shoot}>
            <Camera aria-hidden="true" />
            截取画面
          </Button>
          <span className="media-stage-sep" aria-hidden="true" />
          <Button
            size="sm"
            variant="ghost"
            disabled={!androidTarget || !canRecord || recording.pending}
            onClick={record}
          >
            录制
          </Button>
          <span className="media-stage-sep" aria-hidden="true" />
          <Button size="sm" variant="ghost" onClick={toggleFullscreen}>
            <Maximize2 aria-hidden="true" />
            全屏
          </Button>
        </div>
        {control && (
          <div className="media-controlbar">
            <Button variant="ghost" size="xs" disabled={!controlReady} onClick={() => void key(4)}>
              返回
            </Button>
            <Button variant="ghost" size="xs" disabled={!controlReady} onClick={() => void key(3)}>
              主屏
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={!controlReady || action.pending}
              onClick={() => void send({ type: 'rotate' })}
            >
              旋转
            </Button>
            <span className="media-controlbar-sep" aria-hidden="true" />
            <input
              className="media-controlbar-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="输入文本"
              aria-label="设备输入文本"
            />
            <Button
              variant="ghost"
              size="xs"
              disabled={!controlReady || !text || action.pending}
              onClick={() => void send({ type: 'text', text })}
            >
              发送
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={webMode || !activeSession || snapshot.inputState === 'eof'}
              onClick={() => void action.run((signal) => live.eof(signal))}
            >
              关闭输入
            </Button>
          </div>
        )}
      </div>
      <ErrorNotice error={services.mediaDisplay.error()} />
      <ErrorNotice error={displayError} />
      <ErrorNotice error={webSnapshot.errors.output ?? webSnapshot.errors.connection ?? null} />
      <ErrorNotice error={controlError} />
      <ActionFeedback {...action} />
      <ActionFeedback {...reader} />
      <ActionFeedback {...recording} />
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>分享 WebRTC 直播</DialogTitle>
            <DialogDescription>
              每位观看者会建立独立设备会话。同一设备同时只有一名控制者，设备剪贴板只同步给当前控制者。请选择是否允许链接持有人申请接管。
            </DialogDescription>
          </DialogHeader>
          <label className="share-control-choice">
            <input
              type="checkbox"
              checked={shareControl}
              disabled={shareInfo?.control === false}
              onChange={(event) => setShareControl(event.target.checked)}
            />
            允许链接持有人申请接管设备
          </label>
          <Button onClick={generateShareLink}>生成分享链接</Button>
          {shareUrl && <textarea readOnly value={shareUrl} rows={3} aria-label="分享链接" />}
          {shareMessage && (
            <p className="muted" aria-live="polite">
              {shareMessage}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={!shareUrl} onClick={() => void copyShareLink()}>
              复制链接
            </Button>
            <Button variant="ghost" onClick={() => setShareDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
