import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Camera, Play, Square, Download } from 'lucide-react';
import { Button } from '../../../components/Button/index.tsx';
import { Switch } from '../../../components/Switch/index.tsx';
import { Label } from '../../../components/Label/index.tsx';
import { createJobRunner, decodeArtifactEnvelope, downloadPublishedArtifact } from '../../../shared/jobs/index.ts';
import { Field, PageTitle, EmptyState, JsonResult } from '../../../components/index.ts';
import { useOperationAvailable } from '../capabilities.tsx';
import { ActionFeedback, ErrorNotice } from '../feedback.tsx';
import { useAction, useSnapshot } from '../hooks.ts';
import { withSelectedDevice } from '../device-target.ts';
import { createMediaControlQueue } from '../media-controls.ts';
import { useBlobUrl } from './profile-view.tsx';
import type { ProductServices } from '../services.ts';
import type { MirroringControl } from '../../../features/mirroring-streaming/index.ts';
import type { DeviceRef } from '../../../plugin-sdk/index.ts';

export function MediaPage({services}: {services: ProductServices}) {
  const device = useSnapshot(services.runtime.devices);
  const live = services.runtime.mirroringStreaming;
  const snapshot = useSnapshot(live);
  const action = useAction(); const reader = useAction(); const recording = useAction();
  const [duration, setDuration] = useState('10000'); const [size, setSize] = useState('1280'); const [fps, setFps] = useState('30');
  const [audio, setAudio] = useState(false); const [control, setControl] = useState(false);
  const [text, setText] = useState(''); const [sessionId, setSessionId] = useState('');
  const [image, setImage] = useState<Blob | null>(null); const [movie, setMovie] = useState<Blob | null>(null);
  const [imageName, setImageName] = useState('screenshot.png');
  const [source, setSource] = useState('');
  const [liveReference, setLiveReference] = useState<DeviceRef | null>(null);
  const [imageSource, setImageSource] = useState(''); const [movieSource, setMovieSource] = useState('');
  const [controlError, setControlError] = useState<unknown>(null);
  const controls = useRef<ReturnType<typeof createMediaControlQueue> | null>(null);
  useEffect(() => {
    const queue = createMediaControlQueue({identity: () => {const view = live.snapshot(); return `${view.session?.id ?? ''}:${view.epoch}:${view.inputState}`;}, send: live.sendControl, failed: setControlError});
    controls.current = queue;
    return () => {queue.dispose(); controls.current = null;};
  }, [live]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const imageUrl = useBlobUrl(image); const movieUrl = useBlobUrl(movie);
  const provider = device.providers.find(item => item.id === device.selection?.providerId && item.generation === device.selection.generation);
  const screenshotCapability = provider?.definition.capabilities.find(item => item.id === 'screenshot' && item.version === 1 && item.scope === 'device');
  const canScreenshot = Boolean(device.selected?.state === 'online' && screenshotCapability && device.selected.capabilities.some(item => item.id === screenshotCapability.id && item.version === screenshotCapability.version && item.available));
  const androidTarget = Boolean(device.selected?.state === 'online' && provider?.definition.capabilities.some(item => item.operation.startsWith('plugin.android-device.')));
  const canRecord = useOperationAvailable(services, 'plugin.mirroring.record');
  const liveAvailable = snapshot.definitions?.sessions.some(item => item.id === 'plugin.mirroring.open') ?? false;
  const activeSession = snapshot.session && snapshot.session.status !== 'finished';
  const controlReady = control && liveReference !== null && JSON.stringify(liveReference) === JSON.stringify(device.selection) && device.selected?.state === 'online' && snapshot.status?.state === 'streaming' && snapshot.inputState === 'writable' && snapshot.session?.status === 'running';
  const send = (value: MirroringControl) => {setControlError(null); controls.current?.enqueue([value]);};
  function pointer(event: PointerEvent<HTMLCanvasElement>, type: 'down' | 'move' | 'up') {
    if (!controlReady || !snapshot.video || type === 'move' && !event.buttons) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (type === 'down') event.currentTarget.setPointerCapture(event.pointerId);
    const width = snapshot.video.width; const height = snapshot.video.height;
    void send({type: 'touch', action: type, pointer_id: event.pointerId, width, height,
      x: Math.min(width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * width / rect.width))),
      y: Math.min(height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * height / rect.height))), pressure: type === 'up' ? 0 : 1});
  }
  const key = (keycode: number) => {setControlError(null); controls.current?.enqueue([{type: 'key', action: 'down', keycode}, {type: 'key', action: 'up', keycode}]);};
  return <section className="product-page"><PageTitle eyebrow="WORKSHOP / SCREEN" title="画面与录制" description="看清当前设备，保留真正需要的画面。截图、实时投屏与录像分别管理。"><Button disabled={!canScreenshot || action.pending} onClick={() => void action.run(signal => withSelectedDevice(services, signal, async (reference, active) => {
    if (!screenshotCapability) throw new Error('当前设备不支持截图');
    const runner = createJobRunner({submit: (_, __, requestSignal) => services.runtime.devices.invoke({providerId: reference.providerId, generation: reference.generation, deviceId: reference.localId, capability: screenshotCapability.id, version: screenshotCapability.version, input: {}}, requestSignal), getJob: services.runtime.tasks.get, cancelJob: services.runtime.tasks.cancel});
    try {
      const result = await runner.execute(screenshotCapability.operation, {}, active, (value, logId) => decodeArtifactEnvelope(value, '设备截图', logId));
      const artifact = result.data.artifacts.find(item => item.media_type === 'image/png' || item.media_type === 'image/jpeg');
      if (!artifact) throw new Error('截图任务没有发布 PNG 或 JPEG 画面');
      const downloaded = await downloadPublishedArtifact(services.runtime.artifacts, result.data, artifact.filename, active);
      if (!active.aborted) { setImage(downloaded.data); setImageName(artifact.filename); setImageSource(reference.localId); }
      return result;
    } finally { runner.dispose(); }
  }))}><Camera />截取画面</Button></PageTitle>
    {!device.selection && <EmptyState title="选择一台设备开始" description="顶部选择工作对象。截图按当前设备能力开放，投屏和录像还需要服务端投屏插件。" />}
    <div className="form-row"><Field label="最大画面尺寸" value={size} onChange={setSize} type="number" min={256} max={8192} /><Field label="帧率上限" value={fps} onChange={setFps} type="number" min={1} max={240} /><div className="setting-toggle"><Switch id="media-audio" checked={audio} onCheckedChange={setAudio} disabled={Boolean(activeSession)} /><Label htmlFor="media-audio">播放设备音频</Label></div><div className="setting-toggle"><Switch id="media-control" checked={control} onCheckedChange={setControl} disabled={Boolean(activeSession)} /><Label htmlFor="media-control">开启设备控制</Label></div></div>
    <div className="action-row"><Button variant="outline" disabled={action.pending} onClick={() => void action.run(signal => live.refreshDefinitions(signal))}>检查直播能力</Button><Button disabled={!androidTarget || !liveAvailable || Boolean(activeSession) || reader.pending} onClick={() => void reader.run(signal => withSelectedDevice(services, signal, async (reference, active) => {
      await services.mediaDisplay.prepare(audio); services.mediaDisplay.bind(canvas.current);
      await live.open({device_id: reference.localId, max_size: Number(size), max_fps: Number(fps), audio, control}, active);
      setSource(reference.localId); setLiveReference(reference); return live.pollOutput({limit: 100}, active);
    }))}><Play />开始投屏</Button><Button variant="outline" disabled={!activeSession || reader.pending} onClick={() => void reader.run(signal => live.pollOutput({limit: 100}, signal))}>继续读取</Button><Button variant="ghost" disabled={!reader.pending} onClick={reader.cancel}>暂停读取</Button><Button variant="destructive" disabled={!activeSession || action.pending} onClick={() => void action.run(signal => live.cancel(signal))}><Square />停止直播</Button></div>
    <div className="media-stage"><canvas ref={target => { canvas.current = target; services.mediaDisplay.bind(target); }} aria-label="设备实时投屏画面" role="img" className={controlReady ? 'media-canvas is-interactive' : 'media-canvas'} onPointerDown={event => pointer(event, 'down')} onPointerMove={event => pointer(event, 'move')} onPointerUp={event => pointer(event, 'up')} onPointerCancel={event => pointer(event, 'up')} />{!snapshot.video && <EmptyState title="等待真实直播画面" description="先检查直播能力，再开始投屏。浏览器通过 WebCodecs 解码服务端媒体流。" />}</div>
    <p className="muted">来源：{source || '尚无画面'} · {snapshot.status?.state ?? '尚未连接'} · 代次 {snapshot.epoch} · {snapshot.video ? `${snapshot.video.width} × ${snapshot.video.height}` : '尺寸待返回'} · 已交付 {snapshot.packets} 个媒体包</p>
    <ErrorNotice error={services.mediaDisplay.error()} /><ErrorNotice error={controlError} /><ActionFeedback {...reader} />
    {control && <div className="action-row"><Button variant="outline" disabled={!controlReady || action.pending} onClick={() => void key(4)}>返回</Button><Button variant="outline" disabled={!controlReady || action.pending} onClick={() => void key(3)}>主屏幕</Button><Button variant="outline" disabled={!controlReady || action.pending} onClick={() => void send({type: 'rotate'})}>旋转</Button><Field label="设备输入文本" value={text} onChange={setText} /><Button disabled={!controlReady || !text || action.pending} onClick={() => void send({type: 'text', text})}>发送文本</Button><Button variant="ghost" disabled={!activeSession || snapshot.inputState === 'eof'} onClick={() => void action.run(signal => live.eof(signal))}>关闭控制输入</Button></div>}
    <details><summary>恢复已知直播会话</summary><div className="form-row"><Field label="直播会话 ID" value={sessionId} onChange={setSessionId} /><Button variant="outline" disabled={!sessionId || action.pending} onClick={() => void action.run(async signal => { await services.mediaDisplay.prepare(audio); const sameSession = live.snapshot().session?.id === sessionId; const result = await live.resume(sessionId, signal); if (!signal.aborted && !sameSession) {setLiveReference(null); setSource(`恢复会话 ${sessionId}`);} return result; })}>恢复画面读取位置</Button></div><p className="muted">恢复其它会话时控制入口关闭。暂停读取不停止服务；帧交付撤销后可能需要重新打开直播。</p></details>
    <section className="settings-group"><div className="section-heading"><h2>有界录像</h2><Button variant="ghost" disabled={recording.pending} onClick={() => void recording.run(async signal => { await services.mirroring.refreshOperations(signal); return services.mirroring.runtimeStatus(signal); })}>检查录像工具</Button></div><div className="form-row"><Field label="录制时长（毫秒）" value={duration} onChange={setDuration} type="number" min={1000} max={120000} /><Button disabled={!androidTarget || !canRecord || recording.pending} onClick={() => void recording.run(signal => withSelectedDevice(services, signal, async (reference, active) => {
      await services.mirroring.refreshOperations(active);
      const result = await services.mirroring.record({device_id: reference.localId, duration_ms: Number(duration), max_size: Number(size), max_fps: Number(fps)}, active);
      const downloaded = await services.mirroring.downloadRecording(result.data, active);
      if (!active.aborted) {setMovie(downloaded.data); setMovieSource(reference.localId);} return result;
    }))}>录制并下载 MP4</Button></div><p className="muted">服务器录像不包含音频和交互控制。取消等待后可在任务页查询原任务，避免重复录制。</p>{movieUrl && <><p className="muted">录像来源：{movieSource}</p><video src={movieUrl} controls preload="metadata" aria-label="设备录像预览" className="recording-preview" /><Button variant="outline" asChild><a href={movieUrl} download="screen.mp4"><Download />下载录像</a></Button></>}<ActionFeedback {...recording} /><JsonResult value={recording.result} /></section>
    {imageUrl && <section className="settings-group"><h2>最近截图 · {imageSource}</h2><img src={imageUrl} alt="设备截图预览" className="screenshot-preview" /><Button variant="outline" asChild><a href={imageUrl} download={imageName}><Download />下载原始截图</a></Button></section>}
    <ActionFeedback {...action} /><JsonResult value={action.result} />
  </section>;
}
