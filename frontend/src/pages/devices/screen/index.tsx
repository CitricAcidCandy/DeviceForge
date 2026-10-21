import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Camera, Play, Square, Download } from 'lucide-react';
import { Button } from '../../components/Button/index.tsx';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../components/Dialog/index.tsx';
import { Switch } from '../../components/Switch/index.tsx';
import { Label } from '../../components/Label/index.tsx';
import {
  createJobRunner,
  decodeArtifactEnvelope,
  downloadPublishedArtifact,
} from '../../shared/jobs/index.ts';
import { Field, PageTitle, EmptyState, JsonResult } from '../../components/index.ts';
import { useOperationAvailable } from '../../app/product/capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../../app/product/feedback.tsx';
import { errorLogId, useAction, useSnapshot } from '../../app/product/hooks.ts';
import { withSelectedDevice } from '../../app/product/device-target.ts';
import { createMediaControlQueue } from './media-controls.ts';
import { useMediaKeyboard } from './use-media-keyboard.ts';
import { useMediaClipboard } from './use-media-clipboard.ts';
import { MediaOwnershipControls } from './MediaOwnershipControls/index.tsx';
import { createMediaShareUrl, parseMediaShare, resolveMediaShareControl } from './media-share.ts';
import { useBlobUrl } from '../../components/BlobDownload/index.tsx';
import type { ProductServices } from '../../app/product/services.ts';
import type { MirroringControl } from '../../features/mirroring-streaming/index.ts';
import type { DeviceRef } from '../../plugin-sdk/index.ts';
import './workspace.css';

export function MediaPage({ services, active }: { services: ProductServices; active: boolean }) {
  const device = useSnapshot(services.runtime.devices);
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
  const key = (keycode: number) => {
    if (!controlReady) return;
    setControlError(null);
    controls.current?.enqueue([
      { type: 'key', action: 'down', keycode },
      { type: 'key', action: 'up', keycode },
    ]);
  };
  return (
    <section className="product-page media-page">
      <PageTitle
        eyebrow="WORKSHOP / SCREEN"
        title="画面与录制"
        description="看清当前设备，保留真正需要的画面。截图、实时投屏与录像分别管理。"
      >
        <Button
          disabled={!canScreenshot || action.pending}
          onClick={() =>
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
            )
          }
        >
          <Camera />
          截取画面
        </Button>
      </PageTitle>
      {!device.selection && (
        <EmptyState
          title="选择一台设备开始"
          description="在上方选择工作设备。"
        />
      )}
      <div className="media-workspace">
      <aside className="media-session-controls" aria-label="画面参数与会话控制">
      <h2>画面参数</h2>
      <div className="form-row" role="group" aria-label="投屏传输方式">
        <Button
          variant={webMode ? 'default' : 'outline'}
          disabled={!webAvailable || activeSession || reader.pending}
          onClick={() => setTransport('webrtc')}
        >
          WebRTC 低延迟
        </Button>
        <Button
          variant={!webMode ? 'default' : 'outline'}
          disabled={!legacyAvailable || activeSession || reader.pending}
          onClick={() => setTransport('legacy')}
        >
          兼容模式
        </Button>
      </div>
      {!webAvailable && <p className="muted">检查直播能力后，若服务器提供 WebRTC，将默认使用低延迟模式。</p>}
      <div className="form-row">
        <Field
          label="最大画面尺寸"
          value={size}
          onChange={setSize}
          type="number"
          min={256}
          max={8192}
        />
        <Field label="帧率上限" value={fps} onChange={setFps} type="number" min={1} max={240} />
        <div className="setting-toggle">
          <Switch
            id="media-control"
            checked={control}
            onCheckedChange={setControl}
            disabled={Boolean(activeSession) || shareInfo?.control === false}
          />
          <Label htmlFor="media-control">开启设备控制</Label>
        </div>
      </div>
      <div className="action-row">
        <Button
          variant="outline"
          disabled={action.pending}
          onClick={() => void action.run(async (signal) => {
            const results = await Promise.allSettled([
              webRtc.refreshDefinitions(signal), live.refreshDefinitions(signal),
            ]);
            const available = results.find((result) => result.status === 'fulfilled');
            if (available?.status === 'fulfilled') return available.value;
            const failed = results[0];
            if (failed?.status === 'rejected') throw failed.reason;
            throw new Error('投屏会话目录未返回');
          })}
        >
          检查直播能力
        </Button>
        <Button
          disabled={!androidTarget || !liveAvailable || Boolean(activeSession) || reader.pending}
          onClick={() => {
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
          }}
        >
          <Play />
          开始投屏
        </Button>
        <Button
          variant="outline"
          disabled={webMode || !activeSession || reader.pending}
          onClick={() => void reader.run((signal) => live.pollOutput({ limit: 100 }, signal))}
        >
          继续读取
        </Button>
        <Button variant="ghost" disabled={!reader.pending} onClick={reader.cancel}>
          暂停读取
        </Button>
        <Button
          variant="destructive"
          disabled={!selectedSession || action.pending}
          onClick={() => {
            reader.cancel();
            services.mediaDisplay.stop();
            void action.run((signal) => webMode ? webRtc.release(signal) : live.release(signal),
              { pending: '正在释放投屏会话…' });
          }}
        >
          <Square />
          释放直播
        </Button>
        <Button
          variant="outline"
          disabled={!selectedSession || !webMode || action.pending}
          onClick={openShareDialog}
        >
          分享直播
        </Button>
      </div>
      </aside>
      <div className="media-stage">
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
        {control && (
          <p className="media-keyboard-hint" aria-live="polite">
            {mediaKeyboard.focused ? '画面已聚焦，可使用键盘操作' : controlReady ? '点击画面后使用键盘操作' : '投屏控制就绪后可点击画面使用键盘操作'}
          </p>
        )}
        {!videoSize && (
          <EmptyState
            title="等待设备画面"
            description="选择设备后开始投屏。"
          />
        )}
      </div>
      </div>
      <details className="media-observation">
        <summary>来源：{source || '尚无画面'} · {status ?? '尚未连接'}</summary>
        <p>{videoSize ? `${videoSize.width} × ${videoSize.height}` : '尺寸待返回'} · 代次 {webMode ? webSnapshot.epoch : snapshot.epoch}{webMode ? ' · WebRTC 媒体直连' : ` · 已交付 ${snapshot.packets} 个媒体包`}</p>
      </details>
      <ErrorNotice error={services.mediaDisplay.error()} />
      <ErrorNotice error={displayError} />
      <ErrorNotice error={webSnapshot.errors.output ?? webSnapshot.errors.connection ?? null} />
      <ErrorNotice error={controlError} />
      <ActionFeedback {...reader} />
      {webMode && selectedSession && (
        <MediaOwnershipControls state={ownership} ready={Boolean(active && controlChannelReady)} actions={webRtc} />
      )}
      {control && (
        <div className="media-clipboard" aria-live="polite">
          <div>
            <strong>设备剪贴板</strong>
            <p className="muted">{mediaClipboard.message || '获得控制权后，设备内复制、复制按钮或 Ctrl+C / Ctrl+X 的内容只同步到你的电脑。'}</p>
            <textarea
              readOnly
              value={mediaClipboard.text ?? ''}
              placeholder="当前控制者在设备内复制后，文本会显示在这里"
              aria-label="设备剪贴板文本"
              rows={2}
            />
          </div>
          <Button
            variant="outline"
            disabled={!controlReady || !webMode}
            onClick={mediaClipboard.copySelection}
          >
            复制设备选中文本
          </Button>
          <Button
            variant="outline"
            disabled={!mediaClipboard.text || !controlReady}
            onClick={mediaClipboard.copyToComputer}
          >
            复制到电脑
          </Button>
        </div>
      )}
      {control && (
        <div className="action-row">
          <Button
            variant="outline"
            disabled={!controlReady || action.pending}
            onClick={() => void key(4)}
          >
            返回
          </Button>
          <Button
            variant="outline"
            disabled={!controlReady || action.pending}
            onClick={() => void key(3)}
          >
            主屏幕
          </Button>
          <Button
            variant="outline"
            disabled={!controlReady || action.pending}
            onClick={() => void send({ type: 'rotate' })}
          >
            旋转
          </Button>
          <Field label="设备输入文本" value={text} onChange={setText} />
          <Button
            disabled={!controlReady || !text || action.pending}
            onClick={() => void send({ type: 'text', text })}
          >
            发送文本
          </Button>
          <Button
            variant="ghost"
            disabled={webMode || !activeSession || snapshot.inputState === 'eof'}
            onClick={() => void action.run((signal) => live.eof(signal))}
          >
            关闭控制输入
          </Button>
        </div>
      )}
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
          {shareUrl && (
            <textarea readOnly value={shareUrl} rows={3} aria-label="分享链接" />
          )}
          {shareMessage && <p className="muted" aria-live="polite">{shareMessage}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={!shareUrl} onClick={() => void copyShareLink()}>
              复制链接
            </Button>
            <Button variant="ghost" onClick={() => setShareDialogOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <details>
        <summary>恢复已知兼容直播会话</summary>
        <div className="form-row">
          <Field label="直播会话 ID" value={sessionId} onChange={setSessionId} />
          <Button
            variant="outline"
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
        </div>
        <p className="muted">
          恢复其它会话时控制入口关闭。暂停读取不停止服务；帧交付撤销后可能需要重新打开直播。
        </p>
      </details>
      <details className="settings-group media-recording">
        <summary>录像与下载</summary>
        <div className="section-heading">
          <h2>限时录像</h2>
          <Button
            variant="ghost"
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
        <div className="form-row">
          <Field
            label="录制时长（毫秒）"
            value={duration}
            onChange={setDuration}
            type="number"
            min={1000}
            max={120000}
          />
          <Button
            disabled={!androidTarget || !canRecord || recording.pending}
            onClick={() =>
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
                  const downloaded = await services.mirroring.downloadRecording(
                    result.data,
                    active,
                  );
                  if (!active.aborted) {
                    setMovie(downloaded.data);
                    setMovieSource(reference.localId);
                  }
                  return result;
                }),
              )
            }
          >
            录制并下载 MP4
          </Button>
        </div>
        <p className="muted">
          服务器录像不包含音频和交互控制。取消等待后可在任务页查询原任务，避免重复录制。
        </p>
        {movieUrl && (
          <>
            <p className="muted">录像来源：{movieSource}</p>
            <video
              src={movieUrl}
              controls
              preload="metadata"
              aria-label="设备录像预览"
              className="recording-preview"
            />
            <Button variant="outline" asChild>
              <a href={movieUrl} download="screen.mp4">
                <Download />
                下载录像
              </a>
            </Button>
          </>
        )}
        <ActionFeedback {...recording} />
        <JsonResult value={recording.result} />
      </details>
      {imageUrl && (
        <section className="settings-group">
          <h2>最近截图 · {imageSource}</h2>
          <img src={imageUrl} alt="设备截图预览" className="screenshot-preview" />
          <Button variant="outline" asChild>
            <a href={imageUrl} download={imageName}>
              <Download />
              下载原始截图
            </a>
          </Button>
        </section>
      )}
      <ActionFeedback {...action} />
      <JsonResult value={action.result} />
    </section>
  );
}
